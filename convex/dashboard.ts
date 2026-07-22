// Control-plane portfolio view: every site + its pending-action / active-product counts.
// Index-driven only — counts come from .withIndex() reads, never full-table scans.
import { query } from "./authz";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { matchesDataMode, type DataMode } from "./sampleScope";
import { eligibleUsdOrder } from "../src/lib/shopifyOrder";
import { shopifyEconomicsReadiness } from "../src/lib/shopifySyncState";
import { DASHBOARD_MAX_DAYS, DASHBOARD_MAX_SITES, dashboardDay, dashboardProjectionReady } from "./dashboardProjections";

function hasCurrentEconomicsSnapshot(site: { shopifyEconomicsSyncAttemptId?: string } & Parameters<typeof shopifyEconomicsReadiness>[0]): boolean {
  return shopifyEconomicsReadiness(site) === "current" && !!site.shopifyEconomicsSyncAttemptId;
}

function belongsToCurrentEconomicsSnapshot(
  row: { shopifyEconomicsSnapshotAttemptId?: string },
  site: { shopifyEconomicsSyncAttemptId?: string },
): boolean {
  return !!site.shopifyEconomicsSyncAttemptId
    && row.shopifyEconomicsSnapshotAttemptId === site.shopifyEconomicsSyncAttemptId;
}

export const portfolio = query({
  args: { dataMode: v.optional(v.union(v.literal("live"), v.literal("sample"))) },
  handler: async (ctx, { dataMode }) => {
    if (await dashboardProjectionReady(ctx)) {
      const mode = dataMode ?? "live";
      const summaries = await ctx.db.query("dashboardSiteSummaries").withIndex("by_mode_site", (q) => q.eq("dataMode", mode)).take(DASHBOARD_MAX_SITES);
      const rows = summaries.map((site) => ({
        siteId: site.siteId, name: site.name, niche: site.niche, status: site.status,
        distributionMode: site.distributionMode, shopifyDomain: site.shopifyDomain ?? null,
        shopifyNeedsReverification: !!site.shopifyDomain && (site.storeCurrency !== "USD" || !site.shopifyAccessVerifiedAt),
        shopifyEconomicsSyncState: projectedReadiness(site), customDomain: site.customDomain ?? null,
        killDate: site.killDate ?? null, pendingActionCount: site.pendingActionCount,
        activeProductCount: site.activeProductCount,
        ordersAwaitingFulfillment: projectedReadiness(site) === "current" ? site.openOrderCount : 0,
      }));
      return { siteCount: rows.length, totalPendingActions: rows.reduce((sum, row) => sum + row.pendingActionCount, 0), sites: rows };
    }
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
          shopifyNeedsReverification: !!site.shopifyDomain && (site.storeCurrency !== "USD" || !site.shopifyAccessVerifiedAt),
          shopifyEconomicsSyncState: shopifyEconomicsReadiness(site),
          customDomain: site.customDomain ?? null,
          killDate: site.killDate ?? null,
          pendingActionCount: pendingActions.length,
          activeProductCount: activeProducts.length,
          ordersAwaitingFulfillment: hasCurrentEconomicsSnapshot(site)
            ? openOrders.filter((order) => belongsToCurrentEconomicsSnapshot(order, site) && eligibleUsdOrder(order, site.storeCurrency)).length
            : 0,
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
    if (await dashboardProjectionReady(ctx)) {
      if (siteId) {
        const site = await ctx.db.get(siteId);
        if (!site || !matchesDataMode(site, dataMode)) return { threshold: VIEW_THRESHOLD, trailingDays: 30, passed: false, totalPublishedInWindow: 0, bestVideo: null };
      }
      return projectedGate(ctx, siteId, dataMode ?? "live", Date.now());
    }
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

    if (await dashboardProjectionReady(ctx)) {
      const summary = await ctx.db.query("dashboardSiteSummaries").withIndex("by_site", (q) => q.eq("siteId", siteId)).unique();
      return summary ? {
        site, economicsReadiness: shopifyEconomicsReadiness(site),
        pendingActionCount: summary.pendingActionCount, activeProductCount: summary.activeProductCount,
      } : null;
    }

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
      economicsReadiness: shopifyEconomicsReadiness(site),
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
    const commerceMetric = metric === "revenue" || metric === "orders";
    const commerceVerified = !commerceMetric || (window <= 60 && sites.length > 0 && sites.every(hasCurrentEconomicsSnapshot));

    // dense day buckets
    const buckets = new Map<string, number>();
    for (let i = window - 1; i >= 0; i--) buckets.set(dayKey(Date.now() - i * DAY_MS), 0);

    for (const s of sites) {
      if (metric === "revenue" || metric === "orders") {
        if (!commerceVerified) continue;
        const orders = await ctx.db
          .query("orders")
          .withIndex("by_site", (q) => q.eq("siteId", s._id))
          .take(2000);
        for (const o of orders) {
          if (o.createdAt < since) continue;
          if (!belongsToCurrentEconomicsSnapshot(o, s)) continue;
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

    return { metric, days: window, points, total, deltaPct, currencyCode: metric === "revenue" ? "USD" : null, eligibleRealOrdersOnly: commerceMetric, commerceVerified };
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
    const commerceVerified = window <= 60 && sites.length > 0 && sites.every(hasCurrentEconomicsSnapshot);

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
      if (commerceVerified) {
        const orders = await ctx.db.query("orders").withIndex("by_site", (q) => q.eq("siteId", s._id)).take(2000);
        purchases += orders.filter((order) => order.createdAt >= since
          && belongsToCurrentEconomicsSnapshot(order, s)
          && eligibleUsdOrder(order, s.storeCurrency)).length;
      }
    }
    const stages = [
      { label: "Provider-observed reach", value: views },
      { label: "Shopify pageviews", value: pageviews },
      { label: "Shopify add-to-cart", value: atc },
      { label: "Shopify checkout", value: checkout },
      { label: "Shopify purchase", value: purchases },
    ];
    return { stages, days: window, providerObservedOnly: true, purchaseBasis: "eligible_real_paid_usd_orders", commerceVerified };
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

    if (await dashboardProjectionReady(ctx)) {
      const summary = await ctx.db.query("dashboardSiteSummaries").withIndex("by_site", (q) => q.eq("siteId", siteId)).unique();
      if (!summary) return null;
      const daily = await ctx.db.query("dashboardDailyRollups").withIndex("by_site_day", (q) => q.eq("siteId", siteId)).order("desc").take(DASHBOARD_MAX_DAYS);
      return {
        site,
        economicsReadiness: shopifyEconomicsReadiness(site),
        productCount: summary.productCount,
        activeProductCount: summary.activeProductCount,
        pendingActionCount: summary.pendingActionCount,
        postCount: summary.postCount,
        publishedPostCount: summary.publishedPostCount,
        openOrderCount: summary.openOrderCount,
        orderCount: summary.orderCount,
        reviewCreativeCount: summary.reviewCreativeCount,
        totalViews: daily.reduce((sum, row) => sum + row.views, 0),
        revenueUsd: summary.revenueUsd,
        revenueCurrency: "USD" as const,
      };
    }

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
    const eligibleOrders = hasCurrentEconomicsSnapshot(site)
      ? allOrders.filter((order) => belongsToCurrentEconomicsSnapshot(order, site) && eligibleUsdOrder(order, site.storeCurrency))
      : [];
    const revenueUsd = eligibleOrders.reduce((sum, order) => sum + order.currentTotal!, 0);

    return {
      site,
      economicsReadiness: shopifyEconomicsReadiness(site),
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

const PLATFORM_KEYS = ["tiktok", "instagram", "youtube", "facebook"] as const;
const BRAIN_FRESH_MS = 5 * 60_000;

function projectedReadiness(row: {
  shopifyDomain?: string; storeCurrency?: string; shopifyAccessVerifiedAt?: number;
  shopifyEconomicsSyncStatus?: string; shopifyEconomicsSyncAttemptId?: string;
  shopifyEconomicsSyncSucceededAt?: number; shopifyEconomicsSyncExpiresAt?: number;
}) {
  return shopifyEconomicsReadiness(row as Parameters<typeof shopifyEconomicsReadiness>[0]);
}

async function projectedGate(ctx: QueryCtx, siteId: Id<"sites"> | undefined, mode: DataMode, now: number) {
  const sinceDay = dashboardDay(now - 29 * DAY_MS);
  const rows = siteId
    ? await ctx.db.query("dashboardDailyRollups")
      .withIndex("by_site_day", (q) => q.eq("siteId", siteId).gte("day", sinceDay)).take(31)
    : await ctx.db.query("dashboardPortfolioDailyRollups")
      .withIndex("by_mode_day", (q) => q.eq("dataMode", mode).gte("day", sinceDay)).take(31);
  const bestRow = rows.filter((row) => row.bestPost).sort((a, b) => (b.bestPost?.views ?? 0) - (a.bestPost?.views ?? 0))[0];
  let bestVideo = null;
  if (bestRow?.bestPost) {
    const best = bestRow.bestPost;
    const site = "siteId" in best ? null : siteId ? await ctx.db.get(siteId) : null;
    bestVideo = {
      postId: best.postId,
      siteId: "siteId" in best ? best.siteId : siteId!,
      siteName: "siteName" in best ? best.siteName : site?.name ?? "Unknown brand",
      platform: best.platform,
      views: best.views,
      engagement: best.engagement,
      creativeId: best.creativeId,
      r2Key: best.r2Key ?? null,
      publishedAt: best.publishedAt ?? null,
    };
  }
  return {
    threshold: VIEW_THRESHOLD,
    trailingDays: 30,
    passed: (bestVideo?.views ?? 0) >= VIEW_THRESHOLD,
    totalPublishedInWindow: rows.reduce((sum, row) => sum + row.observedPosts, 0),
    bestVideo,
  };
}

/** One always-on shell subscription. Ready-path dependencies are compact site rows + 30 days. */
export const shellSnapshot = query({
  args: { dataMode: v.optional(v.union(v.literal("live"), v.literal("sample"))) },
  handler: async (ctx, { dataMode }) => {
    const mode = dataMode ?? "live";
    const ready = await dashboardProjectionReady(ctx);
    const now = Date.now();
    const heartbeat = await ctx.db.query("dashboardControlPlaneHeartbeats")
      .withIndex("by_component", (q) => q.eq("component", "brain")).unique();
    const controlPlane = !heartbeat
      ? { state: "unknown" as const, label: "Brain unknown", heartbeatAt: null, checkpointAt: null, checkpoint: null }
      : now - heartbeat.heartbeatAt <= BRAIN_FRESH_MS
        ? { state: "online" as const, label: "Brain online", heartbeatAt: heartbeat.heartbeatAt, checkpointAt: heartbeat.checkpointAt ?? null, checkpoint: heartbeat.checkpoint ?? null }
        : { state: "offline" as const, label: "Brain offline", heartbeatAt: heartbeat.heartbeatAt, checkpointAt: heartbeat.checkpointAt ?? null, checkpoint: heartbeat.checkpoint ?? null };

    if (!ready) {
      // The migration contract deliberately leaves authoritative legacy reads active until the
      // final verification transaction flips `read-switch` to ready.
      const sites = (await ctx.db.query("sites").order("desc").take(DASHBOARD_MAX_SITES)).filter((site) => matchesDataMode(site, mode));
      const rows = await Promise.all(sites.map(async (site) => {
        const pending = await ctx.db.query("actions").withIndex("by_site_status", (q) => q.eq("siteId", site._id).eq("status", "pending_approval")).take(500);
        return { siteId: site._id, name: site.name, status: site.status, pendingActionCount: pending.length };
      }));
      const sampleSites = (await ctx.db.query("sites").withIndex("by_sample", (q) => q.eq("sample", true)).take(200));
      return {
        projectionState: "legacy" as const,
        brands: rows,
        totalPendingActions: rows.reduce((sum, row) => sum + row.pendingActionCount, 0),
        contentFit: { threshold: VIEW_THRESHOLD, trailingDays: 30, passed: false, totalPublishedInWindow: 0, bestVideo: null },
        sampleStatus: { present: sampleSites.length > 0, sampleSiteCount: sampleSites.length, sampleSiteNames: sampleSites.map((site) => site.name) },
        controlPlane,
      };
    }

    const sites = await ctx.db.query("dashboardSiteSummaries").withIndex("by_mode_site", (q) => q.eq("dataMode", mode)).take(DASHBOARD_MAX_SITES);
    const sampleSites = await ctx.db.query("dashboardSiteSummaries").withIndex("by_mode_site", (q) => q.eq("dataMode", "sample")).take(DASHBOARD_MAX_SITES);
    const gate = await projectedGate(ctx, undefined, mode, now);
    return {
      projectionState: "ready" as const,
      brands: sites.map((site) => ({ siteId: site.siteId, name: site.name, status: site.status, pendingActionCount: site.pendingActionCount })),
      totalPendingActions: sites.reduce((sum, site) => sum + site.pendingActionCount, 0),
      contentFit: gate,
      sampleStatus: { present: sampleSites.length > 0, sampleSiteCount: sampleSites.length, sampleSiteNames: sampleSites.map((site) => site.name) },
      controlPlane,
    };
  },
});

function denseSeries(rows: Array<{ day: string } & Record<string, any>>, days: number, now: number, value: (row: any) => number) {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const points = Array.from({ length: days }, (_, index) => {
    const day = dashboardDay(now - (days - 1 - index) * DAY_MS);
    return { day, value: value(byDay.get(day) ?? {}) };
  });
  const total = points.reduce((sum, point) => sum + point.value, 0);
  const half = Math.floor(points.length / 2);
  const prior = points.slice(0, half).reduce((sum, point) => sum + point.value, 0);
  const recent = points.slice(half).reduce((sum, point) => sum + point.value, 0);
  const deltaPct = prior > 0 ? ((recent - prior) / prior) * 100 : recent > 0 ? 100 : 0;
  return { points, total, deltaPct };
}

function compactInsights(input: {
  pending: number; openOrders: number; gate: Awaited<ReturnType<typeof projectedGate>>;
  platforms: Array<{ platform: string; views: number }>; totalViews: number;
  products: Array<{ title: string; marginPct?: number | null }>;
}) {
  const insights: Array<{ id: string; icon: "spark" | "approvals" | "truck" | "distribution" | "package"; tone: "live" | "pending" | "cyan" | "violet"; headline: string; stat: string; action?: { label: string; href: string } }> = [];
  if (input.gate.passed) insights.push({ id: "content-fit", icon: "spark", tone: "live", headline: "Content-fit gate cleared", stat: "Provider-observed organic demand crossed 10k views.", action: { label: "Review approvals", href: "/approvals" } });
  if (input.pending) insights.push({ id: "pending", icon: "approvals", tone: "pending", headline: `${input.pending} action${input.pending === 1 ? "" : "s"} awaiting your call`, stat: "Money / ban-risk moves are paused until approved.", action: { label: "Review now", href: "/approvals" } });
  const topPlatform = [...input.platforms].sort((a, b) => b.views - a.views)[0];
  if (topPlatform && input.totalViews > 0 && topPlatform.views / input.totalViews >= 0.55) insights.push({ id: "platform-skew", icon: "distribution", tone: "violet", headline: `${topPlatform.platform} carries ${Math.round(topPlatform.views / input.totalViews * 100)}% of reach`, stat: "Provider-observed reach is concentrated on one platform.", action: { label: "Open distribution", href: "/posts" } });
  if (input.openOrders) insights.push({ id: "fulfillment", icon: "truck", tone: "cyan", headline: `${input.openOrders} order${input.openOrders === 1 ? "" : "s"} pending fulfillment`, stat: "Awaiting hand-off to the CJ supplier loop.", action: { label: "View orders", href: "/posts" } });
  const margin = input.products.filter((product) => product.marginPct != null).sort((a, b) => b.marginPct! - a.marginPct!)[0];
  if (margin && insights.length < 4) insights.push({ id: "margin", icon: "package", tone: "live", headline: `${margin.title} leads on contribution margin`, stat: `${margin.marginPct!.toFixed(0)}% verified contribution margin.`, action: { label: "See products", href: "/research" } });
  return insights.slice(0, 4);
}

/** One bounded Command Center subscription over at most 180 daily rows + one summary row. */
export const commandCenterSnapshot = query({
  args: {
    scope: v.optional(v.string()), days: v.optional(v.number()), platform: v.optional(v.string()),
    dataMode: v.optional(v.union(v.literal("live"), v.literal("sample"))),
  },
  handler: async (ctx, { scope, days, platform, dataMode }) => {
    const mode = dataMode ?? "live";
    const window = Math.min(days ?? 30, 90);
    const readDays = Math.min(Math.max(window, 84), DASHBOARD_MAX_DAYS);
    const now = Date.now();
    const sinceDay = dashboardDay(now - (readDays - 1) * DAY_MS);
    const siteId = scope && scope !== "all" ? scope as Id<"sites"> : undefined;
    const ready = await dashboardProjectionReady(ctx);
    let rows: any[];
    let summary: any;
    let legacyBest: any = null;
    if (ready) {
      rows = siteId
        ? await ctx.db.query("dashboardDailyRollups").withIndex("by_site_day", (q) => q.eq("siteId", siteId).gte("day", sinceDay)).take(DASHBOARD_MAX_DAYS)
        : await ctx.db.query("dashboardPortfolioDailyRollups").withIndex("by_mode_day", (q) => q.eq("dataMode", mode).gte("day", sinceDay)).take(DASHBOARD_MAX_DAYS);
      summary = siteId
        ? await ctx.db.query("dashboardSiteSummaries").withIndex("by_site", (q) => q.eq("siteId", siteId)).unique()
        : await ctx.db.query("dashboardPortfolioSummaries").withIndex("by_mode", (q) => q.eq("dataMode", mode)).unique();
    } else {
      // Authoritative compatibility path until the atomic read switch. It reads each bounded
      // source family once per site; the UI still has one subscription rather than eleven.
      const sites = await resolveSites(ctx, scope, mode);
      const byDay = new Map<string, any>();
      const products: any[] = [];
      let pendingActionCount = 0;
      let openOrderCount = 0;
      let orderCount = 0;
      let revenueUsd = 0;
      for (const site of sites) {
        const [posts, orders0, products0, pending] = await Promise.all([
          ctx.db.query("posts").withIndex("by_site_status", (q) => q.eq("siteId", site._id).eq("status", "published")).take(2000),
          ctx.db.query("orders").withIndex("by_site", (q) => q.eq("siteId", site._id)).take(2000),
          ctx.db.query("products").withIndex("by_site", (q) => q.eq("siteId", site._id)).take(200),
          ctx.db.query("actions").withIndex("by_site_status", (q) => q.eq("siteId", site._id).eq("status", "pending_approval")).take(500),
        ]);
        pendingActionCount += pending.length;
        for (const product of products0) products.push({
          productId: product._id, title: product.title, siteName: site.name, views: 0, cvr: null,
          marginPct: product.contributionMarginPct ?? null, priceUsd: product.priceUsd, trend: [], status: product.status,
        });
        for (const post of posts) {
          const day = dashboardDay(post.publishedAt ?? post._creationTime);
          if (day < sinceDay) continue;
          const value = byDay.get(day) ?? { day, orders: 0, revenueUsd: 0, purchases: 0, publishedPosts: 0, observedPosts: 0, views: 0, engagement: 0, platforms: Object.fromEntries(PLATFORM_KEYS.map((key) => [key, { posts: 0, views: 0, engagement: 0 }])) };
          value.publishedPosts++;
          if (hasProviderObservedPostMetrics(post)) {
            value.observedPosts++; value.views += post.views ?? 0; value.engagement += post.engagement ?? 0;
            value.platforms[post.platform].posts++; value.platforms[post.platform].views += post.views ?? 0; value.platforms[post.platform].engagement += post.engagement ?? 0;
            if (!legacyBest || (post.views ?? 0) > legacyBest.views) {
              const creative = await ctx.db.get(post.creativeId);
              legacyBest = { postId: post._id, siteId: site._id, siteName: site.name, platform: post.platform, views: post.views ?? 0, engagement: post.engagement ?? 0, creativeId: post.creativeId, r2Key: creative?.r2Key ?? null, publishedAt: post.publishedAt ?? null };
            }
          }
          byDay.set(day, value);
        }
        if (window <= 60 && hasCurrentEconomicsSnapshot(site)) {
          for (const order of orders0) {
            if (!belongsToCurrentEconomicsSnapshot(order, site) || !eligibleUsdOrder(order, site.storeCurrency)) continue;
            const day = dashboardDay(order.createdAt);
            if (day < sinceDay) continue;
            const value = byDay.get(day) ?? { day, orders: 0, revenueUsd: 0, purchases: 0, publishedPosts: 0, observedPosts: 0, views: 0, engagement: 0, platforms: Object.fromEntries(PLATFORM_KEYS.map((key) => [key, { posts: 0, views: 0, engagement: 0 }])) };
            value.orders++; value.purchases++; value.revenueUsd += order.currentTotal!; byDay.set(day, value);
            orderCount++; revenueUsd += order.currentTotal!;
            if (order.fulfillmentStatus === "received") openOrderCount++;
          }
        }
      }
      rows = [...byDay.values()];
      products.sort((a, b) => (b.marginPct ?? -Infinity) - (a.marginPct ?? -Infinity));
      summary = {
        pendingActionCount, openOrderCount, orderCount, revenueUsd, topProducts: products.slice(0, 25),
        commerceVerified: window <= 60 && sites.length > 0 && sites.every(hasCurrentEconomicsSnapshot),
      };
    }
    const scopedRows = rows.filter((row) => row.day >= dashboardDay(now - (window - 1) * DAY_MS));
    const platformKey = platform && platform !== "all" && PLATFORM_KEYS.includes(platform as typeof PLATFORM_KEYS[number]) ? platform as typeof PLATFORM_KEYS[number] : null;
    const revenue = denseSeries(scopedRows, window, now, (row) => row.revenueUsd ?? 0);
    const orders = denseSeries(scopedRows, window, now, (row) => row.orders ?? 0);
    const views = denseSeries(scopedRows, window, now, (row) => platformKey ? row.platforms?.[platformKey]?.views ?? 0 : row.views ?? 0);
    const engagement = denseSeries(scopedRows, window, now, (row) => platformKey ? row.platforms?.[platformKey]?.engagement ?? 0 : row.engagement ?? 0);
    const platforms = PLATFORM_KEYS.map((key) => ({
      platform: key,
      posts: scopedRows.reduce((sum, row) => sum + row.platforms[key].posts, 0),
      views: scopedRows.reduce((sum, row) => sum + row.platforms[key].views, 0),
      engagement: scopedRows.reduce((sum, row) => sum + row.platforms[key].engagement, 0),
    }));
    const gate = ready ? await projectedGate(ctx, siteId, mode, now) : {
      threshold: VIEW_THRESHOLD, trailingDays: 30, passed: (legacyBest?.views ?? 0) >= VIEW_THRESHOLD,
      totalPublishedInWindow: rows.filter((row) => row.day >= dashboardDay(now - 29 * DAY_MS)).reduce((sum, row) => sum + row.observedPosts, 0),
      bestVideo: legacyBest,
    };
    const commerceVerified = window <= 60 && !!summary && ("commerceVerified" in summary
      ? summary.commerceVerified : projectedReadiness(summary) === "current");
    const products = summary?.topProducts.slice(0, 6).map((product: any) => ({ ...product, cvr: product.cvr ?? null, marginPct: product.marginPct ?? null })) ?? [];
    const pending = summary?.pendingActionCount ?? 0;
    const openOrders = summary?.openOrderCount ?? 0;
    const purchaseCount = scopedRows.reduce((sum, row) => sum + row.purchases, 0);
    return {
      projectionState: ready ? "ready" as const : "legacy" as const,
      revenue: { metric: "revenue", days: window, ...revenue, currencyCode: "USD", eligibleRealOrdersOnly: true, commerceVerified },
      orders: { metric: "orders", days: window, ...orders, currencyCode: null, eligibleRealOrdersOnly: true, commerceVerified },
      views: { metric: "views", days: window, ...views, currencyCode: null, eligibleRealOrdersOnly: false, commerceVerified: true },
      engagement: { metric: "engagement", days: window, ...engagement, currencyCode: null, eligibleRealOrdersOnly: false, commerceVerified: true },
      platforms,
      cadence: rows.filter((row) => row.day >= dashboardDay(now - 83 * DAY_MS) && row.publishedPosts > 0).map((row) => ({ date: row.day, value: row.publishedPosts })),
      gate,
      pendingTotal: pending,
      products,
      funnel: {
        stages: [
          { label: "Provider-observed reach", value: views.total },
          { label: "Shopify pageviews", value: 0 }, { label: "Shopify add-to-cart", value: 0 },
          { label: "Shopify checkout", value: 0 }, { label: "Shopify purchase", value: purchaseCount },
        ],
        days: window, providerObservedOnly: true, purchaseBasis: "eligible_real_paid_usd_orders",
        commerceVerified,
        conversionAvailability: { state: "unavailable" as const, reason: "No provider conversion observation adapter is configured; CVR and funnel steps are not synthesized." },
      },
      insights: { insights: compactInsights({ pending, openOrders, gate, platforms, totalViews: views.total, products }), computedAt: now, windowDays: window },
      coverage: {
        commerce: commerceVerified ? "provider_observed" as const : "unavailable" as const,
        content: "provider_observed" as const,
        conversion: "unavailable" as const,
      },
    };
  },
});
