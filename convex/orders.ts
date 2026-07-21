// Orders + CJ fulfillment loop. Index-driven reads only.
import { query, mutation } from "./authz";
import { v } from "convex/values";
import { appendAudit } from "./audit";
import { cjFreightQuoteDigest, cjOrderInputHash, normalizeCjOrderInput, sandboxDispatchDecision, sandboxOrderNumber, stableSha256 } from "../src/lib/cjOrder";
import { hasVerifiedShopifyCjLineage } from "../src/lib/orderLineageState";
import { hasValidSandboxCjApprovalBinding } from "../src/lib/sandboxCjBinding";
import { CJ_STAGING_MAX_ATTEMPTS, cjStagingFailureTransition, cjStagingGenerationFingerprint, hasExactCjStagingGeneration, legacyCjStagingRunnableAt, type CjStagingPhase } from "../src/lib/cjStagingState";

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
    const mappings = await ctx.db.query("products")
      .withIndex("by_site_shopify_product_variant", (q: any) => q.eq("siteId", siteId).eq("shopifyProductId", line.productId).eq("shopifyVariantId", line.variantId))
      .take(2);
    // `first()` would let a corrupt duplicate mapping select an arbitrary CJ lineage.
    if (mappings.length !== 1) throw new Error("Shopify product/variant mapping is missing or ambiguous");
    const product = mappings[0];
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

const CJ_FREIGHT_ENDPOINT = "/logistic/freightCalculate";
const CJ_FREIGHT_VERSION = "CJ API v2";
export const CJ_FREIGHT_MAX_AGE_MS = 30 * 60_000;

/** Claim one durable preflight generation. Its return is service-only and is never a Trigger payload. */
export const claimCjStagingPreflight = mutation({
  args: { intentId: v.id("cjStagingIntents") },
  handler: async (ctx, { intentId }) => {
    await requireServiceIdentity(ctx);
    const intent = await ctx.db.get(intentId);
    if (!intent) throw new Error("CJ staging intent not found");
    if (intent.status === "quoted") return { state: "quoted" as const, intentId, quote: intent.quote };
    // Stage and approval-dispatch are independently durable boundaries.  A lost worker must
    // resume the persisted action/key, not declare it complete before the waitpoint is armed.
    if (intent.status === "staged" || intent.status === "approval_dispatching") return { state: "staged" as const, intentId };
    if (intent.status === "approval_dispatched") return { state: "complete" as const, intentId };
    const now = Date.now();
    if (intent.status === "preflighting" && (intent.leaseExpiresAt ?? 0) > now) return { state: "busy" as const, intentId };
    if (intent.status !== "pending" && intent.status !== "preflighting" && intent.status !== "preflight_required") throw new Error("CJ staging intent is not eligible for preflight");
    const workerAttempt = (intent.workerAttempt ?? 0) + 1;
    if (workerAttempt > CJ_STAGING_MAX_ATTEMPTS) {
      await ctx.db.patch(intentId, { status: "needs_attention", runnableAt: undefined, leaseExpiresAt: undefined, lastError: { code: "worker_attempts_exhausted" }, updatedAt: now });
      return { state: "complete" as const, intentId };
    }
    const order = await ctx.db.get(intent.orderId);
    if (!order || order.siteId !== intent.siteId) throw new Error("CJ staging intent order binding is invalid");
    const lineage = await resolvePersistedShopifyCjLineage(ctx, intent.siteId, intent.shopifyLines);
    const quoteInputDigest = cjFreightQuoteDigest({
      siteId: String(intent.siteId), shopifyOrderId: order.shopifyOrderId, fromCountryCode: lineage.fromCountryCode,
      destinationCountryCode: intent.shipping.shippingCountryCode, shippingZip: intent.shipping.shippingZip,
      products: lineage.lines.map((line) => ({ vid: line.cjVariantId, quantity: line.quantity })),
      providerEndpoint: CJ_FREIGHT_ENDPOINT, providerVersion: CJ_FREIGHT_VERSION,
    });
    const attempt = intent.attempt + 1;
    const leaseExpiresAt = now + 5 * 60_000;
    await ctx.db.patch(intentId, { status: "preflighting", attempt, workerAttempt, leaseExpiresAt, runnableAt: leaseExpiresAt, lastError: undefined, quoteInputDigest, quoteProvider: { endpoint: CJ_FREIGHT_ENDPOINT, version: CJ_FREIGHT_VERSION }, updatedAt: now });
    return { state: "preflight" as const, intentId, attempt, quoteInputDigest, fromCountryCode: lineage.fromCountryCode, destinationCountryCode: intent.shipping.shippingCountryCode, shippingZip: intent.shipping.shippingZip, products: lineage.lines.map((line) => ({ vid: line.cjVariantId, quantity: line.quantity })) };
  },
});

/** Persist exactly one selected provider response, bound to the preflight generation and digest. */
export const recordCjStagingQuote = mutation({
  args: { intentId: v.id("cjStagingIntents"), attempt: v.number(), quoteInputDigest: v.string(), logisticName: v.string(), logisticPriceUsd: v.number(), fromCountryCode: v.string() },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const intent = await ctx.db.get(args.intentId);
    if (!intent) throw new Error("CJ staging intent not found");
    if (intent.status === "quoted" && intent.quote && intent.quoteInputDigest === args.quoteInputDigest) return { reused: true as const, quote: intent.quote };
    if (intent.status !== "preflighting" || intent.attempt !== args.attempt || intent.quoteInputDigest !== args.quoteInputDigest) throw new Error("CJ freight result was not claimed by this preflight generation");
    if (!args.logisticName.trim() || !Number.isFinite(args.logisticPriceUsd) || args.logisticPriceUsd < 0 || !/^[A-Z]{2}$/.test(args.fromCountryCode)) throw new Error("CJ freight result is invalid");
    const now = Date.now();
    // The service assigns quote time; a worker clock cannot extend approval freshness.
    const quote = { logisticName: args.logisticName.trim(), logisticPriceUsd: args.logisticPriceUsd, fromCountryCode: args.fromCountryCode, quotedAt: now };
    await ctx.db.patch(args.intentId, { status: "quoted", quote, leaseExpiresAt: undefined, runnableAt: now, updatedAt: now });
    return { reused: false as const, quote };
  },
});

/** Stage a fresh quote into the immutable order snapshot and exactly one human-gated action. */
export const stageQuotedCjStagingIntent = mutation({
  args: { intentId: v.id("cjStagingIntents") },
  handler: async (ctx, { intentId }) => {
    await requireServiceIdentity(ctx);
    const intent = await ctx.db.get(intentId);
    if (!intent) throw new Error("CJ staging intent not found");
    if (intent.status === "staged" || intent.status === "approval_dispatching" || intent.status === "approval_dispatched") return { state: "reused" as const, actionId: intent.actionId };
    if (intent.status !== "quoted" || !intent.quote || !intent.quoteInputDigest || !intent.quoteProvider) throw new Error("CJ staging needs a persisted freight quote");
    const now = Date.now();
    if (now - intent.quote.quotedAt > CJ_FREIGHT_MAX_AGE_MS) {
      await ctx.db.patch(intentId, { status: "preflight_required", quote: undefined, leaseExpiresAt: undefined, runnableAt: now, updatedAt: now });
      return { state: "preflight_required" as const };
    }
    const order = await ctx.db.get(intent.orderId);
    if (!order || order.siteId !== intent.siteId) throw new Error("CJ staging intent order binding is invalid");
    const lineage = await resolvePersistedShopifyCjLineage(ctx, intent.siteId, intent.shopifyLines);
    const digest = cjFreightQuoteDigest({ siteId: String(intent.siteId), shopifyOrderId: order.shopifyOrderId, fromCountryCode: lineage.fromCountryCode, destinationCountryCode: intent.shipping.shippingCountryCode, shippingZip: intent.shipping.shippingZip, products: lineage.lines.map((line) => ({ vid: line.cjVariantId, quantity: line.quantity })), providerEndpoint: intent.quoteProvider.endpoint, providerVersion: intent.quoteProvider.version });
    if (digest !== intent.quoteInputDigest || intent.quote.fromCountryCode !== lineage.fromCountryCode) throw new Error("CJ freight quote is not bound to current verified lineage");
    const orderNumber = sandboxOrderNumber(String(intent.siteId), order.shopifyOrderId);
    const input = normalizeCjOrderInput({ orderNumber, ...intent.shipping, logisticName: intent.quote.logisticName, fromCountryCode: lineage.fromCountryCode, products: lineage.lines.map((line) => ({ vid: line.cjVariantId, quantity: line.quantity })) }, orderNumber);
    const inputHash = cjOrderInputHash(input);
    // A provider write makes local lineage immutable. Do not replace a reserved, ambiguous, or
    // sent snapshot merely because the quote expired; an operator must reconcile it first.
    if (["reserved", "ambiguous", "sent"].includes(order.cjDispatchStatus ?? "staged")) {
      await ctx.db.patch(intentId, { status: "needs_attention", leaseExpiresAt: undefined, runnableAt: undefined, lastError: { code: "provider_lineage_requires_reconciliation" }, updatedAt: now });
      await appendAudit(ctx, { siteId: intent.siteId, event: "cj_staging_needs_attention", detail: { orderId: order._id, reason: "provider_lineage_requires_reconciliation" } });
      return { state: "needs_attention" as const };
    }
    // Reusing an exact current generation is safe. A changed quote supersedes the old action,
    // snapshot, key, and fingerprint before any future CJ reservation can happen.
    const sameGeneration = order.cjOrderInputHash === inputHash && !!order.cjApprovalActionId;
    if (sameGeneration) {
      const action = await ctx.db.get(order.cjApprovalActionId!);
      const actionParams = action?.params as Record<string, unknown> | undefined;
      if (action && hasExactCjStagingGeneration({
        actionStatus: action?.status, actionParams,
        order: { cjOrderInputHash: order.cjOrderInputHash, cjDispatchGeneration: order.cjDispatchGeneration, cjDispatchGenerationFingerprint: order.cjDispatchGenerationFingerprint, cjQuoteInputDigest: order.cjQuoteInputDigest },
        quote: { quoteInputDigest: intent.quoteInputDigest, logisticName: input.logisticName, fromCountryCode: input.fromCountryCode, quotedPriceUsd: intent.quote.logisticPriceUsd, quotedAt: intent.quote.quotedAt },
      })) {
        await ctx.db.patch(intentId, { status: "staged", actionId: action._id, leaseExpiresAt: undefined, runnableAt: now, updatedAt: now });
        return { state: "staged" as const, actionId: action._id, orderNumber };
      }
    }
    if (order.cjApprovalActionId) {
      const oldAction = await ctx.db.get(order.cjApprovalActionId);
      if (oldAction && (oldAction.status === "pending_approval" || oldAction.status === "approved")) {
        // An ambiguous or in-flight deterministic Trigger dispatch may already own a live
        // waitpoint.  Do not mint a replacement generation until an operator reconciles it.
        if (oldAction.approvalDispatchStatus === "dispatching" || oldAction.approvalDispatchStatus === "ambiguous") {
          await ctx.db.patch(intentId, { status: "needs_attention", leaseExpiresAt: undefined, runnableAt: undefined, lastError: { code: "approval_dispatch_requires_reconciliation" }, updatedAt: now });
          await appendAudit(ctx, { siteId: intent.siteId, actionId: oldAction._id, event: "cj_staging_needs_attention", detail: { orderId: order._id, reason: "approval_dispatch_requires_reconciliation" } });
          return { state: "needs_attention" as const };
        }
        // Trigger has no safe generic cancellation primitive here.  Superseding the exact
        // action fences canArm/approve and makes any old waitpoint a no-op.
        await ctx.db.patch(oldAction._id, { status: "superseded", resolvedAt: now });
        await appendAudit(ctx, { siteId: intent.siteId, actionId: oldAction._id, event: "cj_sandbox_dispatch_superseded", detail: { orderId: order._id, reason: "fresh_quote_generation" } });
      }
    }
    const generation = (order.cjDispatchGeneration ?? 0) + 1;
    const generationFingerprint = cjStagingGenerationFingerprint({ generation, inputHash, quoteInputDigest: intent.quoteInputDigest, logisticName: input.logisticName, fromCountryCode: input.fromCountryCode, quotedPriceUsd: intent.quote.logisticPriceUsd, quotedAt: intent.quote.quotedAt });
    const approvalDispatchKey = `approval-gate:cj:${intent.siteId}:${orderNumber}:g${generation}:${generationFingerprint.slice(0, 16)}`;
    const actionId = await ctx.db.insert("actions", { siteId: intent.siteId, type: "dispatch_cj_sandbox_order", riskTier: "human_gated", status: "pending_approval", params: { orderId: order._id, orderNumber, inputHash, generation, generationFingerprint, quoteInputDigest: intent.quoteInputDigest, isSandbox: 1, payType: 3, logisticName: input.logisticName, fromCountryCode: input.fromCountryCode, logisticsQuotedAt: intent.quote.quotedAt, logisticsQuotedPriceUsd: intent.quote.logisticPriceUsd }, approvalDispatchKey, approvalDispatchStatus: "pending", rationale: "A fresh, lineage-bound CJ freight quote is ready. Exact human approval is required before sandbox-only creation.", proposedAt: now });
    await ctx.db.patch(order._id, { cjOrderInput: input, cjLogisticsPreflight: { logisticName: intent.quote.logisticName, fromCountryCode: lineage.fromCountryCode, quotedAt: intent.quote.quotedAt, quotedPriceUsd: intent.quote.logisticPriceUsd }, cjOrderInputHash: inputHash, cjOrderNumber: orderNumber, cjDispatchGeneration: generation, cjDispatchGenerationFingerprint: generationFingerprint, cjQuoteInputDigest: intent.quoteInputDigest, cjApprovalActionId: actionId, cjDispatchStatus: "staged", cjDispatchAttempt: 0 });
    await appendAudit(ctx, { siteId: intent.siteId, actionId, event: "cj_sandbox_dispatch_staged", detail: { orderId: order._id, orderNumber, inputHash, generation, quoteInputDigest: intent.quoteInputDigest, isSandbox: 1, payType: 3 } });
    await ctx.db.patch(intentId, { status: "staged", actionId, leaseExpiresAt: undefined, runnableAt: now, updatedAt: now });
    return { state: "staged" as const, actionId, orderNumber };
  },
});

/** A fenced claim keeps concurrent scheduled workers from arming duplicate approval waits. */
export const claimCjStagingApprovalDispatch = mutation({
  args: { intentId: v.id("cjStagingIntents") },
  handler: async (ctx, { intentId }) => {
    await requireServiceIdentity(ctx);
    const intent = await ctx.db.get(intentId);
    if (!intent || !intent.actionId) throw new Error("CJ staging approval is not ready");
    if (intent.status === "approval_dispatched") return { state: "reused" as const, actionId: intent.actionId };
    const now = Date.now();
    if (intent.status === "approval_dispatching" && (intent.leaseExpiresAt ?? 0) > now) return { state: "busy" as const };
    if (intent.status !== "staged" && intent.status !== "approval_dispatching") throw new Error("CJ staging approval is not ready");
    const workerAttempt = (intent.workerAttempt ?? 0) + 1;
    if (workerAttempt > CJ_STAGING_MAX_ATTEMPTS) {
      await ctx.db.patch(intentId, { status: "needs_attention", runnableAt: undefined, leaseExpiresAt: undefined, lastError: { code: "worker_attempts_exhausted" }, updatedAt: now });
      return { state: "reused" as const, actionId: intent.actionId };
    }
    const action = await ctx.db.get(intent.actionId);
    if (!action || action.type !== "dispatch_cj_sandbox_order" || action.siteId !== intent.siteId || !action.approvalDispatchKey) throw new Error("CJ staging approval binding is invalid");
    const leaseExpiresAt = now + 5 * 60_000;
    const order = await ctx.db.get(intent.orderId);
    const params = action?.params as Record<string, unknown> | undefined;
    if (!order || action?.status !== "pending_approval" || params?.generation !== order.cjDispatchGeneration || params?.generationFingerprint !== order.cjDispatchGenerationFingerprint || params?.quoteInputDigest !== order.cjQuoteInputDigest) throw new Error("CJ staging approval generation is stale");
    await ctx.db.patch(intentId, { status: "approval_dispatching", workerAttempt, leaseExpiresAt, runnableAt: leaseExpiresAt, updatedAt: now });
    return { state: "dispatch" as const, actionId: intent.actionId, approvalDispatchKey: action.approvalDispatchKey };
  },
});

export const recordCjStagingApprovalDispatch = mutation({
  args: { intentId: v.id("cjStagingIntents"), actionId: v.id("actions") },
  handler: async (ctx, { intentId, actionId }) => {
    await requireServiceIdentity(ctx);
    const intent = await ctx.db.get(intentId);
    const action = await ctx.db.get(actionId);
    if (!intent || !action || intent.actionId !== actionId || intent.status !== "approval_dispatching" || action.status !== "pending_approval" || action.approvalDispatchStatus !== "dispatched") throw new Error("CJ staging approval completion is not authorized");
    await ctx.db.patch(intentId, { status: "approval_dispatched", leaseExpiresAt: undefined, runnableAt: undefined, updatedAt: Date.now() });
    return { ok: true };
  },
});

/** Scheduled workers only need stable due IDs; no customer fields cross this query boundary. */
export const listDueCjStagingIntents = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    await requireServiceIdentity(ctx);
    const now = Date.now();
    const rows = await ctx.db.query("cjStagingIntents")
      .withIndex("by_runnable_at", (q: any) => q.gt("runnableAt", 0).lte("runnableAt", now))
      .order("asc")
      .take(Math.max(1, Math.min(limit ?? 25, 100)));
    return rows.map(({ _id }) => ({ _id }));
  },
});

/** Classify a worker failure without serializing provider text or customer fields. */
export const recordCjStagingFailure = mutation({
  args: { intentId: v.id("cjStagingIntents"), errorCode: v.union(v.literal("invalid_or_unbound_input"), v.literal("provider_unavailable"), v.literal("unexpected_runtime_failure")), kind: v.union(v.literal("retryable"), v.literal("permanent")) },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const intent = await ctx.db.get(args.intentId);
    if (!intent || ["approval_dispatched", "needs_attention", "failed"].includes(intent.status)) return { ignored: true };
    const now = Date.now();
    const workerAttempt = (intent.workerAttempt ?? 0) + 1;
    const transition = cjStagingFailureTransition(now, workerAttempt, args.kind, intent.status as CjStagingPhase);
    await ctx.db.patch(args.intentId, { status: transition.status, workerAttempt, runnableAt: transition.runnableAt, leaseExpiresAt: undefined, lastError: { code: args.errorCode }, updatedAt: now });
    await appendAudit(ctx, { siteId: intent.siteId, event: "cj_staging_failed", detail: { intentId: intent._id, code: args.errorCode, terminal: transition.status === "needs_attention", workerAttempts: workerAttempt, maxAttempts: CJ_STAGING_MAX_ATTEMPTS } });
    return { ignored: false, status: transition.status, runnableAt: transition.runnableAt };
  },
});

/** Bounded optional-field rollout; this is invoked before sweeps and never sits on the hot due query. */
export const reconcileLegacyCjStagingIntents = mutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    await requireServiceIdentity(ctx);
    const now = Date.now();
    let remaining = Math.max(1, Math.min(limit ?? 25, 100));
    let repaired = 0;
    for (const status of ["pending", "preflight_required", "quoted", "staged", "preflighting", "approval_dispatching"] as const) {
      if (!remaining) break;
      const rows = await ctx.db.query("cjStagingIntents")
        .withIndex("by_status_runnable_at", (q: any) => q.eq("status", status).eq("runnableAt", undefined))
        .take(remaining);
      for (const intent of rows) {
        const runnableAt = legacyCjStagingRunnableAt(status, intent.leaseExpiresAt, now);
        await ctx.db.patch(intent._id, { runnableAt, workerAttempt: intent.workerAttempt ?? 0, updatedAt: now });
        repaired++; remaining--;
      }
    }
    return { repaired };
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
    // Approval never extends a provider quote. An approved but stale snapshot is fenced off and
    // its linked intent explicitly returns to preflight; it is never silently rewritten.
    if (order?.cjLogisticsPreflight && Date.now() - order.cjLogisticsPreflight.quotedAt > CJ_FREIGHT_MAX_AGE_MS) {
      const intent = await ctx.db.query("cjStagingIntents").withIndex("by_order", (q: any) => q.eq("orderId", order._id)).first();
      const now = Date.now();
      if (["reserved", "ambiguous", "sent"].includes(order.cjDispatchStatus ?? "staged")) {
        if (intent) await ctx.db.patch(intent._id, { status: "needs_attention", leaseExpiresAt: undefined, runnableAt: undefined, lastError: { code: "provider_lineage_requires_reconciliation" }, updatedAt: now });
        return { state: "blocked" as const, siteId: order.siteId, orderId: order._id, orderNumber: order.cjOrderInput.orderNumber, reason: "CJ provider lineage requires reconciliation" };
      }
      // This approved snapshot is stale. It is explicitly superseded before a fresh quote can
      // create a new immutable generation and require another human approval.
      await ctx.db.patch(action._id, { status: "superseded", resolvedAt: now });
      if (intent) await ctx.db.patch(intent._id, { status: "preflight_required", quote: undefined, leaseExpiresAt: undefined, runnableAt: now, updatedAt: now });
      await appendAudit(ctx, { siteId: order.siteId, actionId, event: "cj_sandbox_dispatch_superseded", detail: { orderId: order._id, reason: "quote_expired_before_reservation" } });
      return { state: "blocked" as const, siteId: order.siteId, orderId: order._id, orderNumber: order.cjOrderInput.orderNumber, reason: "CJ freight quote is stale; explicit preflight and re-approval are required" };
    }
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
