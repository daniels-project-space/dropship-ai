// Atomic inbound webhook handling. A delivery receipt and its local state change happen in the
// same Convex transaction so a retry cannot be acknowledged before the order is recorded.
import { mutation } from "./authz";
import { v } from "convex/values";
import { appendAudit } from "./audit";
import { webhookDeliveryDecision, cjTrackingMappingDecision } from "../src/lib/webhookReceiptState";

const fulfillmentStatus = v.union(
  v.literal("received"), v.literal("sent_to_cj"), v.literal("shipped"), v.literal("delivered"), v.literal("error"),
);

const RANK = { received: 0, sent_to_cj: 1, shipped: 2, delivered: 3, error: 0 } as const;
type FulfillmentStatus = keyof typeof RANK;

export const recordShopifyOrder = mutation({
  args: {
    siteId: v.id("sites"), deliveryId: v.string(), topic: v.string(), payloadHash: v.string(),
    shopifyOrderId: v.string(), totalUsd: v.number(), fulfillmentStatus, createdAt: v.number(),
  },
  handler: async (ctx, args) => {
    const prior = await ctx.db.query("webhookReceipts")
      .withIndex("by_provider_site_delivery", (q) => q.eq("provider", "shopify").eq("siteId", args.siteId).eq("deliveryId", args.deliveryId)).first();
    if (webhookDeliveryDecision(prior) === "duplicate") return { duplicate: true, outcome: prior!.outcome };

    const existing = await ctx.db.query("orders")
      .withIndex("by_shopify_order", (q) => q.eq("shopifyOrderId", args.shopifyOrderId)).first();
    if (existing) {
      const next = RANK[args.fulfillmentStatus] > RANK[existing.fulfillmentStatus as FulfillmentStatus]
        ? args.fulfillmentStatus : existing.fulfillmentStatus;
      await ctx.db.patch(existing._id, { totalUsd: args.totalUsd, fulfillmentStatus: next, sample: false });
    } else {
      await ctx.db.insert("orders", {
        siteId: args.siteId, shopifyOrderId: args.shopifyOrderId, totalUsd: args.totalUsd,
        fulfillmentStatus: args.fulfillmentStatus, createdAt: args.createdAt, sample: false,
      });
      await appendAudit(ctx, { siteId: args.siteId, event: "order_received", detail: { shopifyOrderId: args.shopifyOrderId, source: "shopify_webhook" } });
    }
    await ctx.db.insert("webhookReceipts", {
      provider: "shopify", deliveryId: args.deliveryId, topic: args.topic, siteId: args.siteId,
      payloadHash: args.payloadHash, outcome: "applied", receivedAt: Date.now(),
    });
    return { duplicate: false, outcome: "applied" as const };
  },
});

export const recordCjTracking = mutation({
  args: {
    siteId: v.id("sites"), deliveryId: v.string(), topic: v.string(), payloadHash: v.string(),
    cjOrderNumber: v.string(), trackingNumber: v.optional(v.string()), trackingUrl: v.optional(v.string()), cjOrderId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
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
