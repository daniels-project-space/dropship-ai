// Orders + CJ fulfillment loop. Index-driven reads only.
import { query, mutation } from "./authz";
import { v } from "convex/values";
import { appendAudit } from "./audit";
import { cjFreightQuoteDigest, cjOrderInputHash, normalizeCjOrderInput, sandboxDispatchDecision, sandboxOrderNumber, stableSha256 } from "../src/lib/cjOrder";
import { hasVerifiedShopifyCjLineage } from "../src/lib/orderLineageState";
import { hasCurrentSandboxCjDispatchReceipt, hasValidSandboxCjApprovalBinding } from "../src/lib/sandboxCjBinding";
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
const creditAdjustmentState = v.union(v.literal("none"), v.literal("partial"), v.literal("full"));
async function requireServiceIdentity(ctx: { auth: { getUserIdentity: () => Promise<{ subject?: string } | null> } }): Promise<void> {
  if ((await ctx.auth.getUserIdentity())?.subject !== "dropship-ai:service") throw new Error("UNAUTHENTICATED: sandbox dispatch requires the service runtime");
}

/** Terminal staging failures are durable, redacted, and never left scheduler-runnable. */
async function needsAttention(ctx: any, intent: any, code: "invalid_or_unbound_input" | "invalid_verified_lineage" | "approval_binding_invalid", actionId?: any) {
  const now = Date.now();
  await ctx.db.patch(intent._id, { status: "needs_attention", runnableAt: undefined, leaseExpiresAt: undefined, lastError: { code }, updatedAt: now });
  await appendAudit(ctx, { siteId: intent.siteId, ...(actionId ? { actionId } : {}), event: "cj_staging_needs_attention", detail: { intentId: intent._id, code } });
  return { state: "needs_attention" as const, ...(actionId ? { actionId } : {}) };
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
        currencyCode: v.string(),
        currentTotal: v.number(),
        financialStatus: v.string(),
        test: v.boolean(),
        cancelled: v.boolean(),
        creditAdjustmentState,
        fulfillmentStatus: fulfillmentStatus,
        createdAt: v.number(),
      }),
    ),
  },
  handler: async (ctx, { siteId, orders }) => {
    await requireServiceIdentity(ctx);
    let inserted = 0;
    let updated = 0;
    for (const o of orders) {
      const existing = await ctx.db
        .query("orders")
        .withIndex("by_site_shopify_order", (q) => q.eq("siteId", siteId).eq("shopifyOrderId", o.shopifyOrderId))
        .first();
      if (existing) {
        // never downgrade an order the fulfillment loop has already advanced
        const nextStatus =
          ADVANCED_ORDER[o.fulfillmentStatus] > ADVANCED_ORDER[existing.fulfillmentStatus]
            ? o.fulfillmentStatus
            : existing.fulfillmentStatus;
        await ctx.db.patch(existing._id, {
          currencyCode: o.currencyCode,
          currentTotal: o.currentTotal,
          financialStatus: o.financialStatus,
          test: o.test,
          cancelled: o.cancelled,
          creditAdjustmentState: o.creditAdjustmentState,
          totalUsd: o.currencyCode === "USD" ? o.currentTotal : undefined,
          fulfillmentStatus: nextStatus,
          sample: false,
        });
        updated++;
      } else {
        await ctx.db.insert("orders", {
          siteId,
          shopifyOrderId: o.shopifyOrderId,
          fulfillmentStatus: o.fulfillmentStatus,
          currencyCode: o.currencyCode,
          currentTotal: o.currentTotal,
          financialStatus: o.financialStatus,
          test: o.test,
          cancelled: o.cancelled,
          creditAdjustmentState: o.creditAdjustmentState,
          totalUsd: o.currencyCode === "USD" ? o.currentTotal : undefined,
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
    totalUsd: v.optional(v.number()),
    currencyCode: v.optional(v.string()),
    currentTotal: v.optional(v.number()),
    financialStatus: v.optional(v.string()),
    test: v.optional(v.boolean()),
    cancelled: v.optional(v.boolean()),
    creditAdjustmentState: v.optional(creditAdjustmentState),
    cjOrderId: v.optional(v.string()),
    fulfillmentStatus: v.optional(fulfillmentStatus),
  },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const existing = await ctx.db
      .query("orders")
      .withIndex("by_site_shopify_order", (q) => q.eq("siteId", args.siteId).eq("shopifyOrderId", args.shopifyOrderId))
      .first();
    if (existing) {
      const patch: Record<string, unknown> = {};
      if (args.cjOrderId) patch.cjOrderId = args.cjOrderId;
      if (args.fulfillmentStatus) patch.fulfillmentStatus = args.fulfillmentStatus;
      for (const key of ["currencyCode", "currentTotal", "financialStatus", "test", "cancelled", "creditAdjustmentState"] as const) {
        if (args[key] !== undefined) patch[key] = args[key];
      }
      if (args.currentTotal !== undefined && args.currencyCode === "USD") patch.totalUsd = args.currentTotal;
      if (Object.keys(patch).length) await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    const orderId = await ctx.db.insert("orders", {
      siteId: args.siteId,
      shopifyOrderId: args.shopifyOrderId,
      cjOrderId: args.cjOrderId,
      fulfillmentStatus: args.fulfillmentStatus ?? "received",
      totalUsd: args.totalUsd ?? (args.currencyCode === "USD" ? args.currentTotal : undefined),
      currencyCode: args.currencyCode,
      currentTotal: args.currentTotal,
      financialStatus: args.financialStatus,
      test: args.test,
      cancelled: args.cancelled,
      creditAdjustmentState: args.creditAdjustmentState,
      createdAt: Date.now(),
    });
    await appendAudit(ctx, { siteId: args.siteId, event: "order_received", detail: { orderId } });
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
    if (intent.status === "quoted") return { state: "quoted" as const, intentId, quote: intent.quote, attempt: intent.attempt, leaseGeneration: intent.leaseGeneration ?? 0 };
    // Stage and approval-dispatch are independently durable boundaries.  A lost worker must
    // resume the persisted action/key, not declare it complete before the waitpoint is armed.
    if (intent.status === "staged" || intent.status === "approval_dispatching") return { state: "staged" as const, intentId };
    if (intent.status === "approval_dispatched" || intent.status === "approval_resolved") return { state: "complete" as const, intentId };
    const now = Date.now();
    if (intent.status === "preflighting" && (intent.leaseExpiresAt ?? 0) > now) return { state: "busy" as const, intentId };
    if (intent.status !== "pending" && intent.status !== "preflighting" && intent.status !== "preflight_required") throw new Error("CJ staging intent is not eligible for preflight");
    const failureCount = intent.failureCount ?? intent.workerAttempt ?? 0;
    if (failureCount >= CJ_STAGING_MAX_ATTEMPTS) {
      await ctx.db.patch(intentId, { status: "needs_attention", runnableAt: undefined, leaseExpiresAt: undefined, lastError: { code: "worker_attempts_exhausted" }, updatedAt: now });
      return { state: "needs_attention" as const, intentId };
    }
    const order = await ctx.db.get(intent.orderId);
    if (!order || order.siteId !== intent.siteId) {
      await ctx.db.patch(intentId, { status: "needs_attention", runnableAt: undefined, leaseExpiresAt: undefined, lastError: { code: "invalid_or_unbound_input" }, updatedAt: now });
      await appendAudit(ctx, { siteId: intent.siteId, event: "cj_staging_needs_attention", detail: { intentId, code: "invalid_or_unbound_input" } });
      return { state: "needs_attention" as const, intentId };
    }
    let lineage;
    try {
      lineage = await resolvePersistedShopifyCjLineage(ctx, intent.siteId, intent.shopifyLines);
    } catch {
      await ctx.db.patch(intentId, { status: "needs_attention", runnableAt: undefined, leaseExpiresAt: undefined, lastError: { code: "invalid_verified_lineage" }, updatedAt: now });
      await appendAudit(ctx, { siteId: intent.siteId, event: "cj_staging_needs_attention", detail: { intentId, code: "invalid_verified_lineage" } });
      return { state: "needs_attention" as const, intentId };
    }
    const quoteInputDigest = cjFreightQuoteDigest({
      siteId: String(intent.siteId), shopifyOrderId: order.shopifyOrderId, fromCountryCode: lineage.fromCountryCode,
      destinationCountryCode: intent.shipping.shippingCountryCode, shippingZip: intent.shipping.shippingZip,
      products: lineage.lines.map((line) => ({ vid: line.cjVariantId, quantity: line.quantity })),
      providerEndpoint: CJ_FREIGHT_ENDPOINT, providerVersion: CJ_FREIGHT_VERSION,
    });
    const attempt = intent.attempt + 1;
    const leaseGeneration = (intent.leaseGeneration ?? 0) + 1;
    const leaseExpiresAt = now + 5 * 60_000;
    await ctx.db.patch(intentId, { status: "preflighting", attempt, leaseGeneration, failureCount, leaseExpiresAt, runnableAt: leaseExpiresAt, lastError: undefined, quoteInputDigest, quoteProvider: { endpoint: CJ_FREIGHT_ENDPOINT, version: CJ_FREIGHT_VERSION }, updatedAt: now });
    return { state: "preflight" as const, intentId, attempt, leaseGeneration, quoteInputDigest, fromCountryCode: lineage.fromCountryCode, destinationCountryCode: intent.shipping.shippingCountryCode, shippingZip: intent.shipping.shippingZip, products: lineage.lines.map((line) => ({ vid: line.cjVariantId, quantity: line.quantity })) };
  },
});

/** Persist exactly one selected provider response, bound to the preflight generation and digest. */
export const recordCjStagingQuote = mutation({
  args: { intentId: v.id("cjStagingIntents"), attempt: v.number(), leaseGeneration: v.number(), quoteInputDigest: v.string(), logisticName: v.string(), logisticPriceUsd: v.number(), fromCountryCode: v.string() },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const intent = await ctx.db.get(args.intentId);
    if (!intent) throw new Error("CJ staging intent not found");
    if (intent.status === "quoted" && intent.quote && intent.quoteInputDigest === args.quoteInputDigest && intent.attempt === args.attempt && intent.leaseGeneration === args.leaseGeneration) return { reused: true as const, quote: intent.quote };
    if (intent.status !== "preflighting" || intent.attempt !== args.attempt || intent.leaseGeneration !== args.leaseGeneration || intent.quoteInputDigest !== args.quoteInputDigest) return { ignored: true as const };
    if (!args.logisticName.trim() || !Number.isFinite(args.logisticPriceUsd) || args.logisticPriceUsd < 0 || !/^[A-Z]{2}$/.test(args.fromCountryCode)) throw new Error("CJ freight result is invalid");
    const now = Date.now();
    // The service assigns quote time; a worker clock cannot extend approval freshness.
    const quote = { logisticName: args.logisticName.trim(), logisticPriceUsd: args.logisticPriceUsd, fromCountryCode: args.fromCountryCode, quotedAt: now };
    await ctx.db.patch(args.intentId, { status: "quoted", quote, leaseExpiresAt: undefined, runnableAt: now, updatedAt: now });
    return { reused: false as const, ignored: false as const, quote };
  },
});

/** Stage a fresh quote into the immutable order snapshot and exactly one human-gated action. */
export const stageQuotedCjStagingIntent = mutation({
  args: { intentId: v.id("cjStagingIntents") },
  handler: async (ctx, { intentId }) => {
    await requireServiceIdentity(ctx);
    const intent = await ctx.db.get(intentId);
    if (!intent) throw new Error("CJ staging intent not found");
    if (intent.status === "staged" || intent.status === "approval_dispatching" || intent.status === "approval_dispatched" || intent.status === "approval_resolved") return { state: "reused" as const, actionId: intent.actionId };
    if (intent.status !== "quoted" || !intent.quote || !intent.quoteInputDigest || !intent.quoteProvider) throw new Error("CJ staging needs a persisted freight quote");
    const now = Date.now();
    if (now - intent.quote.quotedAt > CJ_FREIGHT_MAX_AGE_MS) {
      await ctx.db.patch(intentId, { status: "preflight_required", quote: undefined, leaseExpiresAt: undefined, runnableAt: now, updatedAt: now });
      return { state: "preflight_required" as const };
    }
    const order = await ctx.db.get(intent.orderId);
    if (!order || order.siteId !== intent.siteId) return needsAttention(ctx, intent, "invalid_or_unbound_input");
    let lineage;
    try {
      lineage = await resolvePersistedShopifyCjLineage(ctx, intent.siteId, intent.shopifyLines);
    } catch {
      return needsAttention(ctx, intent, "invalid_verified_lineage");
    }
    const digest = cjFreightQuoteDigest({ siteId: String(intent.siteId), shopifyOrderId: order.shopifyOrderId, fromCountryCode: lineage.fromCountryCode, destinationCountryCode: intent.shipping.shippingCountryCode, shippingZip: intent.shipping.shippingZip, products: lineage.lines.map((line) => ({ vid: line.cjVariantId, quantity: line.quantity })), providerEndpoint: intent.quoteProvider.endpoint, providerVersion: intent.quoteProvider.version });
    if (digest !== intent.quoteInputDigest || intent.quote.fromCountryCode !== lineage.fromCountryCode) return needsAttention(ctx, intent, "invalid_verified_lineage");
    const orderNumber = sandboxOrderNumber(String(intent.siteId), order.shopifyOrderId);
    const routeOwners = await ctx.db.query("orders")
      .withIndex("by_cj_webhook_order_number", (q: any) => q.eq("cjOrderNumber", orderNumber))
      .take(2);
    if (routeOwners.some((owner: any) => owner._id !== order._id)) {
      // The indexed range read and later patch share this Convex transaction. A concurrent
      // staging attempt for the same identity therefore conflicts instead of committing twice.
      throw new Error("CJ webhook order identity collision; staging was rejected");
    }
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
    await appendAudit(ctx, { siteId: intent.siteId, actionId, event: "cj_sandbox_dispatch_staged", detail: { orderId: order._id, inputHash, generation, quoteInputDigest: intent.quoteInputDigest, isSandbox: 1, payType: 3 } });
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
    if (intent.status === "approval_dispatched" || intent.status === "approval_resolved") return { state: "reused" as const, actionId: intent.actionId };
    const now = Date.now();
    if (intent.status === "approval_dispatching" && (intent.leaseExpiresAt ?? 0) > now) return { state: "busy" as const };
    if (intent.status !== "staged" && intent.status !== "approval_dispatching") throw new Error("CJ staging approval is not ready");
    const failureCount = intent.failureCount ?? intent.workerAttempt ?? 0;
    if (failureCount >= CJ_STAGING_MAX_ATTEMPTS) {
      await ctx.db.patch(intentId, { status: "needs_attention", runnableAt: undefined, leaseExpiresAt: undefined, lastError: { code: "worker_attempts_exhausted" }, updatedAt: now });
      return { state: "needs_attention" as const, actionId: intent.actionId };
    }
    const action = await ctx.db.get(intent.actionId);
    const leaseExpiresAt = now + 5 * 60_000;
    const leaseGeneration = (intent.leaseGeneration ?? 0) + 1;
    const order = await ctx.db.get(intent.orderId);
    // Validate every immutable field before a waitpoint can be armed. This canonical check is
    // also used for provider receipt completion and reconciliation.
    if (!action || !action.approvalDispatchKey || !order || !hasValidSandboxCjApprovalBinding({ actionId: intent.actionId, action, order })) {
      return needsAttention(ctx, intent, "approval_binding_invalid", intent.actionId);
    }
    if (action.status === "approved" || action.status === "rejected") {
      await ctx.db.patch(intentId, { status: "approval_resolved", leaseExpiresAt: undefined, runnableAt: undefined, updatedAt: now });
      return { state: "resolved" as const, actionId: intent.actionId };
    }
    if (action.status !== "pending_approval") throw new Error("CJ staging approval is no longer pending");
    await ctx.db.patch(intentId, { status: "approval_dispatching", failureCount, leaseGeneration, leaseExpiresAt, runnableAt: leaseExpiresAt, updatedAt: now });
    return { state: "dispatch" as const, actionId: intent.actionId, approvalDispatchKey: action.approvalDispatchKey, leaseGeneration, attempt: intent.attempt };
  },
});

export const recordCjStagingApprovalDispatch = mutation({
  args: { intentId: v.id("cjStagingIntents"), actionId: v.id("actions"), approvalDispatchKey: v.string(), approvalRunId: v.string(), leaseGeneration: v.number() },
  handler: async (ctx, { intentId, actionId, approvalDispatchKey, approvalRunId, leaseGeneration }) => {
    await requireServiceIdentity(ctx);
    const intent = await ctx.db.get(intentId);
    const action = await ctx.db.get(actionId);
    if (!intent || !action || intent.actionId !== actionId || intent.status !== "approval_dispatching" || intent.leaseGeneration !== leaseGeneration) return { ignored: true as const };
    const order = await ctx.db.get(intent.orderId);
    if (!order || !hasValidSandboxCjApprovalBinding({ actionId, action, order })) return needsAttention(ctx, intent, "approval_binding_invalid", actionId);
    // A human may resolve the exact action between Trigger accepting the run and this durable
    // acknowledgement. Same action/key/run is a successful reconciliation, never a new wait.
    if (action.approvalDispatchKey !== approvalDispatchKey || action.approvalRunId !== approvalRunId || action.approvalDispatchStatus !== "dispatched") throw new Error("CJ staging approval completion is not authorized");
    const resolved = action.status === "approved" || action.status === "rejected";
    await ctx.db.patch(intentId, { status: resolved ? "approval_resolved" : "approval_dispatched", leaseExpiresAt: undefined, runnableAt: undefined, updatedAt: Date.now() });
    return { ok: true, ignored: false as const, state: resolved ? "resolved" as const : "approval_dispatched" as const };
  },
});

/** Close the staging lease when the exact human action resolves during a Trigger retry. */
export const resolveCjStagingApproval = mutation({
  args: { intentId: v.id("cjStagingIntents"), actionId: v.id("actions"), approvalDispatchKey: v.string(), leaseGeneration: v.number() },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const intent = await ctx.db.get(args.intentId);
    const action = await ctx.db.get(args.actionId);
    if (!intent || !action || intent.actionId !== args.actionId || intent.status !== "approval_dispatching" || intent.leaseGeneration !== args.leaseGeneration) return { ignored: true as const };
    const order = await ctx.db.get(intent.orderId);
    if (!order || !hasValidSandboxCjApprovalBinding({ actionId: args.actionId, action, order })) return needsAttention(ctx, intent, "approval_binding_invalid", args.actionId);
    if (action.approvalDispatchKey !== args.approvalDispatchKey || (action.status !== "approved" && action.status !== "rejected")) return { ignored: true as const };
    await ctx.db.patch(intent._id, { status: "approval_resolved", leaseExpiresAt: undefined, runnableAt: undefined, updatedAt: Date.now() });
    return { ignored: false as const, state: "resolved" as const };
  },
});

/** Scheduled workers only need stable due IDs; no customer fields cross this query boundary. */
export const listDueCjStagingIntents = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    await requireServiceIdentity(ctx);
    const now = Date.now();
    const cap = Math.max(1, Math.min(limit ?? 25, 100));
    // `runnableAt` is the sole runnable projection. Terminal transitions clear it, so this is
    // one bounded index read without a mixed page filtered after the fact.
    const rows = await ctx.db.query("cjStagingIntents")
      .withIndex("by_runnable_at", (q: any) => q.gt("runnableAt", 0).lte("runnableAt", now))
      .order("asc").take(cap);
    return rows.map(({ _id }) => ({ _id }));
  },
});

/** Classify a worker failure without serializing provider text or customer fields. */
export const recordCjStagingFailure = mutation({
  args: { intentId: v.id("cjStagingIntents"), expectedPhase: v.union(v.literal("preflighting"), v.literal("quoted"), v.literal("approval_dispatching")), expectedAttempt: v.number(), leaseGeneration: v.number(), errorCode: v.union(v.literal("invalid_or_unbound_input"), v.literal("invalid_verified_lineage"), v.literal("configuration_unavailable"), v.literal("provider_rate_limited"), v.literal("provider_unavailable"), v.literal("network_unavailable"), v.literal("unexpected_runtime_failure")), kind: v.union(v.literal("retryable"), v.literal("permanent")) },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const intent = await ctx.db.get(args.intentId);
    if (!intent || ["approval_dispatched", "approval_resolved", "needs_attention", "failed"].includes(intent.status) || intent.status !== args.expectedPhase || intent.attempt !== args.expectedAttempt || intent.leaseGeneration !== args.leaseGeneration) return { ignored: true as const };
    const now = Date.now();
    const failureCount = (intent.failureCount ?? intent.workerAttempt ?? 0) + 1;
    const transition = cjStagingFailureTransition(now, failureCount, args.kind, intent.status as CjStagingPhase);
    await ctx.db.patch(args.intentId, { status: transition.status, failureCount, runnableAt: transition.runnableAt, leaseExpiresAt: undefined, lastError: { code: args.errorCode }, updatedAt: now });
    await appendAudit(ctx, { siteId: intent.siteId, event: "cj_staging_failed", detail: { intentId: intent._id, code: args.errorCode, terminal: transition.status === "needs_attention", failureCount, maxAttempts: CJ_STAGING_MAX_ATTEMPTS } });
    return { ignored: false, status: transition.status, runnableAt: transition.runnableAt };
  },
});

const CJ_STAGING_ROLLOUT_VERSION = "lease-fencing-v2";
const CJ_STAGING_RUNNABLE_PHASES = ["pending", "preflight_required", "quoted", "staged", "preflighting", "approval_dispatching"] as const;

/** Bounded, resumable optional-field rollout. Completed versions perform no status-index reads. */
export const reconcileLegacyCjStagingIntents = mutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    await requireServiceIdentity(ctx);
    const now = Date.now();
    const cap = Math.max(1, Math.min(limit ?? 25, 100));
    let marker = await ctx.db.query("cjStagingRollouts").withIndex("by_version", (q: any) => q.eq("version", CJ_STAGING_ROLLOUT_VERSION)).first();
    if (!marker) {
      const markerId = await ctx.db.insert("cjStagingRollouts", { version: CJ_STAGING_ROLLOUT_VERSION, phase: 0, completed: false, updatedAt: now });
      marker = await ctx.db.get(markerId);
    }
    if (!marker || marker.completed) return { repaired: 0, completed: true as const };
    // One immutable creation-order cursor means a concurrent phase transition cannot jump over
    // a later status cursor. New writes already carry the fields, so completion has no fan-out.
    const page = await ctx.db.query("cjStagingIntents").withIndex("by_created_at").order("asc").paginate({ cursor: marker.cursor ?? null, numItems: cap });
    let repaired = 0;
    for (const intent of page.page) {
      if (CJ_STAGING_RUNNABLE_PHASES.includes(intent.status as any)) {
        const patch: Record<string, unknown> = {};
        if (intent.runnableAt === undefined) patch.runnableAt = legacyCjStagingRunnableAt(intent.status as CjStagingPhase, intent.leaseExpiresAt, now);
        if (intent.leaseGeneration === undefined) patch.leaseGeneration = 0;
        if (intent.failureCount === undefined) patch.failureCount = intent.workerAttempt ?? 0;
        if (Object.keys(patch).length) { patch.updatedAt = now; await ctx.db.patch(intent._id, patch); repaired++; }
      } else if (intent.runnableAt !== undefined) {
        await ctx.db.patch(intent._id, { runnableAt: undefined, leaseExpiresAt: undefined, updatedAt: now });
        repaired++;
      }
    }
    if (page.isDone) {
      await ctx.db.patch(marker._id, { cursor: undefined, completed: true, updatedAt: now });
    } else {
      await ctx.db.patch(marker._id, { cursor: page.continueCursor, updatedAt: now });
    }
    return { repaired, completed: page.isDone as boolean, phase: marker.phase };
  },
});

const CJ_DISPATCH_LEASE_MS = 10 * 60_000;
const CJ_RECONCILIATION_MAX = 5;
const dispatchReceipt = v.object({ executionId: v.id("cjDispatchExecutions"), actionId: v.id("actions"), orderId: v.id("orders"), inputHash: v.string(), generation: v.number(), generationFingerprint: v.string(), attempt: v.number(), triggerRunId: v.string(), leaseToken: v.string(), leaseVersion: v.number(), providerMode: v.literal("sandbox"), providerIdentity: v.string() });

function dispatchKey(order: any, actionId: any, attempt: number) {
  return `cj:sandbox:create:${actionId}:${order._id}:${order.cjOrderInputHash}:${order.cjDispatchGeneration}:${order.cjDispatchGenerationFingerprint}:${attempt}`;
}
function receiptFor(execution: any) {
  return { executionId: execution._id, actionId: execution.actionId, orderId: execution.orderId, inputHash: execution.inputHash, generation: execution.generation, generationFingerprint: execution.generationFingerprint, attempt: execution.attempt, triggerRunId: execution.triggerRunId, leaseToken: execution.leaseToken, leaseVersion: execution.leaseVersion, providerMode: execution.providerMode, providerIdentity: execution.providerIdentity };
}
function hasExecutionReceipt(execution: any, receipt: any, actionId: any, orderId: any) {
  return !!execution && execution._id === receipt.executionId && execution.actionId === actionId && execution.orderId === orderId
    && execution.actionId === receipt.actionId && execution.orderId === receipt.orderId && execution.inputHash === receipt.inputHash
    && execution.generation === receipt.generation && execution.generationFingerprint === receipt.generationFingerprint && execution.attempt === receipt.attempt
    && execution.triggerRunId === receipt.triggerRunId && execution.leaseToken === receipt.leaseToken && execution.leaseVersion === receipt.leaseVersion
    && execution.providerMode === receipt.providerMode && execution.providerIdentity === receipt.providerIdentity;
}
async function settleExecution(ctx: any, execution: any, order: any, action: any, input: { phase: "sent" | "pre_provider_failed" | "reconciliation_required" | "needs_attention"; cjOrderId?: string; code?: string; event: string }) {
  const now = Date.now();
  const delivered = input.phase === "sent";
  const terminal = input.phase === "sent" || input.phase === "pre_provider_failed" || input.phase === "needs_attention";
  if (!execution.outboxId) throw new Error("sandbox execution outbox is missing");
  const outbox = await ctx.db.get(execution.outboxId) as any;
  if (!outbox || outbox.siteId !== order.siteId || outbox.kind !== "cj.sandbox.create_order" || outbox.target !== `cj:sandbox:${order._id}`
    || outbox.idempotencyKey !== execution.idempotencyKey || outbox.traceId !== execution.traceId
    || outbox.payload?.executionId !== execution._id || outbox.payload?.actionId !== execution.actionId || outbox.payload?.orderId !== execution.orderId
    || outbox.payload?.orderNumber !== execution.orderNumber || outbox.payload?.inputHash !== execution.inputHash || outbox.payload?.generation !== execution.generation
    || outbox.payload?.generationFingerprint !== execution.generationFingerprint || outbox.payload?.attempt !== execution.attempt
    || outbox.payload?.providerMode !== execution.providerMode || outbox.payload?.providerIdentity !== execution.providerIdentity || outbox.payload?.isSandbox !== 1 || outbox.payload?.payType !== 3) {
    throw new Error("sandbox execution outbox binding is invalid");
  }
  const trace = await ctx.db.query("traces").withIndex("by_trace_id", (q: any) => q.eq("traceId", execution.traceId)).first();
  if (!trace || trace.siteId !== order.siteId || trace.operation !== "cj.sandbox.create_order" || trace.target !== `cj:sandbox:${order._id}` || trace.idempotencyKey !== execution.idempotencyKey) throw new Error("sandbox execution trace binding is invalid");
  // Ambiguity is deliberately nonterminal: preserve the same receipt and make it runnable for
  // read-only reconciliation. No trace is finished and no replacement outbox is minted.
  const reconciling = input.phase === "reconciliation_required";
  await ctx.db.patch(outbox._id, { status: delivered ? "delivered" : reconciling ? "ambiguous" : "failed", deliveredAt: delivered ? now : undefined, lastError: delivered ? undefined : input.code, availableAt: reconciling ? (execution.nextReconcileAt ?? now) : now });
  await ctx.db.patch(execution._id, { phase: input.phase, cjOrderId: input.cjOrderId ?? execution.cjOrderId, leaseExpiresAt: terminal ? now : execution.leaseExpiresAt, nextReconcileAt: terminal ? undefined : execution.nextReconcileAt, reconciliationScheduleLeaseExpiresAt: terminal ? undefined : execution.reconciliationScheduleLeaseExpiresAt, updatedAt: now });
  await ctx.db.patch(trace._id, { status: delivered ? "succeeded" : reconciling ? "reconciling" : "failed", detail: delivered ? { orderId: order._id, cjOrderId: input.cjOrderId, isSandbox: 1, payType: 3 } : { code: input.code, reconciliationRequired: reconciling }, finishedAt: terminal ? now : undefined });
  if (input.phase === "sent") {
    await ctx.db.patch(order._id, { cjOrderId: input.cjOrderId, cjOrderNumber: order.cjOrderInput.orderNumber, cjDispatchStatus: "sent", fulfillmentStatus: "sent_to_cj" });
    await ctx.db.patch(action._id, { status: "executed", resolvedAt: now });
  } else if (input.phase === "pre_provider_failed") {
    await ctx.db.patch(order._id, { cjDispatchStatus: "staged" });
  } else if (input.phase === "needs_attention") {
    await ctx.db.patch(order._id, { cjDispatchStatus: "ambiguous" });
  } else {
    await ctx.db.patch(order._id, { cjDispatchStatus: "ambiguous" });
  }
  await appendAudit(ctx, { siteId: order.siteId, actionId: action._id, event: input.event, detail: { orderId: order._id, executionId: execution._id, code: input.code, isSandbox: 1 } });
}

/** Creates the execution, outbox, trace and audit in one transaction; replay returns this exact receipt. */
export const claimSandboxCjDispatch = mutation({
  args: { actionId: v.id("actions"), triggerRunId: v.string(), leaseToken: v.string() },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const now = Date.now();
    const action = await ctx.db.get(args.actionId);
    const order = action && typeof (action.params as any)?.orderId === "string" ? await ctx.db.get((action.params as any).orderId) as any : null;
    if (!action || !order || !hasValidSandboxCjApprovalBinding({ actionId: args.actionId, action, order })) throw new Error("CJ approval binding is invalid");
    const byRun = await ctx.db.query("cjDispatchExecutions").withIndex("by_action_run", (q: any) => q.eq("actionId", args.actionId).eq("triggerRunId", args.triggerRunId)).first();
    if (byRun) {
      if (byRun.leaseToken !== args.leaseToken) throw new Error("sandbox execution run token is invalid");
      if (byRun.phase === "sent") return { state: "reused" as const, orderId: order._id, orderNumber: order.cjOrderInput.orderNumber, cjOrderId: byRun.cjOrderId };
      if (byRun.phase === "prepared") {
        if (byRun.leaseExpiresAt <= now) { await ctx.db.patch(byRun._id, { leaseVersion: byRun.leaseVersion + 1, leaseExpiresAt: now + CJ_DISPATCH_LEASE_MS, updatedAt: now }); const renewed = { ...byRun, leaseVersion: byRun.leaseVersion + 1 }; return { state: "prepared" as const, siteId: order.siteId, orderId: order._id, orderNumber: order.cjOrderInput.orderNumber, receipt: receiptFor(renewed), cjInput: order.cjOrderInput }; }
        return { state: "prepared" as const, siteId: order.siteId, orderId: order._id, orderNumber: order.cjOrderInput.orderNumber, receipt: receiptFor(byRun), cjInput: order.cjOrderInput };
      }
      if (byRun.phase === "provider_calling" || byRun.phase === "reconciliation_required") return { state: "reconcile_required" as const, siteId: order.siteId, orderId: order._id, orderNumber: order.cjOrderInput.orderNumber, receipt: receiptFor(byRun) };
      return { state: "blocked" as const, orderId: order._id, orderNumber: order.cjOrderInput.orderNumber };
    }
    if (action.status === "executed" && order.cjOrderId) return { state: "reused" as const, orderId: order._id, orderNumber: order.cjOrderInput.orderNumber, cjOrderId: order.cjOrderId };
    if (action.status !== "approved") throw new Error("CJ sandbox dispatch needs its exact approved action");
    // The order pointer is the current authority. Old rows without one are recovered by an
    // indexed descending first() read exactly once; historical attempts are never collected on
    // this hot path.
    let existing = order.cjDispatchExecutionId ? await ctx.db.get(order.cjDispatchExecutionId) as any : null;
    if (!existing) {
      existing = await ctx.db.query("cjDispatchExecutions").withIndex("by_order_updated_at", (q: any) => q.eq("orderId", order._id)).order("desc").first();
      if (existing) await ctx.db.patch(order._id, { cjDispatchExecutionId: existing._id });
    }
    if (existing && ["prepared", "provider_calling", "reconciliation_required"].includes(existing.phase)) {
      if (existing.phase === "prepared" && existing.leaseExpiresAt <= now) {
        await settleExecution(ctx, existing, order, action, { phase: "pre_provider_failed", code: "prepared_lease_expired", event: "cj_sandbox_dispatch_pre_provider_failed" });
      } else if ((existing.phase === "provider_calling" && existing.leaseExpiresAt <= now)
        || (existing.phase === "reconciliation_required" && (existing.leaseExpiresAt <= now || (existing.nextReconcileAt !== undefined && existing.nextReconcileAt <= now)))) {
        // An expired provider call, or a due read reconciliation, can only be read, never
        // recreated. Do not revoke a live provider-call lease merely because another Trigger
        // run arrived: its old receipt remains valid until the durable fence says otherwise.
        await ctx.db.patch(existing._id, { phase: "reconciliation_required", triggerRunId: args.triggerRunId, leaseToken: args.leaseToken, leaseVersion: existing.leaseVersion + 1, leaseExpiresAt: now + CJ_DISPATCH_LEASE_MS, nextReconcileAt: existing.nextReconcileAt ?? now, updatedAt: now });
        const transferred = { ...existing, phase: "reconciliation_required", triggerRunId: args.triggerRunId, leaseToken: args.leaseToken, leaseVersion: existing.leaseVersion + 1 };
        return { state: "reconcile_required" as const, siteId: order.siteId, orderId: order._id, orderNumber: order.cjOrderInput.orderNumber, receipt: receiptFor(transferred) };
      } else return { state: "blocked" as const, orderId: order._id, orderNumber: order.cjOrderInput.orderNumber };
    }
    // Attention is a terminal human decision point. It is deliberately not a retryable
    // pre-provider failure: creating a later execution here could turn an ambiguous provider
    // consequence into a second supplier order.
    if (existing?.phase === "needs_attention") {
      return { state: "blocked" as const, orderId: order._id, orderNumber: order.cjOrderInput.orderNumber };
    }
    const attempt = (order.cjDispatchAttempt ?? 0) + 1;
    const idempotencyKey = dispatchKey(order, args.actionId, attempt);
    const traceId = idempotencyKey;
    const executionId = await ctx.db.insert("cjDispatchExecutions", { siteId: order.siteId, actionId: args.actionId, orderId: order._id, orderNumber: order.cjOrderInput.orderNumber, inputHash: order.cjOrderInputHash!, generation: order.cjDispatchGeneration!, generationFingerprint: order.cjDispatchGenerationFingerprint!, attempt, triggerRunId: args.triggerRunId, leaseToken: args.leaseToken, leaseVersion: 1, providerMode: "sandbox", providerIdentity: order.cjOrderInput.orderNumber, phase: "prepared", idempotencyKey, traceId, leaseExpiresAt: now + CJ_DISPATCH_LEASE_MS, reconciliationCount: 0, reconciliationMax: CJ_RECONCILIATION_MAX, reconciliationScheduleGeneration: 0, createdAt: now, updatedAt: now });
    const outboxId = await ctx.db.insert("outbox", { siteId: order.siteId, kind: "cj.sandbox.create_order", target: `cj:sandbox:${order._id}`, idempotencyKey, traceId, payload: { executionId, actionId: args.actionId, orderId: order._id, orderNumber: order.cjOrderInput.orderNumber, inputHash: order.cjOrderInputHash, generation: order.cjDispatchGeneration, generationFingerprint: order.cjDispatchGenerationFingerprint, attempt, providerMode: "sandbox", providerIdentity: order.cjOrderInput.orderNumber, isSandbox: 1, payType: 3 }, status: "pending", attempts: 0, availableAt: now, createdAt: now });
    await ctx.db.insert("traces", { traceId, siteId: order.siteId, operation: "cj.sandbox.create_order", target: `cj:sandbox:${order._id}`, idempotencyKey, status: "started", detail: { executionId, isSandbox: 1 }, startedAt: now });
    await ctx.db.patch(executionId, { outboxId });
    await ctx.db.patch(order._id, { cjDispatchStatus: "reserved", cjDispatchAttempt: attempt, cjDispatchExecutionId: executionId });
    await appendAudit(ctx, { siteId: order.siteId, actionId: args.actionId, event: "cj_sandbox_dispatch_prepared", detail: { orderId: order._id, executionId, isSandbox: 1 } });
    const execution = await ctx.db.get(executionId);
    return { state: "prepared" as const, siteId: order.siteId, orderId: order._id, orderNumber: order.cjOrderInput.orderNumber, receipt: receiptFor(execution), cjInput: order.cjOrderInput };
  },
});

/** The only mutation that permits the provider boundary; it fences execution, order, outbox and trace together. */
export const beginSandboxCjProviderCall = mutation({
  args: { actionId: v.id("actions"), orderId: v.id("orders"), receipt: dispatchReceipt },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx); const now = Date.now();
    const [execution, order, action] = await Promise.all([ctx.db.get(args.receipt.executionId), ctx.db.get(args.orderId), ctx.db.get(args.actionId)]);
    if (!execution || !order || !action || !hasExecutionReceipt(execution, args.receipt, args.actionId, args.orderId) || !hasCurrentSandboxCjDispatchReceipt({ receipt: args.receipt, actionId: args.actionId, orderId: args.orderId, action, order })) return { ignored: true as const };
    if (execution.phase !== "prepared" || execution.leaseExpiresAt <= now || action.status !== "approved") return { ignored: true as const };
    if (!execution.outboxId) throw new Error("sandbox execution outbox is missing");
    const outbox = await ctx.db.get(execution.outboxId) as any; const trace = await ctx.db.query("traces").withIndex("by_trace_id", (q: any) => q.eq("traceId", execution.traceId)).first();
    if (!outbox || !trace || outbox.idempotencyKey !== execution.idempotencyKey || trace.idempotencyKey !== execution.idempotencyKey) throw new Error("sandbox execution receipt binding is invalid");
    await ctx.db.patch(execution._id, { phase: "provider_calling", updatedAt: now });
    await ctx.db.patch(outbox._id, { status: "processing", attempts: outbox.attempts + 1, availableAt: now, lastError: undefined });
    await ctx.db.patch(trace._id, { status: "started", detail: { executionId: execution._id, providerBoundary: "entered", isSandbox: 1 } });
    await appendAudit(ctx, { siteId: order.siteId, actionId: args.actionId, event: "cj_sandbox_provider_calling", detail: { orderId: order._id, executionId: execution._id } });
    return { ignored: false as const };
  },
});

/**
 * Fences the read-only reconciliation boundary before Trigger contacts CJ.  In particular, a
 * delayed Trigger delivery must not perform a provider lookup before its exact receipt is due
 * and leased.  This mutation has no provider side effect and is safe to replay after its
 * response is lost.
 */
export const beginSandboxCjDispatchReconciliation = mutation({
  args: { actionId: v.id("actions"), orderId: v.id("orders"), receipt: dispatchReceipt },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const now = Date.now();
    const loaded = await loadFencedExecution(ctx, args);
    if (!loaded) return { ready: false as const };
    const { execution, action } = loaded;
    if (action.status !== "approved" || (execution.phase !== "provider_calling" && execution.phase !== "reconciliation_required")) return { ready: false as const };
    if (execution.leaseExpiresAt <= now || (execution.nextReconcileAt !== undefined && execution.nextReconcileAt > now)) {
      return { ready: false as const, ...(execution.nextReconcileAt !== undefined ? { nextReconcileAt: execution.nextReconcileAt } : {}) };
    }
    return { ready: true as const };
  },
});

async function loadFencedExecution(ctx: any, args: any) {
  const [execution, order, action] = await Promise.all([ctx.db.get(args.receipt.executionId), ctx.db.get(args.orderId), ctx.db.get(args.actionId)]);
  if (!execution || !order || !action || !hasExecutionReceipt(execution, args.receipt, args.actionId, args.orderId)
    || !hasCurrentSandboxCjDispatchReceipt({ receipt: args.receipt, actionId: args.actionId, orderId: args.orderId, action, order })) return null;
  return { execution, order, action };
}

export const completeSandboxCjDispatchExecution = mutation({
  args: { actionId: v.id("actions"), orderId: v.id("orders"), cjOrderId: v.string(), receipt: dispatchReceipt },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const loaded = await loadFencedExecution(ctx, args); if (!loaded) return { ignored: true as const };
    const { execution, order, action } = loaded;
    if (execution.phase === "sent" && execution.cjOrderId === args.cjOrderId) return { ignored: false as const, reused: true };
    if (execution.phase !== "provider_calling" || action.status !== "approved") return { ignored: true as const };
    await settleExecution(ctx, execution, order, action, { phase: "sent", cjOrderId: args.cjOrderId, event: "cj_sandbox_dispatch_sent" });
    return { ignored: false as const, reused: false };
  },
});

export const failSandboxCjDispatchBeforeProvider = mutation({
  args: { actionId: v.id("actions"), orderId: v.id("orders"), reason: v.string(), receipt: dispatchReceipt },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const loaded = await loadFencedExecution(ctx, args); if (!loaded) return { ignored: true as const };
    if (loaded.execution.phase !== "prepared" || loaded.action.status !== "approved") return { ignored: true as const };
    await settleExecution(ctx, loaded.execution, loaded.order, loaded.action, { phase: "pre_provider_failed", code: args.reason.slice(0, 120), event: "cj_sandbox_dispatch_pre_provider_failed" });
    return { ignored: false as const };
  },
});

/**
 * The only post-boundary rejection transition. `rejection` is intentionally a closed
 * adapter-derived vocabulary: ambiguous responses cannot select this retryable path.
 */
export const rejectSandboxCjDispatchAfterDefinitiveProviderRejection = mutation({
  args: {
    actionId: v.id("actions"), orderId: v.id("orders"), receipt: dispatchReceipt,
    rejection: v.union(
      v.literal("invalid_request"),
      v.literal("invalid_credentials"),
      v.literal("sandbox_not_permitted"),
      v.literal("provider_resource_missing"),
      v.literal("invalid_order"),
    ),
  },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const loaded = await loadFencedExecution(ctx, args); if (!loaded) return { ignored: true as const };
    if (loaded.execution.phase !== "provider_calling" || loaded.action.status !== "approved") return { ignored: true as const };
    await settleExecution(ctx, loaded.execution, loaded.order, loaded.action, {
      phase: "pre_provider_failed", code: args.rejection, event: "cj_sandbox_dispatch_provider_rejected",
    });
    return { ignored: false as const };
  },
});

export const markSandboxCjDispatchAmbiguousExecution = mutation({
  args: { actionId: v.id("actions"), orderId: v.id("orders"), reason: v.string(), receipt: dispatchReceipt },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const loaded = await loadFencedExecution(ctx, args); if (!loaded) return { ignored: true as const };
    if (loaded.execution.phase === "sent") return { ignored: false as const, reused: true };
    if (loaded.execution.phase !== "provider_calling") return { ignored: true as const };
    const now = Date.now();
    await ctx.db.patch(loaded.execution._id, { phase: "reconciliation_required", nextReconcileAt: now, lastReconcileResult: undefined, updatedAt: now });
    await settleExecution(ctx, { ...loaded.execution, nextReconcileAt: now }, loaded.order, loaded.action, { phase: "reconciliation_required", code: args.reason.slice(0, 120), event: "cj_sandbox_dispatch_ambiguous" });
    return { ignored: false as const, reused: false, nextReconcileAt: now };
  },
});

/** A read-only provider lookup can settle exactly once, schedule exponential backoff, or expose attention. */
export const reconcileSandboxCjDispatchExecution = mutation({
  args: { actionId: v.id("actions"), orderId: v.id("orders"), receipt: dispatchReceipt, lookup: v.optional(v.object({ orderId: v.string(), orderNumber: v.string(), isSandbox: v.union(v.literal(1), v.literal(true)) })) },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx); const now = Date.now();
    const loaded = await loadFencedExecution(ctx, args); if (!loaded) return { state: "ignored" as const };
    const { execution, order, action } = loaded;
    if (execution.phase === "sent") return { state: "found" as const, reused: true };
    if (execution.phase !== "provider_calling" && execution.phase !== "reconciliation_required") return { state: "ignored" as const };
    if (execution.leaseExpiresAt <= now || (execution.nextReconcileAt !== undefined && execution.nextReconcileAt > now)) return { state: "ignored" as const };
    if (args.lookup) {
      if (args.lookup.orderNumber !== execution.providerIdentity || args.lookup.isSandbox !== 1) {
        await settleExecution(ctx, execution, order, action, { phase: "needs_attention", code: "provider_identity_mismatch", event: "cj_sandbox_dispatch_needs_attention" });
        return { state: "needs_attention" as const };
      }
      await settleExecution(ctx, execution, order, action, { phase: "sent", cjOrderId: args.lookup.orderId, event: "cj_sandbox_dispatch_reconciled" });
      await ctx.db.patch(execution._id, { lastReconcileResult: "found" });
      return { state: "found" as const };
    }
    const count = execution.reconciliationCount + 1;
    if (count >= execution.reconciliationMax) {
      await ctx.db.patch(execution._id, { reconciliationCount: count, lastReconcileResult: "exhausted" });
      await settleExecution(ctx, { ...execution, reconciliationCount: count }, order, action, { phase: "needs_attention", code: "reconciliation_budget_exhausted", event: "cj_sandbox_dispatch_needs_attention" });
      return { state: "needs_attention" as const };
    }
    const nextReconcileAt = now + Math.min(60 * 60_000, 60_000 * (2 ** (count - 1)));
    const scheduled = { ...execution, phase: "reconciliation_required", reconciliationCount: count, nextReconcileAt, lastReconcileResult: "absent", reconciliationScheduleLeaseExpiresAt: undefined };
    await ctx.db.patch(execution._id, { phase: "reconciliation_required", reconciliationCount: count, nextReconcileAt, lastReconcileResult: "absent", reconciliationScheduleLeaseExpiresAt: undefined, updatedAt: now });
    await settleExecution(ctx, scheduled, order, action, { phase: "reconciliation_required", code: "provider_lookup_absent", event: "cj_sandbox_dispatch_reconciliation_scheduled" });
    return { state: "scheduled" as const, nextReconcileAt };
  },
});

const CJ_RECONCILIATION_SCHEDULE_LEASE_MS = 5 * 60_000;

/** Bounded, indexed recovery projection. The execution row remains the scheduling authority. */
export const listDueSandboxCjDispatchReconciliations = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const now = Date.now();
    const cap = Math.max(1, Math.min(args.limit ?? 25, 100));
    const due = await ctx.db.query("cjDispatchExecutions")
      .withIndex("by_phase_next_reconcile", (q: any) => q.eq("phase", "reconciliation_required").lte("nextReconcileAt", now))
      .take(cap);
    // The sweeper has no provider, order, or lease capability: it only needs this opaque row ID
    // to claim the next durable schedule generation.
    return due.map((execution) => ({ executionId: execution._id }));
  },
});

/**
 * Claims one immutable Trigger scheduling generation. A lost Trigger response leaves this
 * lease behind; once it expires a sweeper may replay a newer generation, while all resulting
 * deliveries remain restricted to the read-only reconciliation branch.
 */
export const claimDueSandboxCjDispatchReconciliationSchedule = mutation({
  args: { executionId: v.id("cjDispatchExecutions") },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const now = Date.now();
    const execution = await ctx.db.get(args.executionId) as any;
    if (!execution || execution.phase !== "reconciliation_required" || execution.nextReconcileAt === undefined || execution.nextReconcileAt > now) return { state: "ignored" as const };
    const order = await ctx.db.get(execution.orderId) as any;
    if (!order) return { state: "ignored" as const };
    if (order.cjDispatchExecutionId !== execution._id) {
      // Compatibility for rows created before the pointer rollout: one bounded indexed latest
      // read adopts only this exact current row, never a historical attempt.
      const latest = await ctx.db.query("cjDispatchExecutions").withIndex("by_order_updated_at", (q: any) => q.eq("orderId", execution.orderId)).order("desc").first();
      if (!latest || latest._id !== execution._id) return { state: "ignored" as const };
      await ctx.db.patch(order._id, { cjDispatchExecutionId: execution._id });
    }
    if (execution.reconciliationScheduleLeaseExpiresAt !== undefined && execution.reconciliationScheduleLeaseExpiresAt > now) return { state: "busy" as const };
    const generation = execution.reconciliationScheduleGeneration + 1;
    await ctx.db.patch(execution._id, { reconciliationScheduleGeneration: generation, reconciliationScheduleLeaseExpiresAt: now + CJ_RECONCILIATION_SCHEDULE_LEASE_MS, updatedAt: now });
    await appendAudit(ctx, { siteId: execution.siteId, actionId: execution.actionId, event: "cj_sandbox_dispatch_reconciliation_handoff", detail: { orderId: execution.orderId, executionId: execution._id, generation } });
    return { state: "scheduled" as const, executionId: execution._id, actionId: execution.actionId, generation, nextReconcileAt: execution.nextReconcileAt };
  },
});

/** Same durable handoff, but only the exact current execution receipt may request it inline. */
export const claimSandboxCjDispatchReconciliationSchedule = mutation({
  args: { actionId: v.id("actions"), orderId: v.id("orders"), receipt: dispatchReceipt },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const loaded = await loadFencedExecution(ctx, args);
    if (!loaded || loaded.execution.phase !== "reconciliation_required") return { state: "ignored" as const };
    // Delegate only after exact receipt validation; duplicate code deliberately mirrors the due
    // claim because Convex mutations cannot invoke another public mutation transactionally.
    const now = Date.now(); const execution = loaded.execution;
    if (execution.nextReconcileAt === undefined) return { state: "ignored" as const };
    if (execution.reconciliationScheduleLeaseExpiresAt !== undefined && execution.reconciliationScheduleLeaseExpiresAt > now) return { state: "busy" as const };
    const generation = execution.reconciliationScheduleGeneration + 1;
    await ctx.db.patch(execution._id, { reconciliationScheduleGeneration: generation, reconciliationScheduleLeaseExpiresAt: now + CJ_RECONCILIATION_SCHEDULE_LEASE_MS, updatedAt: now });
    await appendAudit(ctx, { siteId: execution.siteId, actionId: execution.actionId, event: "cj_sandbox_dispatch_reconciliation_handoff", detail: { orderId: execution.orderId, executionId: execution._id, generation } });
    return { state: "scheduled" as const, executionId: execution._id, actionId: execution.actionId, generation, nextReconcileAt: execution.nextReconcileAt };
  },
});

// Apply tracking from the CJ ORDER webhook. CJ orderNumber is a dedicated indexed identity,
// never a Shopify id; this prevents an arbitrary provider value mapping another order.
export const applyTracking = mutation({
  args: {
    siteId: v.id("sites"),
    cjOrderNumber: v.string(),
    trackingNumber: v.optional(v.string()),
    trackingUrl: v.optional(v.string()),
    cjOrderId: v.optional(v.string()),
    status: v.optional(fulfillmentStatus),
  },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const order = await ctx.db
      .query("orders")
      .withIndex("by_site_cj_order_number", (q) => q.eq("siteId", args.siteId).eq("cjOrderNumber", args.cjOrderNumber))
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
      detail: { orderId: order._id },
    });
    return order._id;
  },
});

export const getByShopifyOrder = query({
  args: { siteId: v.id("sites"), shopifyOrderId: v.string() },
  handler: async (ctx, { siteId, shopifyOrderId }) => {
    return ctx.db
      .query("orders")
      .withIndex("by_site_shopify_order", (q) => q.eq("siteId", siteId).eq("shopifyOrderId", shopifyOrderId))
      .first();
  },
});

export const getByCjOrderNumber = query({
  args: { siteId: v.id("sites"), cjOrderNumber: v.string() },
  handler: async (ctx, { siteId, cjOrderNumber }) => ctx.db.query("orders")
    .withIndex("by_site_cj_order_number", (q) => q.eq("siteId", siteId).eq("cjOrderNumber", cjOrderNumber)).first(),
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
