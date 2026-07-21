// Orders + CJ fulfillment loop. Index-driven reads only.
import { query, mutation } from "./authz";
import { v } from "convex/values";
import { appendAudit } from "./audit";
import { cjOrderInputHash, normalizeCjOrderInput, sandboxDispatchDecision, sandboxOrderNumber } from "../src/lib/cjOrder";
import { hasVerifiedShopifyCjLineage } from "../src/lib/orderLineageState";
import { hasValidSandboxCjApprovalBinding } from "../src/lib/sandboxCjBinding";

const fulfillmentStatus = v.union(
  v.literal("received"),
  v.literal("sent_to_cj"),
  v.literal("shipped"),
  v.literal("delivered"),
  v.literal("error"),
);
const cjDispatchStatus = v.union(v.literal("staged"), v.literal("reserved"), v.literal("ambiguous"), v.literal("sent"), v.literal("failed"));
const cjOrderInput = v.object({
  orderNumber: v.string(), shippingZip: v.string(), shippingCountryCode: v.string(), shippingCountry: v.string(),
  shippingProvince: v.string(), shippingCity: v.string(), shippingAddress: v.string(), shippingCustomerName: v.string(),
  shippingPhone: v.string(), logisticName: v.string(), fromCountryCode: v.string(),
  products: v.array(v.object({ vid: v.string(), quantity: v.number() })),
});
const shopifyLine = v.object({ productId: v.string(), variantId: v.string(), quantity: v.number() });
const shippingInput = v.object({
  shippingZip: v.string(), shippingCountryCode: v.string(), shippingCountry: v.string(), shippingProvince: v.string(),
  shippingCity: v.string(), shippingAddress: v.string(), shippingCustomerName: v.string(), shippingPhone: v.string(),
});
const logisticsPreflight = v.object({ logisticName: v.string(), fromCountryCode: v.string(), quotedAt: v.number(), quotedPriceUsd: v.number() });

async function requireServiceIdentity(ctx: { auth: { getUserIdentity: () => Promise<{ subject?: string } | null> } }): Promise<void> {
  if ((await ctx.auth.getUserIdentity())?.subject !== "dropship-ai:service") throw new Error("UNAUTHENTICATED: sandbox dispatch requires the service runtime");
}

type ShopifyLine = { productId: string; variantId: string; quantity: number };

/** Resolve signed Shopify product+variant IDs through this site's immutable DRAFT import mapping. */
async function resolvePersistedShopifyCjLineage(ctx: any, siteId: any, lines: ShopifyLine[]) {
  if (!lines.length) throw new Error("Shopify order has no lines eligible for CJ staging");
  const resolved: Array<{ productId: string; variantId: string; cjProductId: string; cjVariantId: string; cjEvidenceId: any; fromCountryCode: string; quantity: number }> = [];
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || !line.productId.startsWith("gid://shopify/Product/") || !line.variantId.startsWith("gid://shopify/ProductVariant/")) {
      throw new Error("Shopify order line identity is invalid");
    }
    const product = await ctx.db.query("products").withIndex("by_site", (q: any) => q.eq("siteId", siteId))
      .filter((q: any) => q.eq(q.field("shopifyProductId"), line.productId))
      .filter((q: any) => q.eq(q.field("shopifyVariantId"), line.variantId)).first();
    const evidence = product?.cjEvidenceId ? await ctx.db.get(product.cjEvidenceId) : null;
    if (!hasVerifiedShopifyCjLineage({ siteId, line, product, evidence })) {
      throw new Error("Shopify order line CJ evidence lineage is invalid");
    }
    resolved.push({ productId: line.productId, variantId: line.variantId, cjProductId: product.cjProductId, cjVariantId: product.cjVariantId, cjEvidenceId: product.cjEvidenceId, fromCountryCode: product.cjFromCountryCode, quantity: line.quantity });
  }
  const fromCountryCode = resolved[0].fromCountryCode;
  if (!/^[A-Z]{2}$/.test(fromCountryCode) || resolved.some((line) => line.fromCountryCode !== fromCountryCode)) {
    throw new Error("Shopify order has no single verified CJ origin; an operator must split or reconcile fulfillment");
  }
  return { fromCountryCode, lines: resolved };
}

/** Service-only, read-free mapping used by the webhook before the read-only CJ freight quote. */
export const resolveShopifyCjLineage = query({
  args: { siteId: v.id("sites"), lines: v.array(shopifyLine) },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    return resolvePersistedShopifyCjLineage(ctx, args.siteId, args.lines);
  },
});

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

/**
 * Persist an immutable CJ input snapshot and a deterministic orderNumber before creating the
 * human-gated sandbox-dispatch action. This is service-only: order PII never crosses a browser.
 */
export const stageSandboxCjDispatch = mutation({
  args: { siteId: v.id("sites"), shopifyOrderId: v.string(), totalUsd: v.number(), shipping: shippingInput, shopifyLines: v.array(shopifyLine), logistics: logisticsPreflight },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const lineage = await resolvePersistedShopifyCjLineage(ctx, args.siteId, args.shopifyLines);
    if (args.logistics.fromCountryCode !== lineage.fromCountryCode || !args.logistics.logisticName.trim() || !Number.isFinite(args.logistics.quotedAt) || !Number.isFinite(args.logistics.quotedPriceUsd) || args.logistics.quotedPriceUsd < 0) {
      throw new Error("CJ logistics preflight is missing, stale, or not bound to this order's verified source origin; operator action is required");
    }
    const orderNumber = sandboxOrderNumber(String(args.siteId), args.shopifyOrderId);
    const input = normalizeCjOrderInput({ orderNumber, ...args.shipping, logisticName: args.logistics.logisticName, fromCountryCode: args.logistics.fromCountryCode, products: lineage.lines.map((line) => ({ vid: line.cjVariantId, quantity: line.quantity })) }, orderNumber);
    const inputHash = cjOrderInputHash(input);
    let order = await ctx.db.query("orders").withIndex("by_shopify_order", (q) => q.eq("shopifyOrderId", args.shopifyOrderId)).first();
    if (order && order.siteId !== args.siteId) throw new Error("shopify order belongs to another site");
    if (order?.cjOrderInputHash && order.cjOrderInputHash !== inputHash) throw new Error("CJ order inputs are immutable once staged");
    if (!order) {
      const orderId = await ctx.db.insert("orders", { siteId: args.siteId, shopifyOrderId: args.shopifyOrderId, totalUsd: args.totalUsd, fulfillmentStatus: "received", cjOrderInput: input, cjLogisticsPreflight: args.logistics, cjOrderInputHash: inputHash, cjOrderNumber: orderNumber, cjDispatchStatus: "staged", cjDispatchAttempt: 0, createdAt: Date.now(), sample: false });
      order = await ctx.db.get(orderId);
    } else if (!order.cjOrderInputHash) {
      await ctx.db.patch(order._id, { cjOrderInput: input, cjLogisticsPreflight: args.logistics, cjOrderInputHash: inputHash, cjOrderNumber: orderNumber, cjDispatchStatus: "staged", cjDispatchAttempt: 0 });
      order = await ctx.db.get(order._id);
    }
    if (!order) throw new Error("order staging failed");
    if (order.cjApprovalActionId) return { orderId: order._id, actionId: order.cjApprovalActionId, orderNumber, inputHash, reused: true };
    const actionId = await ctx.db.insert("actions", {
      siteId: args.siteId, type: "dispatch_cj_sandbox_order", riskTier: "human_gated", status: "pending_approval",
      params: { orderId: order._id, orderNumber, inputHash, isSandbox: 1, payType: 3, logisticName: input.logisticName, fromCountryCode: input.fromCountryCode, logisticsQuotedAt: args.logistics.quotedAt, logisticsQuotedPriceUsd: args.logistics.quotedPriceUsd }, approvalDispatchKey: `approval-gate:cj:${args.siteId}:${orderNumber}`, approvalDispatchStatus: "pending",
      rationale: "Immutable order-input snapshot and verified CJ freight route are ready. Approval can dispatch exactly one CJ sandbox-only, create-only order.", proposedAt: Date.now(),
    });
    await ctx.db.patch(order._id, { cjApprovalActionId: actionId });
    await appendAudit(ctx, { siteId: args.siteId, actionId, event: "cj_sandbox_dispatch_staged", detail: { orderId: order._id, orderNumber, inputHash, isSandbox: 1, payType: 3 } });
    return { orderId: order._id, actionId, orderNumber, inputHash, reused: false };
  },
});

/** Atomically reserve a valid approval before the worker is permitted to call CJ. */
export const claimSandboxCjDispatch = mutation({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }) => {
    await requireServiceIdentity(ctx);
    const action = await ctx.db.get(actionId);
    if (!action || action.type !== "dispatch_cj_sandbox_order") throw new Error("CJ sandbox dispatch needs its exact approved action");
    const params = action.params as { orderId?: string };
    // `params` is intentionally untyped action metadata; constrain this dynamic lookup back to
    // the order shape before inspecting any PII/state fields.
    const order = params.orderId ? await ctx.db.get(params.orderId as any) as any : null;
    if (!hasValidSandboxCjApprovalBinding({ actionId, action, order })) throw new Error("CJ approval binding is invalid");
    // Completion is replay-safe even if a later local outbox write failed. A different action
    // or CJ id never gets to reuse this success path.
    if (action.status === "executed" && order.cjDispatchStatus === "sent" && order.cjOrderId) return { state: "reused" as const, siteId: order.siteId, orderId: order._id, cjOrderId: order.cjOrderId, orderNumber: order.cjOrderInput.orderNumber };
    if (action.status !== "approved") throw new Error("CJ sandbox dispatch needs its exact approved action");
    const decision = sandboxDispatchDecision(order.cjDispatchStatus);
    if (decision === "reused") return { state: "reused" as const, siteId: order.siteId, orderId: order._id, cjOrderId: order.cjOrderId, orderNumber: order.cjOrderInput.orderNumber };
    if (decision === "reconcile") return { state: "reconcile_required" as const, siteId: order.siteId, orderId: order._id, orderNumber: order.cjOrderInput.orderNumber };
    if (decision === "blocked") return { state: "blocked" as const, siteId: order.siteId, orderId: order._id, orderNumber: order.cjOrderInput.orderNumber };
    const attempt = (order.cjDispatchAttempt ?? 0) + 1;
    await ctx.db.patch(order._id, { cjDispatchStatus: "reserved", cjDispatchAttempt: attempt });
    await appendAudit(ctx, { siteId: order.siteId, actionId, event: "cj_sandbox_dispatch_reserved", detail: { orderId: order._id, orderNumber: order.cjOrderInput.orderNumber, isSandbox: 1 } });
    return { state: "reserved" as const, siteId: order.siteId, orderId: order._id, orderNumber: order.cjOrderInput.orderNumber, inputHash: order.cjOrderInputHash, attempt, cjInput: order.cjOrderInput };
  },
});

export const markSandboxCjDispatched = mutation({
  args: { actionId: v.id("actions"), orderId: v.id("orders"), cjOrderId: v.string() },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const order = await ctx.db.get(args.orderId);
    const action = await ctx.db.get(args.actionId);
    if (!order || !action || order.cjApprovalActionId !== args.actionId) throw new Error("sandbox dispatch completion is not authorized");
    if (order.cjDispatchStatus === "sent" && action.status === "executed" && order.cjOrderId === args.cjOrderId) return { orderId: order._id, reused: true };
    if (action.status !== "approved" || order.cjDispatchStatus !== "reserved") throw new Error("sandbox dispatch completion is not authorized");
    await ctx.db.patch(order._id, { cjOrderId: args.cjOrderId, cjOrderNumber: order.cjOrderInput?.orderNumber, cjDispatchStatus: "sent", fulfillmentStatus: "sent_to_cj" });
    await ctx.db.patch(action._id, { status: "executed", resolvedAt: Date.now() });
    await appendAudit(ctx, { siteId: order.siteId, actionId: action._id, event: "cj_sandbox_dispatch_sent", detail: { orderId: order._id, orderNumber: order.cjOrderInput?.orderNumber, cjOrderId: args.cjOrderId, isSandbox: 1, payType: 3 } });
    return { orderId: order._id, reused: false };
  },
});

export const markSandboxCjAmbiguous = mutation({
  args: { actionId: v.id("actions"), orderId: v.id("orders"), reason: v.string() },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const order = await ctx.db.get(args.orderId);
    if (!order || order.cjApprovalActionId !== args.actionId) throw new Error("sandbox dispatch ambiguity is not authorized");
    if (order.cjDispatchStatus === "sent") return { orderId: order._id, reused: true };
    if (order.cjDispatchStatus !== "reserved") throw new Error("sandbox dispatch ambiguity is not authorized");
    await ctx.db.patch(order._id, { cjDispatchStatus: "ambiguous" });
    await appendAudit(ctx, { siteId: order.siteId, actionId: args.actionId, event: "cj_sandbox_dispatch_ambiguous", detail: { orderId: order._id, orderNumber: order.cjOrderInput?.orderNumber, reason: args.reason.slice(0, 300), reconciliationRequired: true } });
    return { orderId: order._id, reused: false };
  },
});

/** Reconciliation may either bind a confirmed sandbox order or explicitly reopen a later retry. */
export const reconcileSandboxCjDispatch = mutation({
  args: { actionId: v.id("actions"), orderId: v.id("orders"), cjOrderId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const order = await ctx.db.get(args.orderId);
    const action = await ctx.db.get(args.actionId);
    if (!order || !action || order.cjApprovalActionId !== args.actionId || !order.cjOrderInput) throw new Error("sandbox reconciliation is not authorized");
    if (order.cjDispatchStatus === "sent" && action.status === "executed") return { state: "found" as const, reused: true };
    if (action.status !== "approved" || (order.cjDispatchStatus !== "reserved" && order.cjDispatchStatus !== "ambiguous")) throw new Error("sandbox reconciliation is not authorized");
    if (args.cjOrderId) {
      await ctx.db.patch(order._id, { cjOrderId: args.cjOrderId, cjOrderNumber: order.cjOrderInput.orderNumber, cjDispatchStatus: "sent", fulfillmentStatus: "sent_to_cj" });
      await ctx.db.patch(action._id, { status: "executed", resolvedAt: Date.now() });
      await appendAudit(ctx, { siteId: order.siteId, actionId: args.actionId, event: "cj_sandbox_dispatch_reconciled", detail: { orderId: order._id, orderNumber: order.cjOrderInput.orderNumber, cjOrderId: args.cjOrderId, isSandbox: 1 } });
      return { state: "found" as const };
    }
    // This is the only transition back to staged. The next claim receives a new fenced
    // generation, so an old Trigger run cannot share a create idempotency key with it.
    await ctx.db.patch(order._id, { cjDispatchStatus: "staged" });
    await appendAudit(ctx, { siteId: order.siteId, actionId: args.actionId, event: "cj_sandbox_dispatch_reconciled_absent", detail: { orderId: order._id, orderNumber: order.cjOrderInput.orderNumber, retryRequiresNewRun: true } });
    return { state: "absent" as const };
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

// Apply tracking from the CJ ORDER webhook. CJ orderNumber is a dedicated indexed identity,
// never a Shopify id; this prevents an arbitrary provider value mapping another order.
export const applyTracking = mutation({
  args: {
    cjOrderNumber: v.string(),
    trackingNumber: v.optional(v.string()),
    trackingUrl: v.optional(v.string()),
    cjOrderId: v.optional(v.string()),
    status: v.optional(fulfillmentStatus),
  },
  handler: async (ctx, args) => {
    const order = await ctx.db
      .query("orders")
      .withIndex("by_cj_order_number", (q) => q.eq("cjOrderNumber", args.cjOrderNumber))
      .first();
    if (!order) throw new Error(`order for cjOrderNumber ${args.cjOrderNumber} not found`);
    if (args.cjOrderId && order.cjOrderId && args.cjOrderId !== order.cjOrderId) throw new Error("CJ webhook order id does not match persisted order identity");
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

export const getByCjOrderNumber = query({
  args: { cjOrderNumber: v.string() },
  handler: async (ctx, { cjOrderNumber }) => ctx.db.query("orders")
    .withIndex("by_cj_order_number", (q) => q.eq("cjOrderNumber", cjOrderNumber)).first(),
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
