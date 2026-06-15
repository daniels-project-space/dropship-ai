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

// Cross-site recent activity for the portfolio strip. Walks each site's ledger
// via by_site_at (index-scoped), merges and returns the newest N with site names.
export const listRecent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const cap = limit ?? 24;
    const sites = await ctx.db.query("sites").take(200);
    const out: Array<{
      _id: string;
      event: string;
      detail: unknown;
      at: number;
      siteName: string;
      siteId: string;
    }> = [];
    for (const s of sites) {
      const rows = await ctx.db
        .query("auditLog")
        .withIndex("by_site_at", (q) => q.eq("siteId", s._id))
        .order("desc")
        .take(cap);
      for (const r of rows) {
        out.push({ _id: r._id, event: r.event, detail: r.detail, at: r.at, siteName: s.name, siteId: s._id });
      }
    }
    out.sort((a, b) => b.at - a.at);
    return out.slice(0, cap);
  },
});

// Cross-brand audit feed for the global Activity page. Index-driven (by_site_at per
// site), optionally scoped to ONE brand and/or ONE event type. `limit` doubles as a
// simple "load more" cursor (the page raises it) — there is no global by_at index, so
// we over-fetch per site, merge, sort newest-first and slice. Returns the slice plus a
// `hasMore` flag and the distinct event types present (for the filter dropdown).
export const listAll = query({
  args: {
    limit: v.optional(v.number()),
    siteId: v.optional(v.id("sites")),
    event: v.optional(v.string()),
  },
  handler: async (ctx, { limit, siteId, event }) => {
    const cap = Math.min(limit ?? 60, 500);
    // Over-fetch one extra so we can report hasMore without a second pass.
    const perSiteTake = cap + 1;

    const allSites = await ctx.db.query("sites").take(200);
    const sites = siteId ? allSites.filter((s) => s._id === siteId) : allSites;

    const merged: Array<{
      _id: string;
      event: string;
      detail: unknown;
      at: number;
      siteName: string;
      siteId: string;
    }> = [];
    const eventTypes = new Set<string>();

    for (const s of sites) {
      const rows = await ctx.db
        .query("auditLog")
        .withIndex("by_site_at", (q) => q.eq("siteId", s._id))
        .order("desc")
        .take(perSiteTake);
      for (const r of rows) {
        eventTypes.add(r.event);
        if (event && r.event !== event) continue;
        merged.push({ _id: r._id, event: r.event, detail: r.detail, at: r.at, siteName: s.name, siteId: s._id });
      }
    }
    merged.sort((a, b) => b.at - a.at);
    const page = merged.slice(0, cap);
    return {
      entries: page,
      hasMore: merged.length > cap,
      eventTypes: Array.from(eventTypes).sort(),
    };
  },
});
