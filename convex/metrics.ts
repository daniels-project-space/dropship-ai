// Conversion metrics reads (daily rollups). Index-driven only (by_site_day / by_product_day).
import { query } from "./authz";
import { v } from "convex/values";

export const listBySite = query({
  args: { siteId: v.id("sites"), limit: v.optional(v.number()) },
  handler: async (ctx, { siteId, limit }) => {
    // by_site_day index → already day-ordered; take newest N.
    return ctx.db
      .query("conversionMetrics")
      .withIndex("by_site_day", (q) => q.eq("siteId", siteId))
      .order("desc")
      .take(limit ?? 60);
  },
});

export const listByProduct = query({
  args: { productId: v.id("products"), limit: v.optional(v.number()) },
  handler: async (ctx, { productId, limit }) => {
    return ctx.db
      .query("conversionMetrics")
      .withIndex("by_product_day", (q) => q.eq("productId", productId))
      .order("desc")
      .take(limit ?? 60);
  },
});
