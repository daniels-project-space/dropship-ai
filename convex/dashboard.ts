// Control-plane portfolio view: every site + its pending-action / active-product counts.
// Index-driven only — counts come from .withIndex() reads, never full-table scans.
import { query } from "./authz";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { matchesDataMode, type DataMode } from "./sampleScope";
import { eligibleUsdOrder } from "../src/lib/shopifyOrder";

export const portfolio = query({
  args: { dataMode: v.optional(v.union(v.literal("live"), v.literal("sample"))) },
  handler: async (ctx, { dataMode }) => {
    // Tenant set is small and bounded; cap defensively.
    const sites = (await ctx.db.query("sites").order("desc").take(500)).filter((site) => matchesDataMode(site, dataMode));

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
          ordersAwaitingFulfillment: openOrders.filter((order) => eligibleUsdOrder(order, site.storeCurrency)).length,
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
  args: { siteId: v.optional(v.id("sites")), dataMode: v.optional(v.union(v.literal("live"), v.literal("sample"))) },
  handler: async (ctx, { siteId, dataMode }) => {
    const since = Date.now() - TRAILING_MS;
    const candidates = siteId
      ? [await ctx.db.get(siteId)].filter((s): s is NonNullable<typeof s> => s !== null)
      : await ctx.db.query("sites").take(200);
    const sites = candidates.filter((site) => matchesDataMode(site, dataMode));

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
        if (!hasProviderObservedPostMetrics(p)) continue;
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

// ── analytics layer (the Command Center charts) ──────────────────────────────
// All reads are index-scoped per site (by_site_day / by_site / by_site_status /
// by_site_platform). `scope` is "all" (whole portfolio, bounded) or a siteId.
// Time-series are bucketed by day; revenue uses order.createdAt, organic uses
// posts (published) + conversionMetrics. NEVER an unindexed .collect().

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function hasProviderObservedPostMetrics(post: { metricsProvider?: string; metricsObservedAt?: number }): boolean {
  return post.metricsProvider === "ayrshare" && Number.isFinite(post.metricsObservedAt);
}

// Resolve the scope to a concrete, bounded site list.
async function resolveSites(ctx: QueryCtx, scope: string | undefined, dataMode: DataMode = "live") {
  if (scope && scope !== "all") {
    const s = await ctx.db.get(scope as Id<"sites">);
    return s && matchesDataMode(s, dataMode) ? [s] : [];
  }
  return (await ctx.db.query("sites").take(200)).filter((site) => matchesDataMode(site, dataMode));
}

// `metric` ∈ "revenue" | "orders" | "views" | "engagement". Returns a dense
// daily series over the trailing `days` window (zero-filled so charts are smooth).
export const timeseries = query({
  args: {
    scope: v.optional(v.string()), // "all" | siteId
    metric: v.union(v.literal("revenue"), v.literal("orders"), v.literal("views"), v.literal("engagement")),
    days: v.optional(v.number()),
    platform: v.optional(v.string()),
    dataMode: v.optional(v.union(v.literal("live"), v.literal("sample"))),
  },
  handler: async (ctx, { scope, metric, days, platform, dataMode }) => {
    const window = Math.min(days ?? 30, 180);
    const since = Date.now() - window * DAY_MS;
    const sites = await resolveSites(ctx, scope, dataMode);

    // dense day buckets
    const buckets = new Map<string, number>();
    for (let i = window - 1; i >= 0; i--) buckets.set(dayKey(Date.now() - i * DAY_MS), 0);

    for (const s of sites) {
      if (metric === "revenue" || metric === "orders") {
        const orders = await ctx.db
          .query("orders")
          .withIndex("by_site", (q) => q.eq("siteId", s._id))
          .take(2000);
        for (const o of orders) {
          if (o.createdAt < since) continue;
          if (!eligibleUsdOrder(o, s.storeCurrency)) continue;
          const k = dayKey(o.createdAt);
          if (!buckets.has(k)) continue;
          buckets.set(k, buckets.get(k)! + (metric === "revenue" ? o.currentTotal! : 1));
        }
      } else {
        // views / engagement from published posts (publishedAt bucketed)
        const posts = await ctx.db
          .query("posts")
          .withIndex("by_site_status", (q) => q.eq("siteId", s._id).eq("status", "published"))
          .take(2000);
        for (const p of posts) {
          if (platform && platform !== "all" && p.platform !== platform) continue;
          if (!hasProviderObservedPostMetrics(p)) continue;
          const at = p.publishedAt ?? p._creationTime;
          if (at < since) continue;
          const k = dayKey(at);
          if (!buckets.has(k)) continue;
          buckets.set(k, buckets.get(k)! + (metric === "views" ? p.views ?? 0 : p.engagement ?? 0));
        }
      }
    }

    const points = Array.from(buckets.entries()).map(([day, value]) => ({ day, value }));
    const total = points.reduce((s, p) => s + p.value, 0);
    // delta vs the prior equal window (compare last half-window to the one before)
    const half = Math.floor(points.length / 2);
    const recent = points.slice(half).reduce((s, p) => s + p.value, 0);
    const prior = points.slice(0, half).reduce((s, p) => s + p.value, 0);
    const deltaPct = prior > 0 ? ((recent - prior) / prior) * 100 : recent > 0 ? 100 : 0;

    return { metric, days: window, points, total, deltaPct, currencyCode: metric === "revenue" ? "USD" : null, eligibleRealOrdersOnly: metric === "revenue" || metric === "orders" };
  },
});

// Per-platform published-post performance (views + engagement + post count).
export const platformBreakdown = query({
  args: { scope: v.optional(v.string()), days: v.optional(v.number()), dataMode: v.optional(v.union(v.literal("live"), v.literal("sample"))) },
  handler: async (ctx, { scope, days, dataMode }) => {
    const window = Math.min(days ?? 30, 180);
    const since = Date.now() - window * DAY_MS;
    const sites = await resolveSites(ctx, scope, dataMode);

    const acc: Record<string, { views: number; engagement: number; posts: number }> = {
      tiktok: { views: 0, engagement: 0, posts: 0 },
      instagram: { views: 0, engagement: 0, posts: 0 },
      youtube: { views: 0, engagement: 0, posts: 0 },
      facebook: { views: 0, engagement: 0, posts: 0 },
    };

    for (const s of sites) {
      const posts = await ctx.db
        .query("posts")
        .withIndex("by_site_status", (q) => q.eq("siteId", s._id).eq("status", "published"))
        .take(2000);
      for (const p of posts) {
        const at = p.publishedAt ?? p._creationTime;
        if (at < since) continue;
        if (!hasProviderObservedPostMetrics(p)) continue;
        const a = acc[p.platform];
        if (!a) continue;
        a.views += p.views ?? 0;
        a.engagement += p.engagement ?? 0;
        a.posts += 1;
      }
    }

    return Object.entries(acc).map(([platform, v]) => ({ platform, ...v }));
  },
});

// Conversion funnel: only direct provider observations are eligible. In particular, checkout is
// never inferred from an add-to-cart ratio and a missing provider counter stays zero/unknown.
export const funnel = query({
  args: { scope: v.optional(v.string()), days: v.optional(v.number()), dataMode: v.optional(v.union(v.literal("live"), v.literal("sample"))) },
  handler: async (ctx, { scope, days, dataMode }) => {
    const window = Math.min(days ?? 30, 180);
    const since = Date.now() - window * DAY_MS;
    const sites = await resolveSites(ctx, scope, dataMode);

    let views = 0;
    let pageviews = 0;
    let atc = 0;
    let checkout = 0;
    let purchases = 0;

    for (const s of sites) {
      const posts = await ctx.db
        .query("posts")
        .withIndex("by_site_status", (q) => q.eq("siteId", s._id).eq("status", "published"))
        .take(2000);
      for (const p of posts) {
        const at = p.publishedAt ?? p._creationTime;
        if (at >= since && hasProviderObservedPostMetrics(p)) views += p.views ?? 0;
      }

      const metrics = await ctx.db
        .query("conversionMetrics")
        .withIndex("by_site_day", (q) => q.eq("siteId", s._id))
        .order("desc")
        .take(window);
      for (const m of metrics) {
        if (m.provider !== "shopify" || !Number.isFinite(m.observedAt)) continue;
        pageviews += m.pageviews;
        atc += m.addToCartCount ?? 0;
        checkout += m.checkoutCount ?? 0;
      }
      const orders = await ctx.db.query("orders").withIndex("by_site", (q) => q.eq("siteId", s._id)).take(2000);
      purchases += orders.filter((order) => order.createdAt >= since && eligibleUsdOrder(order, s.storeCurrency)).length;
    }
    const stages = [
      { label: "Provider-observed reach", value: views },
      { label: "Shopify pageviews", value: pageviews },
      { label: "Shopify add-to-cart", value: atc },
      { label: "Shopify checkout", value: checkout },
      { label: "Shopify purchase", value: purchases },
    ];
    return { stages, days: window, providerObservedOnly: true, purchaseBasis: "eligible_real_paid_usd_orders" };
  },
});

// Top products by views with CVR + contribution margin, for the DataTable mini-bars.
export const topProducts = query({
  args: { scope: v.optional(v.string()), limit: v.optional(v.number()), dataMode: v.optional(v.union(v.literal("live"), v.literal("sample"))) },
  handler: async (ctx, { scope, limit, dataMode }) => {
    const sites = await resolveSites(ctx, scope, dataMode);
    const cap = Math.min(limit ?? 6, 25);

    const rows: Array<{
      productId: string;
      title: string;
      siteName: string;
      views: number;
      cvr: number;
      marginPct: number | null;
      priceUsd: number;
      trend: number[];
      status: string;
    }> = [];

    for (const s of sites) {
      const products = await ctx.db
        .query("products")
        .withIndex("by_site", (q) => q.eq("siteId", s._id))
        .take(200);
      for (const p of products) {
        const metrics = await ctx.db
          .query("conversionMetrics")
          .withIndex("by_product_day", (q) => q.eq("productId", p._id))
          .order("desc")
          .take(14);
        const observed = metrics.filter((m) => m.provider === "shopify" && Number.isFinite(m.observedAt));
        const views = observed.reduce((sum, m) => sum + m.pageviews, 0);
        const latest = observed[0];
        const latestCvr = latest && latest.pageviews > 0 ? (latest.purchaseCount ?? 0) / latest.pageviews : 0;
        // No fallback arithmetic: synced Shopify rows have unknown supplier costs until a
        // verified CJ evidence/quote record creates contributionMarginPct.
        const margin = p.contributionMarginPct ?? null;
        rows.push({
          productId: p._id,
          title: p.title,
          siteName: s.name,
          views,
          cvr: latestCvr * 100,
          marginPct: margin,
          priceUsd: p.priceUsd,
          trend: observed.map((m) => m.pageviews).reverse(),
          status: p.status,
        });
      }
    }

    rows.sort((a, b) => b.views - a.views);
    return rows.slice(0, cap);
  },
});

// Posting cadence — daily published-post counts over the trailing window, for the
// Heatmap (calendar grid). Index-scoped per site (by_site_status published).
export const postingCadence = query({
  args: { scope: v.optional(v.string()), days: v.optional(v.number()), dataMode: v.optional(v.union(v.literal("live"), v.literal("sample"))) },
  handler: async (ctx, { scope, days, dataMode }) => {
    const window = Math.min(days ?? 84, 180);
    const since = Date.now() - window * DAY_MS;
    const sites = await resolveSites(ctx, scope, dataMode);
    const counts = new Map<string, number>();
    for (const s of sites) {
      const posts = await ctx.db
        .query("posts")
        .withIndex("by_site_status", (q) => q.eq("siteId", s._id).eq("status", "published"))
        .take(2000);
      for (const p of posts) {
        const at = p.publishedAt ?? p._creationTime;
        if (at < since) continue;
        const k = dayKey(at);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries()).map(([date, value]) => ({ date, value }));
  },
});

// Detects whether any sample/seeded data is present (drives the honesty pill).
export const sampleStatus = query({
  args: {},
  handler: async (ctx) => {
    const sites = await ctx.db.query("sites").take(200);
    const sampleSites = sites.filter((s) => s.sample === true);
    return {
      present: sampleSites.length > 0,
      sampleSiteCount: sampleSites.length,
      sampleSiteNames: sampleSites.map((s) => s.name),
    };
  },
});

// Per-brand KPI aggregate for the Overview tab. Every read is index-scoped to siteId.
// Returns the site row + a bundle of counts the detail header/Overview needs in one round-trip.
export const brandDetail = query({
  args: { siteId: v.id("sites") },
  handler: async (ctx, { siteId }) => {
    const site = await ctx.db.get(siteId);
    if (!site || site.sample === true) return null;

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

    const totalViews = publishedPosts.reduce((s, p) => s + (hasProviderObservedPostMetrics(p) ? p.views ?? 0 : 0), 0);
    const eligibleOrders = allOrders.filter((order) => eligibleUsdOrder(order, site.storeCurrency));
    const revenueUsd = eligibleOrders.reduce((sum, order) => sum + order.currentTotal!, 0);

    return {
      site,
      productCount: allProducts.length,
      activeProductCount: activeProducts.length,
      pendingActionCount: pendingActions.length,
      postCount: allPosts.length,
      publishedPostCount: publishedPosts.length,
      openOrderCount: openOrders.length,
      orderCount: eligibleOrders.length,
      reviewCreativeCount: reviewCreatives.length,
      totalViews,
      revenueUsd,
      revenueCurrency: "USD" as const,
    };
  },
});
