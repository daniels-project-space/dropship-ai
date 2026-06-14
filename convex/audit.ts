// Append-only audit ledger. Every proposed/approved/rejected/executed action lands here.
// No deletes, ever. Index-driven reads only (by_site_at).
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

// Internal helper reused by other mutations (sites/actions/products) so audit writes stay consistent.
export async function appendAudit(
  ctx: MutationCtx,
  args: { siteId: Id<"sites">; event: string; detail?: unknown; actionId?: Id<"actions"> },
): Promise<Id<"auditLog">> {
  return ctx.db.insert("auditLog", {
    siteId: args.siteId,
    actionId: args.actionId,
    event: args.event,
    detail: args.detail ?? {},
    at: Date.now(),
  });
}

export const append = mutation({
  args: {
    siteId: v.id("sites"),
    event: v.string(),
    detail: v.optional(v.any()),
    actionId: v.optional(v.id("actions")),
  },
  handler: async (ctx, args) => {
    return appendAudit(ctx, args);
  },
});

export const listBySite = query({
  args: { siteId: v.id("sites"), limit: v.optional(v.number()) },
  handler: async (ctx, { siteId, limit }) => {
    return ctx.db
      .query("auditLog")
      .withIndex("by_site_at", (q) => q.eq("siteId", siteId))
      .order("desc")
      .take(limit ?? 100);
  },
});
