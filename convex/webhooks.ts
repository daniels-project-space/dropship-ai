// Atomic inbound webhook handling. A delivery receipt and its local state change happen in the
// same Convex transaction so a retry cannot be acknowledged before the order is recorded.
import { mutation } from "./authz";
import { v } from "convex/values";
import { appendAudit } from "./audit";
import { webhookDeliveryDecision, cjTrackingMappingDecision, shopifyReceiptDecision, shopifyStagingIntakeDecision } from "../src/lib/webhookReceiptState";
import { cjStagingInputDigest } from "../src/lib/cjOrder";
import { eligibleUsdOrder } from "../src/lib/shopifyOrder";

const fulfillmentStatus = v.union(
  v.literal("received"), v.literal("sent_to_cj"), v.literal("shipped"), v.literal("delivered"), v.literal("error"),
);
const creditAdjustmentState = v.union(v.literal("none"), v.literal("partial"), v.literal("full"));

const RANK = { received: 0, sent_to_cj: 1, shipped: 2, delivered: 3, error: 0 } as const;
type FulfillmentStatus = keyof typeof RANK;
type EconomicField = "currencyCode" | "currentTotal" | "financialStatus" | "test" | "cancelled" | "creditAdjustmentState";
const ECONOMIC_FIELDS: EconomicField[] = ["currencyCode", "currentTotal", "financialStatus", "test", "cancelled", "creditAdjustmentState"];

function economicFieldObservationTimes(
  args: Partial<Record<EconomicField, unknown>>,
  observedAt: number,
  prior: Partial<Record<EconomicField, number>> = {},
) {
  const times = { ...prior };
  for (const field of ECONOMIC_FIELDS) if (args[field] !== undefined) times[field] = observedAt;
  return times;
}

async function requireServiceIdentity(ctx: { auth: { getUserIdentity: () => Promise<{ subject?: string } | null> } }) {
  if ((await ctx.auth.getUserIdentity())?.subject !== "dropship-ai:service") throw new Error("UNAUTHENTICATED: webhook intake requires the service runtime");
}

export const recordShopifyOrder = mutation({
  args: {
    siteId: v.id("sites"), deliveryId: v.string(), topic: v.string(), payloadHash: v.string(),
    shopifyOrderId: v.string(), fulfillmentStatus, createdAt: v.number(),
    currencyCode: v.optional(v.string()), currentTotal: v.optional(v.number()), financialStatus: v.optional(v.string()),
    test: v.optional(v.boolean()), cancelled: v.optional(v.boolean()), creditAdjustmentState: v.optional(creditAdjustmentState),
    stagingInput: v.optional(v.object({
      shipping: v.object({ shippingZip: v.string(), shippingCountryCode: v.string(), shippingCountry: v.string(), shippingProvince: v.string(), shippingCity: v.string(), shippingAddress: v.string(), shippingCustomerName: v.string(), shippingPhone: v.string() }),
      shopifyLines: v.array(v.object({ productId: v.string(), variantId: v.string(), quantity: v.number() })),
    })),
  },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const observedAt = Date.now();
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
        const order = await ctx.db.query("orders").withIndex("by_site_shopify_order", (q) => q.eq("siteId", args.siteId).eq("shopifyOrderId", args.shopifyOrderId)).first();
        if (order) {
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
      .withIndex("by_site_shopify_order", (q) => q.eq("siteId", args.siteId).eq("shopifyOrderId", args.shopifyOrderId)).first();
    let orderId: any;
    if (existing) {
      const next = RANK[args.fulfillmentStatus] > RANK[existing.fulfillmentStatus as FulfillmentStatus]
        ? args.fulfillmentStatus : existing.fulfillmentStatus;
      const patch: Record<string, unknown> = {
        fulfillmentStatus: next, sample: false, shopifyObservedAt: observedAt,
        shopifyEconomicsSnapshotAttemptId: undefined, shopifyEconomicsExcludedAt: observedAt,
        shopifyEconomicFieldObservedAt: economicFieldObservationTimes(args, observedAt, existing.shopifyEconomicFieldObservedAt),
      };
      for (const key of ["currencyCode", "currentTotal", "financialStatus", "test", "cancelled", "creditAdjustmentState"] as const) {
        if (args[key] !== undefined) patch[key] = args[key];
      }
      if (args.currentTotal !== undefined && (args.currencyCode ?? existing.currencyCode) === "USD") patch.totalUsd = args.currentTotal;
      await ctx.db.patch(existing._id, patch);
      orderId = existing._id;
    } else {
      orderId = await ctx.db.insert("orders", {
        siteId: args.siteId, shopifyOrderId: args.shopifyOrderId,
        currencyCode: args.currencyCode, currentTotal: args.currentTotal,
        financialStatus: args.financialStatus, test: args.test, cancelled: args.cancelled,
        creditAdjustmentState: args.creditAdjustmentState,
        totalUsd: args.currencyCode === "USD" ? args.currentTotal : undefined,
        fulfillmentStatus: args.fulfillmentStatus, createdAt: args.createdAt, sample: false,
        shopifyObservedAt: observedAt, shopifyEconomicsExcludedAt: observedAt,
        shopifyEconomicFieldObservedAt: economicFieldObservationTimes(args, observedAt),
      });
      await appendAudit(ctx, { siteId: args.siteId, event: "order_received", detail: { source: "shopify_webhook" } });
    }
    let intentId: any = null;
    let intentNeedsAttention = false;
    const storedOrder = await ctx.db.get(orderId) as any;
    const site = await ctx.db.get(args.siteId);
    if (site?.shopifyEconomicsSyncStatus === "current") {
      // A post-snapshot provider fact is retained, but launch economics wait for a new complete
      // snapshot generation before including it.
      await ctx.db.patch(args.siteId, { shopifyEconomicsSyncStatus: "incomplete" });
    }
    const economicallyEligible = !!storedOrder && !!site && eligibleUsdOrder(storedOrder, site.storeCurrency);
    if (args.stagingInput && economicallyEligible) {
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
    if (!economicallyEligible) {
      const existingIntent = await ctx.db.query("cjStagingIntents").withIndex("by_order", (q) => q.eq("orderId", orderId)).first();
      if (existingIntent && existingIntent.status !== "approval_resolved" && existingIntent.status !== "needs_attention") {
        await ctx.db.patch(existingIntent._id, { status: "needs_attention", runnableAt: undefined, leaseExpiresAt: undefined, lastError: { code: "shopify_order_not_economically_eligible" }, updatedAt: Date.now() });
        intentId = existingIntent._id;
        intentNeedsAttention = true;
      }
    }
    await ctx.db.insert("webhookReceipts", {
      provider: "shopify", deliveryId: args.deliveryId, topic: args.topic, siteId: args.siteId,
      payloadHash: args.payloadHash, outcome: "applied", cjStagingIntentId: intentId ?? undefined, receivedAt: observedAt,
    });
    // `applied` means intake/mirroring completed, never that CJ quote, staging, or approval did.
    return { duplicate: false, outcome: "applied" as const, intentId, intentNeedsAttention };
  },
});

export const recordCjTracking = mutation({
  args: {
    deliveryId: v.string(), topic: v.string(), payloadHash: v.string(),
    cjOrderNumber: v.string(), trackingNumber: v.optional(v.string()), trackingUrl: v.optional(v.string()), cjOrderId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    if (!/^dsa-sb-[a-f0-9]{32}$/.test(args.cjOrderNumber)) {
      return { duplicate: false, outcome: "ignored" as const, reason: "unknown_route" as const };
    }
    const routes = await ctx.db.query("orders")
      .withIndex("by_cj_webhook_order_number", (q) => q.eq("cjOrderNumber", args.cjOrderNumber)).take(2);
    if (routes.length !== 1) {
      return { duplicate: false, outcome: "ignored" as const, reason: routes.length ? "ambiguous_route" as const : "unknown_route" as const };
    }
    const order = routes[0];
    const siteId = order.siteId;
    const receipts = await ctx.db.query("webhookReceipts")
      .withIndex("by_provider_delivery", (q) => q.eq("provider", "cj").eq("deliveryId", args.deliveryId)).take(2);
    if (receipts.length > 1) return { duplicate: false, outcome: "ignored" as const, reason: "ambiguous_delivery" as const };
    const prior = receipts[0];
    if (webhookDeliveryDecision(prior) === "duplicate") {
      if (prior!.payloadHash !== args.payloadHash || prior!.topic !== args.topic) throw new Error("CJ messageId was replayed with changed content");
      return { duplicate: true, outcome: prior!.outcome };
    }

    if (cjTrackingMappingDecision({ order, siteId, incomingCjOrderId: args.cjOrderId }) === "ignore") {
      await ctx.db.insert("webhookReceipts", {
        provider: "cj", deliveryId: args.deliveryId, topic: args.topic, siteId,
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
    await appendAudit(ctx, { siteId, event: "order_tracking_applied", detail: { orderId: order._id, source: "cj_webhook" } });
    await ctx.db.insert("webhookReceipts", {
      provider: "cj", deliveryId: args.deliveryId, topic: args.topic, siteId,
      payloadHash: args.payloadHash, outcome: "applied", receivedAt: Date.now(),
    });
    return { duplicate: false, outcome: "applied" as const };
  },
});
