// Atomic inbound webhook handling. A delivery receipt and its local state change happen in the
// same Convex transaction so a retry cannot be acknowledged before the order is recorded.
import { mutation } from "./authz";
import { v } from "convex/values";
import { appendAudit } from "./audit";
import { webhookDeliveryDecision, cjTrackingMappingDecision, shopifyReceiptDecision, shopifyStagingIntakeDecision } from "../src/lib/webhookReceiptState";
import { cjStagingInputDigest } from "../src/lib/cjOrder";

const fulfillmentStatus = v.union(
  v.literal("received"), v.literal("sent_to_cj"), v.literal("shipped"), v.literal("delivered"), v.literal("error"),
);

const RANK = { received: 0, sent_to_cj: 1, shipped: 2, delivered: 3, error: 0 } as const;
type FulfillmentStatus = keyof typeof RANK;

async function requireServiceIdentity(ctx: { auth: { getUserIdentity: () => Promise<{ subject?: string } | null> } }) {
  if ((await ctx.auth.getUserIdentity())?.subject !== "dropship-ai:service") throw new Error("UNAUTHENTICATED: webhook intake requires the service runtime");
}

export const recordShopifyOrder = mutation({
  args: {
    siteId: v.id("sites"), deliveryId: v.string(), topic: v.string(), payloadHash: v.string(),
    shopifyOrderId: v.string(), totalUsd: v.number(), fulfillmentStatus, createdAt: v.number(),
    stagingInput: v.optional(v.object({
      shipping: v.object({ shippingZip: v.string(), shippingCountryCode: v.string(), shippingCountry: v.string(), shippingProvince: v.string(), shippingCity: v.string(), shippingAddress: v.string(), shippingCustomerName: v.string(), shippingPhone: v.string() }),
      shopifyLines: v.array(v.object({ productId: v.string(), variantId: v.string(), quantity: v.number() })),
    })),
  },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const prior = await ctx.db.query("webhookReceipts")
      .withIndex("by_provider_site_delivery", (q) => q.eq("provider", "shopify").eq("siteId", args.siteId).eq("deliveryId", args.deliveryId)).first();
    const receiptDecision = shopifyReceiptDecision(prior, args);
    if (receiptDecision === "reject_changed") throw new Error("Shopify delivery ID was replayed with a changed payload");
    if (receiptDecision === "duplicate") {
      // A provider delivery ID is immutable. Accepting changed content could bind an existing
      // approval to another address or line set, so this must fail closed rather than retry.
      let intent = prior!.cjStagingIntentId
        ? await ctx.db.get(prior!.cjStagingIntentId)
        : await ctx.db.query("cjStagingIntents").withIndex("by_site_delivery", (q) => q.eq("siteId", args.siteId).eq("deliveryId", args.deliveryId)).first();
      // Pre-link receipts from the first rollout did not carry an intent ID. A semantically
      // identical second Shopify delivery therefore cannot rely on delivery ID alone: resolve
      // through this request's exact site/order, verify the durable input binding, then repair
      // the receipt in the same transaction so all later replays have the direct lineage.
      if (!intent && args.stagingInput) {
        const order = await ctx.db.query("orders").withIndex("by_shopify_order", (q) => q.eq("shopifyOrderId", args.shopifyOrderId)).first();
        if (order?.siteId === args.siteId) {
          const candidate = await ctx.db.query("cjStagingIntents").withIndex("by_order", (q) => q.eq("orderId", order._id)).first();
          const incomingDigest = cjStagingInputDigest(args.stagingInput);
          const candidateDigest = candidate?.stagingInputDigest ?? (candidate ? cjStagingInputDigest({ shipping: candidate.shipping, shopifyLines: candidate.shopifyLines }) : undefined);
          if (candidate && candidate.siteId === args.siteId && candidate.orderId === order._id && candidateDigest === incomingDigest) {
            intent = candidate;
            await ctx.db.patch(prior!._id, { cjStagingIntentId: candidate._id });
          }
        }
      }
      if (intent && !prior!.cjStagingIntentId && intent.siteId === args.siteId) {
        await ctx.db.patch(prior!._id, { cjStagingIntentId: intent._id });
      }
      return { duplicate: true, outcome: prior!.outcome, intentId: intent?._id ?? null };
    }

    const existing = await ctx.db.query("orders")
      .withIndex("by_shopify_order", (q) => q.eq("shopifyOrderId", args.shopifyOrderId)).first();
    let orderId: any;
    if (existing) {
      if (existing.siteId !== args.siteId) throw new Error("Shopify order belongs to another site");
      const next = RANK[args.fulfillmentStatus] > RANK[existing.fulfillmentStatus as FulfillmentStatus]
        ? args.fulfillmentStatus : existing.fulfillmentStatus;
      await ctx.db.patch(existing._id, { totalUsd: args.totalUsd, fulfillmentStatus: next, sample: false });
      orderId = existing._id;
    } else {
      orderId = await ctx.db.insert("orders", {
        siteId: args.siteId, shopifyOrderId: args.shopifyOrderId, totalUsd: args.totalUsd,
        fulfillmentStatus: args.fulfillmentStatus, createdAt: args.createdAt, sample: false,
      });
      await appendAudit(ctx, { siteId: args.siteId, event: "order_received", detail: { shopifyOrderId: args.shopifyOrderId, source: "shopify_webhook" } });
    }
    let intentId: any = null;
    let intentNeedsAttention = false;
    if (args.stagingInput) {
      // Deterministic on the mirrored order, not merely delivery ID: Shopify can redeliver a
      // semantically identical create as a distinct delivery and it still gets one CJ intent.
      const existingIntent = await ctx.db.query("cjStagingIntents").withIndex("by_order", (q) => q.eq("orderId", orderId)).first();
      const stagingInputDigest = cjStagingInputDigest(args.stagingInput);
      if (existingIntent) {
        if (shopifyStagingIntakeDecision({ incoming: { payloadHash: args.payloadHash, topic: args.topic }, existingStagingDigest: existingIntent.stagingInputDigest, incomingStagingDigest: stagingInputDigest }) === "needs_attention") {
          // A distinct delivery cannot silently attach an old approval to a new address/line set.
          await ctx.db.patch(existingIntent._id, { status: "needs_attention", runnableAt: undefined, leaseExpiresAt: undefined, lastError: { code: "shopify_staging_semantics_changed" }, updatedAt: Date.now() });
          await appendAudit(ctx, { siteId: args.siteId, event: "cj_staging_needs_attention", detail: { orderId, reason: "shopify_staging_semantics_changed" } });
          intentNeedsAttention = true;
        }
        intentId = existingIntent._id;
      } else {
        const now = Date.now();
        intentId = await ctx.db.insert("cjStagingIntents", {
          siteId: args.siteId, orderId, deliveryId: args.deliveryId, payloadHash: args.payloadHash,
          status: "pending", attempt: 0, runnableAt: now, stagingInputDigest, shipping: args.stagingInput.shipping,
          shopifyLines: args.stagingInput.shopifyLines, createdAt: now, updatedAt: now,
        });
      }
    }
    await ctx.db.insert("webhookReceipts", {
      provider: "shopify", deliveryId: args.deliveryId, topic: args.topic, siteId: args.siteId,
      payloadHash: args.payloadHash, outcome: "applied", cjStagingIntentId: intentId ?? undefined, receivedAt: Date.now(),
    });
    // `applied` means intake/mirroring completed, never that CJ quote, staging, or approval did.
    return { duplicate: false, outcome: "applied" as const, intentId, intentNeedsAttention };
  },
});

export const recordCjTracking = mutation({
  args: {
    siteId: v.id("sites"), deliveryId: v.string(), topic: v.string(), payloadHash: v.string(),
    cjOrderNumber: v.string(), trackingNumber: v.optional(v.string()), trackingUrl: v.optional(v.string()), cjOrderId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const prior = await ctx.db.query("webhookReceipts")
      .withIndex("by_provider_site_delivery", (q) => q.eq("provider", "cj").eq("siteId", args.siteId).eq("deliveryId", args.deliveryId)).first();
    if (webhookDeliveryDecision(prior) === "duplicate") return { duplicate: true, outcome: prior!.outcome };

    const order = await ctx.db.query("orders")
      .withIndex("by_cj_order_number", (q) => q.eq("cjOrderNumber", args.cjOrderNumber)).first();
    if (cjTrackingMappingDecision({ order, siteId: args.siteId, incomingCjOrderId: args.cjOrderId }) === "ignore") {
      await ctx.db.insert("webhookReceipts", {
        provider: "cj", deliveryId: args.deliveryId, topic: args.topic, siteId: args.siteId,
        payloadHash: args.payloadHash, outcome: "ignored", receivedAt: Date.now(),
      });
      return { duplicate: false, outcome: "ignored" as const };
    }
    // The reducer above rejects null orders; retain this explicit guard for TypeScript and future
    // changes to the decision table.
    if (!order) throw new Error("CJ webhook mapping unexpectedly lost its persisted order");
    await ctx.db.patch(order._id, {
      trackingNumber: args.trackingNumber ?? order.trackingNumber,
      trackingUrl: args.trackingUrl ?? order.trackingUrl,
      cjOrderId: args.cjOrderId ?? order.cjOrderId,
      fulfillmentStatus: args.trackingNumber ? "shipped" : order.fulfillmentStatus,
    });
    await appendAudit(ctx, { siteId: args.siteId, event: "order_tracking_applied", detail: { orderId: order._id, trackingNumber: args.trackingNumber, source: "cj_webhook" } });
    await ctx.db.insert("webhookReceipts", {
      provider: "cj", deliveryId: args.deliveryId, topic: args.topic, siteId: args.siteId,
      payloadHash: args.payloadHash, outcome: "applied", receivedAt: Date.now(),
    });
    return { duplicate: false, outcome: "applied" as const };
  },
});
