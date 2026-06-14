// Rolled-up product/trend signals. Daily buckets only (never raw-event spam).
import { query, mutation } from "./_generated/server";
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
