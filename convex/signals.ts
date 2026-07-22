// Rolled-up product/trend signals. Daily buckets only (never raw-event spam).
import { query, mutation } from "./authz";
import { v } from "convex/values";

// Insert a daily-rollup signal point.
export const record = mutation({
  args: {
    siteId: v.id("sites"),
    source: v.string(),
    signalType: v.string(),
    value: v.number(),
    day: v.string(), // YYYY-MM-DD
    productId: v.optional(v.id("products")),
  },
  handler: async (ctx, args) => {
    return ctx.db.insert("productSignals", args);
  },
});

export const listByDay = query({
  args: { siteId: v.id("sites"), day: v.string() },
  handler: async (ctx, { siteId, day }) => {
    return ctx.db
      .query("productSignals")
      .withIndex("by_site_day", (q) => q.eq("siteId", siteId).eq("day", day))
      .collect();
  },
});

// Recent signals for a brand (newest day buckets first). Index-driven via by_site_day.
export const listBySite = query({
  args: { siteId: v.id("sites"), limit: v.optional(v.number()) },
  handler: async (ctx, { siteId, limit }) => {
    return ctx.db
      .query("productSignals")
      .withIndex("by_site_day", (q) => q.eq("siteId", siteId))
      .order("desc")
      .take(limit ?? 100);
  },
});

// Cross-brand signals for the global Research page. Optionally scoped to ONE brand.
// Index-driven per site (by_site_day), merged newest-first and tagged with siteName.
export const listAllAcrossBrands = query({
  args: { siteId: v.optional(v.id("sites")), limit: v.optional(v.number()) },
  handler: async (ctx, { siteId, limit }) => {
    const cap = limit ?? 100;
    const allSites = await ctx.db.query("sites").take(200);
    const sites = siteId ? allSites.filter((s) => s._id === siteId) : allSites;

    const out: Array<Record<string, unknown>> = [];
    for (const s of sites) {
      const rows = await ctx.db
        .query("productSignals")
        .withIndex("by_site_day", (q) => q.eq("siteId", s._id))
        .order("desc")
        .take(cap);
      for (const r of rows) out.push({ ...r, siteName: s.name });
    }
    out.sort((a, b) => String(b.day).localeCompare(String(a.day)));
    return out.slice(0, cap);
  },
});
