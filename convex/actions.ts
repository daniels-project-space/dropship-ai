// The brain's risk-tiered approval queue.
// auto         → inserted as "approved" (executes without a human)
// human_gated  → inserted as "pending_approval" (Trigger waitpoint + Daniel taps approve/reject)
// Every state transition appends to the audit ledger.
import { query, mutation } from "./authz";
import { v } from "convex/values";
import { appendAudit } from "./audit";

const riskTier = v.union(v.literal("auto"), v.literal("human_gated"));

export const propose = mutation({
  args: {
    siteId: v.id("sites"),
    type: v.string(),
    params: v.any(),
    riskTier,
    rationale: v.string(),
    confidence: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const status = args.riskTier === "human_gated" ? ("pending_approval" as const) : ("approved" as const);
    const actionId = await ctx.db.insert("actions", {
      siteId: args.siteId,
      type: args.type,
      params: args.params,
      riskTier: args.riskTier,
      status,
      rationale: args.rationale,
      confidence: args.confidence,
      proposedAt: Date.now(),
    });
    await appendAudit(ctx, {
      siteId: args.siteId,
      actionId,
      event: "action_proposed",
      detail: { type: args.type, riskTier: args.riskTier, status, rationale: args.rationale },
    });
    return { actionId, status };
  },
});

/**
 * Create the only approval action that can authorize a sourced Shopify draft import. The
 * commercial inputs are copied from the server-derived local draft, never from the browser.
 * A same evidence/product pair reuses its pending action so retries cannot create two approvals.
 */
export const proposeSourcedDraftImport = mutation({
  args: {
    siteId: v.id("sites"),
    productId: v.id("products"),
    evidenceId: v.id("cjEvidence"),
  },
  handler: async (ctx, args) => {
    const product = await ctx.db.get(args.productId);
    const evidence = await ctx.db.get(args.evidenceId);
    if (!product || product.siteId !== args.siteId || !evidence || evidence.siteId !== args.siteId) {
      throw new Error("sourced draft product and CJ evidence must belong to the selected site");
    }
    if (product.status !== "draft" || product.cjEvidenceId !== evidence._id || product.cjProductId !== evidence.cjProductId || product.cjVariantId !== evidence.cjVariantId) {
      throw new Error("sourced draft lineage does not match the selected CJ evidence");
    }
    const existing = await ctx.db
      .query("actions")
      .withIndex("by_site_status", (q) => q.eq("siteId", args.siteId))
      .filter((q) => q.eq(q.field("type"), "import_sourced_product"))
      .filter((q) => q.eq(q.field("params.productId"), args.productId))
      .filter((q) => q.eq(q.field("params.evidenceId"), args.evidenceId))
      .filter((q) => q.or(q.eq(q.field("status"), "pending_approval"), q.eq(q.field("status"), "approved"), q.eq(q.field("status"), "executing")))
      .first();
    if (existing) return { actionId: existing._id, status: existing.status, reused: true as const };

    const actionId = await ctx.db.insert("actions", {
      siteId: args.siteId,
      type: "import_sourced_product",
      params: {
        productId: product._id,
        evidenceId: evidence._id,
        cjProductId: product.cjProductId,
        cjVariantId: product.cjVariantId,
        priceUsd: product.priceUsd,
        cogsUsd: product.cogsUsd,
        shippingUsd: product.shippingUsd,
        landedCostUsd: product.landedCostUsd,
        contributionMarginPct: product.contributionMarginPct,
        sourceVerifiedAt: product.sourceVerifiedAt,
      },
      riskTier: "human_gated",
      status: "pending_approval",
      rationale: "Verified CJ evidence and server-derived contribution economics cleared the sourcing policy. Human approval can create one Shopify DRAFT only.",
      proposedAt: Date.now(),
    });
    await appendAudit(ctx, {
      siteId: args.siteId,
      actionId,
      event: "sourced_draft_import_proposed",
      detail: { productId: product._id, evidenceId: evidence._id, cjProductId: product.cjProductId, cjVariantId: product.cjVariantId, published: false },
    });
    return { actionId, status: "pending_approval" as const, reused: false as const };
  },
});

export const approve = mutation({
  args: { actionId: v.id("actions"), approver: v.optional(v.string()) },
  handler: async (ctx, { actionId, approver }) => {
    const action = await ctx.db.get(actionId);
    if (!action) throw new Error(`action ${actionId} not found`);
    if (action.status !== "pending_approval") {
      throw new Error(`action ${actionId} is ${action.status}, not pending_approval`);
    }
    await ctx.db.patch(actionId, { status: "approved", resolvedAt: Date.now() });
    await appendAudit(ctx, {
      siteId: action.siteId,
      actionId,
      event: "action_approved",
      detail: { approver: approver ?? "human" },
    });
    return actionId;
  },
});

export const reject = mutation({
  args: { actionId: v.id("actions"), reason: v.optional(v.string()), approver: v.optional(v.string()) },
  handler: async (ctx, { actionId, reason, approver }) => {
    const action = await ctx.db.get(actionId);
    if (!action) throw new Error(`action ${actionId} not found`);
    if (action.status !== "pending_approval") {
      throw new Error(`action ${actionId} is ${action.status}, not pending_approval`);
    }
    await ctx.db.patch(actionId, { status: "rejected", resolvedAt: Date.now() });
    await appendAudit(ctx, {
      siteId: action.siteId,
      actionId,
      event: "action_rejected",
      detail: { reason: reason ?? null, approver: approver ?? "human" },
    });
    return actionId;
  },
});

// Stamp the Trigger waitpoint token onto an action so the approval task can be resumed/audited.
export const setWaitpointToken = mutation({
  args: { actionId: v.id("actions"), waitpointToken: v.string() },
  handler: async (ctx, { actionId, waitpointToken }) => {
    const action = await ctx.db.get(actionId);
    if (!action) throw new Error(`action ${actionId} not found`);
    await ctx.db.patch(actionId, { waitpointToken });
    return actionId;
  },
});

// Called by the fulfillment/executor path once the action's side-effects have run.
export const markExecuted = mutation({
  args: { actionId: v.id("actions"), result: v.optional(v.any()), failed: v.optional(v.boolean()) },
  handler: async (ctx, { actionId, result, failed }) => {
    const action = await ctx.db.get(actionId);
    if (!action) throw new Error(`action ${actionId} not found`);
    const status = failed ? ("failed" as const) : ("executed" as const);
    await ctx.db.patch(actionId, { status, resolvedAt: Date.now() });
    await appendAudit(ctx, {
      siteId: action.siteId,
      actionId,
      event: failed ? "action_failed" : "action_executed",
      detail: { result: result ?? null },
    });
    return actionId;
  },
});

export const listPending = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db
      .query("actions")
      .withIndex("by_status", (q) => q.eq("status", "pending_approval"))
      .order("desc")
      .take(limit ?? 100);
    return rows.filter((action) => action.sample !== true);
  },
});

export const listBySite = query({
  args: {
    siteId: v.id("sites"),
    status: v.optional(
      v.union(
        v.literal("proposed"),
        v.literal("pending_approval"),
        v.literal("approved"),
        v.literal("rejected"),
        v.literal("executing"),
        v.literal("executed"),
        v.literal("failed"),
      ),
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { siteId, status, limit }) => {
    if (status) {
      return ctx.db
        .query("actions")
        .withIndex("by_site_status", (q) => q.eq("siteId", siteId).eq("status", status))
        .order("desc")
        .take(limit ?? 100);
    }
    return ctx.db
      .query("actions")
      .withIndex("by_site_status", (q) => q.eq("siteId", siteId))
      .order("desc")
      .take(limit ?? 100);
  },
});

export const get = query({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }) => ctx.db.get(actionId),
});

// Lightweight pending-approval count. Global (no siteId) or scoped to one brand.
// Index-driven: by_status globally, by_site_status when scoped.
export const pendingCount = query({
  args: { siteId: v.optional(v.id("sites")) },
  handler: async (ctx, { siteId }) => {
    const rows = siteId
      ? await ctx.db
          .query("actions")
          .withIndex("by_site_status", (q) => q.eq("siteId", siteId).eq("status", "pending_approval"))
          .take(500)
      : await ctx.db
          .query("actions")
          .withIndex("by_status", (q) => q.eq("status", "pending_approval"))
          .take(500);
    return rows.length;
  },
});
