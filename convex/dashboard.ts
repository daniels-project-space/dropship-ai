// Control-plane portfolio view: every site + its pending-action / active-product counts.
// Index-driven only — counts come from .withIndex() reads, never full-table scans.
import { query } from "./_generated/server";
import { v } from "convex/values";

export const portfolio = query({
  args: {},
  handler: async (ctx) => {
    // Tenant set is small and bounded; cap defensively.
    const sites = await ctx.db.query("sites").order("desc").take(500);

    const rows = await Promise.all(
      sites.map(async (site) => {
        // pending approvals for this site — by_site_status index, scoped read.
        const pendingActions = await ctx.db
          .query("actions")
          .withIndex("by_site_status", (q) => q.eq("siteId", site._id).eq("status", "pending_approval"))
          .collect();

        const activeProducts = await ctx.db
          .query("products")
          .withIndex("by_site_status", (q) => q.eq("siteId", site._id).eq("status", "active"))
          .collect();

        const openOrders = await ctx.db
          .query("orders")
          .withIndex("by_site_status", (q) => q.eq("siteId", site._id).eq("fulfillmentStatus", "received"))
          .collect();

        return {
          siteId: site._id,
          name: site.name,
          niche: site.niche,
          status: site.status,
          distributionMode: site.distributionMode,
          shopifyDomain: site.shopifyDomain ?? null,
          customDomain: site.customDomain ?? null,
          killDate: site.killDate ?? null,
          pendingActionCount: pendingActions.length,
          activeProductCount: activeProducts.length,
          ordersAwaitingFulfillment: openOrders.length,
        };
      }),
    );

    return {
      siteCount: rows.length,
      totalPendingActions: rows.reduce((sum, r) => sum + r.pendingActionCount, 0),
      sites: rows,
    };
  },
});

// Single-site detail counts (drill-down). Same index-driven discipline.
export const siteSummary = query({
  args: { siteId: v.id("sites") },
  handler: async (ctx, { siteId }) => {
    const site = await ctx.db.get(siteId);
    if (!site) return null;

    const pending = await ctx.db
      .query("actions")
      .withIndex("by_site_status", (q) => q.eq("siteId", siteId).eq("status", "pending_approval"))
      .collect();
    const activeProducts = await ctx.db
      .query("products")
      .withIndex("by_site_status", (q) => q.eq("siteId", siteId).eq("status", "active"))
      .collect();

    return {
      site,
      pendingActionCount: pending.length,
      activeProductCount: activeProducts.length,
    };
  },
});
