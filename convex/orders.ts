// Orders + CJ fulfillment loop. Index-driven reads only.
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { appendAudit } from "./audit";

const fulfillmentStatus = v.union(
  v.literal("received"),
  v.literal("sent_to_cj"),
  v.literal("shipped"),
  v.literal("delivered"),
  v.literal("error"),
);

// Map a Shopify displayFulfillmentStatus → our fulfillment enum. We DON'T touch sent_to_cj here
// (that's set by the CJ loop in Phase 2b) — a Shopify-side FULFILLED maps straight to "shipped".
type ShopFulfillment = "received" | "sent_to_cj" | "shipped" | "delivered" | "error";
export function mapShopifyFulfillment(displayStatus: string | null | undefined): ShopFulfillment {
  switch ((displayStatus ?? "").toUpperCase()) {
    case "FULFILLED":
      return "shipped";
    case "PARTIALLY_FULFILLED":
    case "IN_PROGRESS":
    case "PENDING_FULFILLMENT":
    case "OPEN":
    case "SCHEDULED":
    case "ON_HOLD":
    case "UNFULFILLED":
    case "RESTOCKED":
    default:
      return "received";
  }
}

// Bulk idempotent upsert of REAL Shopify orders (keyed on shopifyOrderId). Used by the initial
// sync + manual "Sync now". Writes sample:false. Does NOT trigger any CJ/fulfillment action — it
// only mirrors Shopify state. fulfillmentStatus is mapped from Shopify's displayFulfillmentStatus
// but an existing order already advanced past Shopify's view (e.g. sent_to_cj/delivered) is NOT
// downgraded.
const ADVANCED_ORDER: Record<ShopFulfillment, number> = {
  received: 0,
  sent_to_cj: 1,
  shipped: 2,
  delivered: 3,
  error: 0,
};
export const upsertFromShopify = mutation({
  args: {
    siteId: v.id("sites"),
    orders: v.array(
      v.object({
        shopifyOrderId: v.string(),
        totalUsd: v.number(),
        fulfillmentStatus: fulfillmentStatus,
        createdAt: v.number(),
      }),
    ),
  },
  handler: async (ctx, { siteId, orders }) => {
    let inserted = 0;
    let updated = 0;
    for (const o of orders) {
      const existing = await ctx.db
        .query("orders")
        .withIndex("by_shopify_order", (q) => q.eq("shopifyOrderId", o.shopifyOrderId))
        .first();
      if (existing) {
        // never downgrade an order the fulfillment loop has already advanced
        const nextStatus =
          ADVANCED_ORDER[o.fulfillmentStatus] > ADVANCED_ORDER[existing.fulfillmentStatus]
            ? o.fulfillmentStatus
            : existing.fulfillmentStatus;
        await ctx.db.patch(existing._id, {
          totalUsd: o.totalUsd,
          fulfillmentStatus: nextStatus,
          sample: false,
        });
        updated++;
      } else {
        await ctx.db.insert("orders", {
          siteId,
          shopifyOrderId: o.shopifyOrderId,
          fulfillmentStatus: o.fulfillmentStatus,
          totalUsd: o.totalUsd,
          createdAt: o.createdAt,
          sample: false,
        });
        inserted++;
      }
    }
    return { inserted, updated, total: orders.length };
  },
});

// Record a freshly received Shopify order (idempotent on shopifyOrderId).
export const record = mutation({
  args: {
    siteId: v.id("sites"),
    shopifyOrderId: v.string(),
    totalUsd: v.number(),
    cjOrderId: v.optional(v.string()),
    fulfillmentStatus: v.optional(fulfillmentStatus),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("orders")
      .withIndex("by_shopify_order", (q) => q.eq("shopifyOrderId", args.shopifyOrderId))
      .first();
    if (existing) {
      const patch: Record<string, unknown> = {};
      if (args.cjOrderId) patch.cjOrderId = args.cjOrderId;
      if (args.fulfillmentStatus) patch.fulfillmentStatus = args.fulfillmentStatus;
      if (Object.keys(patch).length) await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    const orderId = await ctx.db.insert("orders", {
      siteId: args.siteId,
      shopifyOrderId: args.shopifyOrderId,
      cjOrderId: args.cjOrderId,
      fulfillmentStatus: args.fulfillmentStatus ?? "received",
      totalUsd: args.totalUsd,
      createdAt: Date.now(),
    });
    await appendAudit(ctx, { siteId: args.siteId, event: "order_received", detail: { orderId, shopifyOrderId: args.shopifyOrderId } });
    return orderId;
  },
});

// Mark an order as dispatched to CJ (after cj.createOrder).
export const markSentToCj = mutation({
  args: { orderId: v.id("orders"), cjOrderId: v.string() },
  handler: async (ctx, { orderId, cjOrderId }) => {
    const order = await ctx.db.get(orderId);
    if (!order) throw new Error(`order ${orderId} not found`);
    await ctx.db.patch(orderId, { cjOrderId, fulfillmentStatus: "sent_to_cj" });
    await appendAudit(ctx, { siteId: order.siteId, event: "order_sent_to_cj", detail: { orderId, cjOrderId } });
    return orderId;
  },
});

// Apply tracking from the CJ ORDER webhook. Keyed by shopifyOrderId (the orderNumber we sent CJ).
export const applyTracking = mutation({
  args: {
    shopifyOrderId: v.string(),
    trackingNumber: v.optional(v.string()),
    trackingUrl: v.optional(v.string()),
    cjOrderId: v.optional(v.string()),
    status: v.optional(fulfillmentStatus),
  },
  handler: async (ctx, args) => {
    const order = await ctx.db
      .query("orders")
      .withIndex("by_shopify_order", (q) => q.eq("shopifyOrderId", args.shopifyOrderId))
      .first();
    if (!order) throw new Error(`order for shopifyOrderId ${args.shopifyOrderId} not found`);
    await ctx.db.patch(order._id, {
      trackingNumber: args.trackingNumber ?? order.trackingNumber,
      trackingUrl: args.trackingUrl ?? order.trackingUrl,
      cjOrderId: args.cjOrderId ?? order.cjOrderId,
      fulfillmentStatus: args.status ?? "shipped",
    });
    await appendAudit(ctx, {
      siteId: order.siteId,
      event: "order_tracking_applied",
      detail: { orderId: order._id, trackingNumber: args.trackingNumber },
    });
    return order._id;
  },
});

export const getByShopifyOrder = query({
  args: { shopifyOrderId: v.string() },
  handler: async (ctx, { shopifyOrderId }) => {
    return ctx.db
      .query("orders")
      .withIndex("by_shopify_order", (q) => q.eq("shopifyOrderId", shopifyOrderId))
      .first();
  },
});

export const listBySite = query({
  args: { siteId: v.id("sites"), status: v.optional(fulfillmentStatus), limit: v.optional(v.number()) },
  handler: async (ctx, { siteId, status, limit }) => {
    if (status) {
      return ctx.db
        .query("orders")
        .withIndex("by_site_status", (q) => q.eq("siteId", siteId).eq("fulfillmentStatus", status))
        .order("desc")
        .take(limit ?? 200);
    }
    return ctx.db
      .query("orders")
      .withIndex("by_site", (q) => q.eq("siteId", siteId))
      .order("desc")
      .take(limit ?? 200);
  },
});
