// The brain's risk-tiered approval queue.
// auto         → inserted as "approved" (executes without a human)
// human_gated  → inserted as "pending_approval" (Trigger waitpoint + Daniel taps approve/reject)
// Every state transition appends to the audit ledger.
import { query, mutation } from "./authz";
import { v } from "convex/values";
import { appendAudit } from "./audit";
import { approvalDispatchDecision } from "../src/lib/sourceSelectionState";
import { projectActionTransition } from "./dashboardProjections";

const riskTier = v.union(v.literal("auto"), v.literal("human_gated"));

async function requireServiceIdentity(ctx: { auth: { getUserIdentity: () => Promise<{ subject?: string } | null> } }): Promise<void> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity?.subject !== "dropship-ai:service") throw new Error("UNAUTHENTICATED: action transitions require the service runtime");
}

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
    await projectActionTransition(ctx, null, (await ctx.db.get(actionId))!);
    await appendAudit(ctx, {
      siteId: args.siteId,
      actionId,
      event: "action_proposed",
      detail: { type: args.type, riskTier: args.riskTier, status, rationale: args.rationale },
    });
    return { actionId, status };
  },
});

export const approve = mutation({
  args: { actionId: v.id("actions"), approver: v.optional(v.string()) },
  handler: async (ctx, { actionId, approver }) => {
    await requireServiceIdentity(ctx);
    const action = await ctx.db.get(actionId);
    if (!action) throw new Error(`action ${actionId} not found`);
    if (action.status !== "pending_approval") {
      throw new Error(`action ${actionId} is ${action.status}, not pending_approval`);
    }
    await ctx.db.patch(actionId, { status: "approved", resolvedAt: Date.now() });
    await projectActionTransition(ctx, action, (await ctx.db.get(actionId))!);
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
    await requireServiceIdentity(ctx);
    const action = await ctx.db.get(actionId);
    if (!action) throw new Error(`action ${actionId} not found`);
    if (action.status !== "pending_approval") {
      throw new Error(`action ${actionId} is ${action.status}, not pending_approval`);
    }
    await ctx.db.patch(actionId, { status: "rejected", resolvedAt: Date.now() });
    await projectActionTransition(ctx, action, (await ctx.db.get(actionId))!);
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
  args: { actionId: v.id("actions"), waitpointToken: v.string(), approvalDispatchKey: v.string() },
  handler: async (ctx, { actionId, waitpointToken, approvalDispatchKey }) => {
    await requireServiceIdentity(ctx);
    const action = await ctx.db.get(actionId);
    if (!action) throw new Error(`action ${actionId} not found`);
    if (action.status !== "pending_approval" || action.approvalDispatchKey !== approvalDispatchKey) throw new Error("approval action is no longer pending for this dispatch");
    await ctx.db.patch(actionId, { waitpointToken });
    return actionId;
  },
});

/** Claim or reconcile a deterministic Trigger dispatch; never fail an approval merely because a request response was lost. */
export const beginApprovalDispatch = mutation({
  args: { actionId: v.id("actions"), approvalDispatchKey: v.string() },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const action = await ctx.db.get(args.actionId);
    if (!action) throw new Error(`action ${args.actionId} not found`);
    const dispatchDecision = approvalDispatchDecision({ actionStatus: action.status, dispatchStatus: action.approvalDispatchStatus, approvalRunId: action.approvalRunId });
    if (action.approvalDispatchKey !== args.approvalDispatchKey) throw new Error("approval dispatch key does not match this action");
    // An HTTP retry after the human has resolved the waitpoint must still return the same
    // workflow identity; it must not create or arm a replacement action.
    if (dispatchDecision === "reject") return { status: "resolved" as const, actionStatus: action.status, approvalRunId: action.approvalRunId };
    if (dispatchDecision === "already_dispatched") return { status: "dispatched" as const, approvalRunId: action.approvalRunId! };
    await ctx.db.patch(args.actionId, { approvalDispatchStatus: "dispatching" });
    const selection = await ctx.db.query("sourceSelections").withIndex("by_action", (q) => q.eq("actionId", args.actionId)).first();
    if (selection) await ctx.db.patch(selection._id, { approvalDispatchStatus: "dispatching" });
    return { status: "dispatching" as const };
  },
});

export const recordApprovalDispatch = mutation({
  args: { actionId: v.id("actions"), approvalDispatchKey: v.string(), approvalRunId: v.string() },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const action = await ctx.db.get(args.actionId);
    if (!action) throw new Error(`action ${args.actionId} not found`);
    if (action.approvalDispatchKey !== args.approvalDispatchKey) throw new Error("approval action is no longer pending for this dispatch");
    if (action.approvalRunId && action.approvalRunId !== args.approvalRunId) throw new Error("approval dispatch already has a different Trigger run");
    // Trigger can accept the deterministic run just before the human resolves the exact action.
    // Persist that same run/key lineage for reconciliation, but never revive the action or arm a
    // replacement waitpoint. A mismatched key/run still fails closed above.
    if (action.status !== "pending_approval" && action.status !== "approved" && action.status !== "rejected") throw new Error("approval action is no longer reconcilable for this dispatch");
    await ctx.db.patch(args.actionId, { approvalRunId: args.approvalRunId, approvalDispatchStatus: "dispatched" });
    const selection = await ctx.db.query("sourceSelections").withIndex("by_action", (q) => q.eq("actionId", args.actionId)).first();
    if (selection) await ctx.db.patch(selection._id, { approvalRunId: args.approvalRunId, approvalDispatchStatus: "dispatched" });
    return { status: action.status === "pending_approval" ? "dispatched" as const : "resolved" as const, approvalRunId: args.approvalRunId };
  },
});

export const markApprovalDispatchAmbiguous = mutation({
  args: { actionId: v.id("actions"), approvalDispatchKey: v.string(), error: v.string() },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const action = await ctx.db.get(args.actionId);
    if (!action || action.status !== "pending_approval" || action.approvalDispatchKey !== args.approvalDispatchKey) return { status: "ignored" as const };
    await ctx.db.patch(args.actionId, { approvalDispatchStatus: "ambiguous" });
    const selection = await ctx.db.query("sourceSelections").withIndex("by_action", (q) => q.eq("actionId", args.actionId)).first();
    if (selection) await ctx.db.patch(selection._id, { approvalDispatchStatus: "ambiguous" });
    await appendAudit(ctx, { siteId: action.siteId, actionId: args.actionId, event: "approval_dispatch_ambiguous", detail: { error: args.error, approvalDispatchKey: args.approvalDispatchKey } });
    return { status: "ambiguous" as const };
  },
});

/** Exact action/key check immediately before every Trigger waitpoint arm or re-arm. */
export const canArmApprovalWaitpoint = mutation({
  args: { actionId: v.id("actions"), approvalDispatchKey: v.string() },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const action = await ctx.db.get(args.actionId);
    return !!action && action.status === "pending_approval" && action.approvalDispatchKey === args.approvalDispatchKey;
  },
});

// Called by the fulfillment/executor path once the action's side-effects have run.
export const markExecuted = mutation({
  args: { actionId: v.id("actions"), result: v.optional(v.any()), failed: v.optional(v.boolean()) },
  handler: async (ctx, { actionId, result, failed }) => {
    await requireServiceIdentity(ctx);
    const action = await ctx.db.get(actionId);
    if (!action) throw new Error(`action ${actionId} not found`);
    const status = failed ? ("failed" as const) : ("executed" as const);
    await ctx.db.patch(actionId, { status, resolvedAt: Date.now() });
    await projectActionTransition(ctx, action, (await ctx.db.get(actionId))!);
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
        v.literal("superseded"),
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
