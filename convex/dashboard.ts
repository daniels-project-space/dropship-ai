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

// ── Content-fit gate (the day-30 viability signal) ───────────────────────────
// "Has ANY post cleared 10k views in the trailing 30 days?" — the locked go/kill content
// signal. Returns the boolean + the single best-performing video so the operator can see the
// proof. Index-driven: walks each site's posts via by_site_status, no full-table scan.
const VIEW_THRESHOLD = 10_000;
const TRAILING_MS = 30 * 24 * 60 * 60 * 1000;

export const contentFitGate = query({
  args: { siteId: v.optional(v.id("sites")) },
  handler: async (ctx, { siteId }) => {
    const since = Date.now() - TRAILING_MS;
    const sites = siteId
      ? [await ctx.db.get(siteId)].filter((s): s is NonNullable<typeof s> => s !== null)
      : await ctx.db.query("sites").take(200);

    let best: {
      postId: string;
      siteId: string;
      siteName: string;
      platform: string;
      views: number;
      engagement: number;
      creativeId: string;
      r2Key: string | null;
      publishedAt: number | null;
    } | null = null;
    let totalPublished = 0;

    for (const s of sites) {
      // published posts for this site (by_site_status, scoped)
      const published = await ctx.db
        .query("posts")
        .withIndex("by_site_status", (q) => q.eq("siteId", s._id).eq("status", "published"))
        .order("desc")
        .take(500);
      for (const p of published) {
        const at = p.publishedAt ?? p._creationTime;
        if (at < since) continue;
        totalPublished++;
        const views = p.views ?? 0;
        if (!best || views > best.views) {
          const creative = await ctx.db.get(p.creativeId);
          best = {
            postId: p._id,
            siteId: s._id,
            siteName: s.name,
            platform: p.platform,
            views,
            engagement: p.engagement ?? 0,
            creativeId: p.creativeId,
            r2Key: creative?.r2Key ?? null,
            publishedAt: p.publishedAt ?? null,
          };
        }
      }
    }

    const passed = (best?.views ?? 0) >= VIEW_THRESHOLD;
    return {
      threshold: VIEW_THRESHOLD,
      trailingDays: 30,
      passed,
      totalPublishedInWindow: totalPublished,
      bestVideo: best, // null when nothing published in window
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

// Per-brand KPI aggregate for the Overview tab. Every read is index-scoped to siteId.
// Returns the site row + a bundle of counts the detail header/Overview needs in one round-trip.
export const brandDetail = query({
  args: { siteId: v.id("sites") },
  handler: async (ctx, { siteId }) => {
    const site = await ctx.db.get(siteId);
    if (!site) return null;

    const [allProducts, activeProducts, pendingActions, allPosts, publishedPosts, openOrders, allOrders, reviewCreatives] =
      await Promise.all([
        ctx.db.query("products").withIndex("by_site", (q) => q.eq("siteId", siteId)).take(500),
        ctx.db.query("products").withIndex("by_site_status", (q) => q.eq("siteId", siteId).eq("status", "active")).take(500),
        ctx.db.query("actions").withIndex("by_site_status", (q) => q.eq("siteId", siteId).eq("status", "pending_approval")).take(500),
        ctx.db.query("posts").withIndex("by_site_status", (q) => q.eq("siteId", siteId)).take(500),
        ctx.db.query("posts").withIndex("by_site_status", (q) => q.eq("siteId", siteId).eq("status", "published")).take(500),
        ctx.db.query("orders").withIndex("by_site_status", (q) => q.eq("siteId", siteId).eq("fulfillmentStatus", "received")).take(500),
        ctx.db.query("orders").withIndex("by_site", (q) => q.eq("siteId", siteId)).take(500),
        ctx.db.query("creatives").withIndex("by_site_status", (q) => q.eq("siteId", siteId).eq("status", "review")).take(500),
      ]);

    const totalViews = publishedPosts.reduce((s, p) => s + (p.views ?? 0), 0);
    const revenueUsd = allOrders.reduce((s, o) => s + (o.totalUsd ?? 0), 0);

    return {
      site,
      productCount: allProducts.length,
      activeProductCount: activeProducts.length,
      pendingActionCount: pendingActions.length,
      postCount: allPosts.length,
      publishedPostCount: publishedPosts.length,
      openOrderCount: openOrders.length,
      orderCount: allOrders.length,
      reviewCreativeCount: reviewCreatives.length,
      totalViews,
      revenueUsd,
    };
  },
});
