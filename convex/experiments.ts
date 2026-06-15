// CRO experiments reads. Index-driven (by_site_status).
import { query } from "./_generated/server";
import { v } from "convex/values";

const expStatus = v.union(v.literal("running"), v.literal("concluded"));

export const listBySite = query({
  args: { siteId: v.id("sites"), status: v.optional(expStatus), limit: v.optional(v.number()) },
  handler: async (ctx, { siteId, status, limit }) => {
    if (status) {
      return ctx.db
        .query("experiments")
        .withIndex("by_site_status", (q) => q.eq("siteId", siteId).eq("status", status))
        .order("desc")
        .take(limit ?? 100);
    }
    return ctx.db
      .query("experiments")
      .withIndex("by_site_status", (q) => q.eq("siteId", siteId))
      .order("desc")
      .take(limit ?? 100);
  },
});
