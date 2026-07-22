import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { eligibleUsdOrder } from "../src/lib/shopifyOrder";
import { shopifyEconomicsReadiness } from "../src/lib/shopifySyncState";

export const DASHBOARD_PROJECTION = "dashboard-v1";
export const DASHBOARD_MAX_SITES = 500;
export const DASHBOARD_MAX_DAYS = 180;
const TOP_PRODUCT_CAP = 25;

export type ProjectionCtx = Pick<MutationCtx, "db">;
type DataMode = "live" | "sample";
type Platform = "tiktok" | "instagram" | "youtube" | "facebook";

export function dataModeOf(row: { sample?: boolean }): DataMode {
  return row.sample === true ? "sample" : "live";
}

export function dashboardDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function providerObservedPost(row: { metricsProvider?: string; metricsObservedAt?: number }): boolean {
  return row.metricsProvider === "ayrshare" && Number.isFinite(row.metricsObservedAt);
}

export async function dashboardProjectionReady(ctx: Pick<QueryCtx, "db">): Promise<boolean> {
  const row = await ctx.db.query("dashboardProjectionMigrations")
    .withIndex("by_name_entity", (q) => q.eq("name", DASHBOARD_PROJECTION).eq("entity", "read-switch"))
    .unique();
  return row?.phase === "ready" && row.completed && row.verified && row.driftCount === 0;
}

function emptyPlatforms() {
  return {
    tiktok: { posts: 0, views: 0, engagement: 0 },
    instagram: { posts: 0, views: 0, engagement: 0 },
    youtube: { posts: 0, views: 0, engagement: 0 },
    facebook: { posts: 0, views: 0, engagement: 0 },
  };
}

function siteFields(site: Doc<"sites">) {
  return {
    dataMode: dataModeOf(site), name: site.name, niche: site.niche, status: site.status,
    distributionMode: site.distributionMode, shopifyDomain: site.shopifyDomain,
    storeCurrency: site.storeCurrency, shopifyAccessVerifiedAt: site.shopifyAccessVerifiedAt,
    shopifyEconomicsSyncStatus: site.shopifyEconomicsSyncStatus,
    shopifyEconomicsSyncAttemptId: site.shopifyEconomicsSyncAttemptId,
    shopifyEconomicsSyncAttemptedAt: site.shopifyEconomicsSyncAttemptedAt,
    shopifyEconomicsSyncOrderCutoffAt: site.shopifyEconomicsSyncOrderCutoffAt,
    shopifyEconomicsSyncSucceededAt: site.shopifyEconomicsSyncSucceededAt,
    shopifyEconomicsSyncExpiresAt: site.shopifyEconomicsSyncExpiresAt,
    shopifyEconomicsSyncExpiredAt: site.shopifyEconomicsSyncExpiredAt,
    shopifyEconomicsSyncExpiredAttemptId: site.shopifyEconomicsSyncExpiredAttemptId,
    shopifyEconomicsSyncSinceDays: site.shopifyEconomicsSyncSinceDays,
    shopifyEconomicsSyncProductCount: site.shopifyEconomicsSyncProductCount,
    shopifyEconomicsSyncOrderCount: site.shopifyEconomicsSyncOrderCount,
    shopifyEconomicsSnapshotProtocolVersion: site.shopifyEconomicsSnapshotProtocolVersion,
    customDomain: site.customDomain, killDate: site.killDate,
  };
}

export async function ensureSiteSummary(ctx: ProjectionCtx, site: Doc<"sites">) {
  const existing = await ctx.db.query("dashboardSiteSummaries").withIndex("by_site", (q) => q.eq("siteId", site._id)).unique();
  if (existing) return existing;
  const id = await ctx.db.insert("dashboardSiteSummaries", {
    siteId: site._id, ...siteFields(site), productCount: 0, activeProductCount: 0,
    pendingActionCount: 0, postCount: 0, publishedPostCount: 0, reviewCreativeCount: 0,
    openOrderCount: 0, orderCount: 0, revenueUsd: 0, topProducts: [], updatedAt: Date.now(),
  });
  return (await ctx.db.get(id))!;
}

export async function projectSite(ctx: ProjectionCtx, site: Doc<"sites">) {
  const summary = await ensureSiteSummary(ctx, site);
  await ctx.db.patch(summary._id, { ...siteFields(site), updatedAt: Date.now() });
  await refreshPortfolioSummary(ctx, dataModeOf(site));
}

function clampCount(value: number): number {
  // Legacy rows may be touched before their backfill page. Source remains authoritative and the
  // migration/repair verifier will reconcile the exact total; never let a transition create a
  // negative user-visible count in the interim.
  return Math.max(0, value);
}

async function changeSiteCounts(
  ctx: ProjectionCtx,
  siteId: Id<"sites">,
  changes: Partial<Record<"productCount" | "activeProductCount" | "pendingActionCount" | "postCount" | "publishedPostCount" | "reviewCreativeCount" | "openOrderCount" | "orderCount", number>>,
) {
  const site = await ctx.db.get(siteId);
  if (!site) return;
  const row = await ensureSiteSummary(ctx, site);
  const patch: Record<string, number> = { updatedAt: Date.now() };
  for (const [key, delta] of Object.entries(changes)) {
    if (delta) patch[key] = clampCount((row as any)[key] + delta);
  }
  await ctx.db.patch(row._id, patch);
  await refreshPortfolioSummary(ctx, dataModeOf(site));
}

export async function projectActionTransition(ctx: ProjectionCtx, before: Doc<"actions"> | null, after: Doc<"actions"> | null) {
  const row = after ?? before;
  if (!row) return;
  const delta = Number(after?.status === "pending_approval") - Number(before?.status === "pending_approval");
  if (delta) await changeSiteCounts(ctx, row.siteId, { pendingActionCount: delta });
}

function compactProduct(product: Doc<"products">, siteName: string) {
  return {
    productId: product._id, title: product.title, siteName, views: 0,
    marginPct: product.contributionMarginPct, priceUsd: product.priceUsd, trend: [], status: product.status,
  };
}

export async function projectProductTransition(ctx: ProjectionCtx, before: Doc<"products"> | null, after: Doc<"products"> | null) {
  const row = after ?? before;
  if (!row) return;
  const site = await ctx.db.get(row.siteId);
  if (!site) return;
  const summary = await ensureSiteSummary(ctx, site);
  const products = summary.topProducts.filter((p) => p.productId !== row._id);
  if (after) products.push(compactProduct(after, site.name));
  products.sort((a, b) => b.views - a.views || (b.marginPct ?? -Infinity) - (a.marginPct ?? -Infinity) || String(a.productId).localeCompare(String(b.productId)));
  await ctx.db.patch(summary._id, {
    productCount: clampCount(summary.productCount + Number(!!after) - Number(!!before)),
    activeProductCount: clampCount(summary.activeProductCount + Number(after?.status === "active") - Number(before?.status === "active")),
    topProducts: products.slice(0, TOP_PRODUCT_CAP), updatedAt: Date.now(),
  });
  await refreshPortfolioSummary(ctx, dataModeOf(site));
}

/** Snapshot reducers use one compact replacement instead of one projection write per product. */
export async function rebuildSiteProductsProjection(ctx: ProjectionCtx, site: Doc<"sites">) {
  const products = await ctx.db.query("products").withIndex("by_site", (q) => q.eq("siteId", site._id)).take(501);
  if (products.length > 500) throw new Error("site product projection exceeds its bounded compact-source cap");
  const topProducts = products.map((product) => compactProduct(product, site.name))
    .sort((a, b) => b.views - a.views || (b.marginPct ?? -Infinity) - (a.marginPct ?? -Infinity) || String(a.productId).localeCompare(String(b.productId)))
    .slice(0, TOP_PRODUCT_CAP);
  const summary = await ensureSiteSummary(ctx, site);
  await ctx.db.patch(summary._id, {
    productCount: products.length,
    activeProductCount: products.filter((product) => product.status === "active").length,
    topProducts,
    updatedAt: Date.now(),
  });
  await refreshPortfolioSummary(ctx, dataModeOf(site));
}

export async function projectCreativeTransition(ctx: ProjectionCtx, before: Doc<"creatives"> | null, after: Doc<"creatives"> | null) {
  const row = after ?? before;
  if (!row) return;
  const delta = Number(after?.status === "review") - Number(before?.status === "review");
  if (delta) await changeSiteCounts(ctx, row.siteId, { reviewCreativeCount: delta });
}

function postContribution(row: Doc<"posts"> | null) {
  if (!row || row.status !== "published") return null;
  const publishedAt = row.publishedAt ?? row._creationTime;
  if (publishedAt < Date.now() - DASHBOARD_MAX_DAYS * 24 * 60 * 60 * 1000) return null;
  const observed = providerObservedPost(row);
  return {
    day: dashboardDay(publishedAt), publishedPosts: 1,
    observedPosts: observed ? 1 : 0, views: observed ? row.views ?? 0 : 0,
    engagement: observed ? row.engagement ?? 0 : 0, platform: row.platform,
  };
}

async function getOrCreateDaily(ctx: ProjectionCtx, site: Doc<"sites">, day: string) {
  const existing = await ctx.db.query("dashboardDailyRollups")
    .withIndex("by_site_day", (q) => q.eq("siteId", site._id).eq("day", day)).unique();
  if (existing) return existing;
  const id = await ctx.db.insert("dashboardDailyRollups", {
    siteId: site._id, dataMode: dataModeOf(site), day, orders: 0, revenueUsd: 0, purchases: 0,
    publishedPosts: 0, observedPosts: 0, views: 0, engagement: 0, platforms: emptyPlatforms(), updatedAt: Date.now(),
  });
  return (await ctx.db.get(id))!;
}

export async function refreshPortfolioDay(ctx: ProjectionCtx, mode: DataMode, day: string) {
  const siteRows = await ctx.db.query("dashboardDailyRollups")
    .withIndex("by_mode_day", (q) => q.eq("dataMode", mode).eq("day", day)).take(DASHBOARD_MAX_SITES);
  const totals = { orders: 0, revenueUsd: 0, purchases: 0, publishedPosts: 0, observedPosts: 0, views: 0, engagement: 0 };
  const platforms = emptyPlatforms();
  let best: any = undefined;
  for (const row of siteRows) {
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += row[key];
    for (const platform of Object.keys(platforms) as Platform[]) {
      platforms[platform].posts += row.platforms[platform].posts;
      platforms[platform].views += row.platforms[platform].views;
      platforms[platform].engagement += row.platforms[platform].engagement;
    }
    if (row.bestPost && (!best || row.bestPost.views > best.views)) {
      const site = await ctx.db.get(row.siteId);
      if (site) best = { ...row.bestPost, siteId: row.siteId, siteName: site.name };
    }
  }
  const existing = await ctx.db.query("dashboardPortfolioDailyRollups")
    .withIndex("by_mode_day", (q) => q.eq("dataMode", mode).eq("day", day)).unique();
  const value = { dataMode: mode, day, ...totals, platforms, bestPost: best, updatedAt: Date.now() };
  if (existing) await ctx.db.patch(existing._id, value);
  else await ctx.db.insert("dashboardPortfolioDailyRollups", value);
}

export async function projectPostTransition(ctx: ProjectionCtx, before: Doc<"posts"> | null, after: Doc<"posts"> | null) {
  const row = after ?? before;
  if (!row) return;
  const site = await ctx.db.get(row.siteId);
  if (!site) return;
  const beforeFact = postContribution(before);
  const afterFact = postContribution(after);
  const summary = await ensureSiteSummary(ctx, site);
  await ctx.db.patch(summary._id, {
    postCount: clampCount(summary.postCount + Number(!!after) - Number(!!before)),
    publishedPostCount: clampCount(summary.publishedPostCount + Number(after?.status === "published") - Number(before?.status === "published")),
    updatedAt: Date.now(),
  });
  for (const day of new Set([beforeFact?.day, afterFact?.day].filter((x): x is string => !!x))) {
    const daily = await getOrCreateDaily(ctx, site, day);
    const b = beforeFact?.day === day ? beforeFact : null;
    const a = afterFact?.day === day ? afterFact : null;
    const platforms = structuredClone(daily.platforms);
    if (b) {
      platforms[b.platform].posts -= b.observedPosts;
      platforms[b.platform].views -= b.views;
      platforms[b.platform].engagement -= b.engagement;
    }
    if (a) {
      platforms[a.platform].posts += a.observedPosts;
      platforms[a.platform].views += a.views;
      platforms[a.platform].engagement += a.engagement;
    }
    let bestPost = daily.bestPost;
    if (a && (!bestPost || a.views >= bestPost.views)) {
      const creative = after ? await ctx.db.get(after.creativeId) : null;
      bestPost = after ? {
        postId: after._id, creativeId: after.creativeId, platform: after.platform,
        views: a.views, engagement: a.engagement, publishedAt: after.publishedAt, r2Key: creative?.r2Key || undefined,
      } : bestPost;
    } else if (b && bestPost?.postId === before?._id && (!a || a.views < b.views)) {
      // A downward correction is rare but cannot leave a synthetic winner. Clear the winner;
      // bounded drift repair/backfill recomputes it from the authoritative page.
      bestPost = undefined;
    }
    await ctx.db.patch(daily._id, {
      publishedPosts: clampCount(daily.publishedPosts + (a?.publishedPosts ?? 0) - (b?.publishedPosts ?? 0)),
      observedPosts: clampCount(daily.observedPosts + (a?.observedPosts ?? 0) - (b?.observedPosts ?? 0)),
      views: clampCount(daily.views + (a?.views ?? 0) - (b?.views ?? 0)),
      engagement: clampCount(daily.engagement + (a?.engagement ?? 0) - (b?.engagement ?? 0)),
      platforms, bestPost, updatedAt: Date.now(),
    });
    await refreshPortfolioDay(ctx, dataModeOf(site), day);
  }
  await refreshPortfolioSummary(ctx, dataModeOf(site));
}

function commerceEligible(order: Pick<Doc<"orders">, "currencyCode" | "currentTotal" | "financialStatus" | "test" | "cancelled" | "creditAdjustmentState">, currency?: string) {
  return eligibleUsdOrder(order, currency);
}

export async function replaceSiteCommerceProjection(
  ctx: ProjectionCtx,
  site: Doc<"sites">,
  orders: Array<Pick<Doc<"orders">, "createdAt" | "currencyCode" | "currentTotal" | "financialStatus" | "test" | "cancelled" | "creditAdjustmentState" | "fulfillmentStatus">>,
) {
  const mode = dataModeOf(site);
  const grouped = new Map<string, { orders: number; revenueUsd: number; purchases: number }>();
  let open = 0;
  for (const order of orders) {
    if (!commerceEligible(order, site.storeCurrency)) continue;
    const day = dashboardDay(order.createdAt);
    const value = grouped.get(day) ?? { orders: 0, revenueUsd: 0, purchases: 0 };
    value.orders += 1; value.purchases += 1; value.revenueUsd += order.currentTotal!;
    grouped.set(day, value);
    if (order.fulfillmentStatus === "received") open++;
  }
  const existing = await ctx.db.query("dashboardDailyRollups").withIndex("by_site_day", (q) => q.eq("siteId", site._id)).order("desc").take(DASHBOARD_MAX_DAYS + 1);
  const days = new Set([...existing.map((row) => row.day), ...grouped.keys()]);
  for (const day of days) {
    const row = existing.find((candidate) => candidate.day === day) ?? await getOrCreateDaily(ctx, site, day);
    const next = grouped.get(day) ?? { orders: 0, revenueUsd: 0, purchases: 0 };
    await ctx.db.patch(row._id, { ...next, updatedAt: Date.now() });
    const portfolio = await ctx.db.query("dashboardPortfolioDailyRollups")
      .withIndex("by_mode_day", (q) => q.eq("dataMode", mode).eq("day", day)).unique();
    if (portfolio) {
      await ctx.db.patch(portfolio._id, {
        orders: clampCount(portfolio.orders + next.orders - row.orders),
        revenueUsd: Math.max(0, portfolio.revenueUsd + next.revenueUsd - row.revenueUsd),
        purchases: clampCount(portfolio.purchases + next.purchases - row.purchases),
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("dashboardPortfolioDailyRollups", {
        dataMode: mode, day, ...next, publishedPosts: 0, observedPosts: 0, views: 0,
        engagement: 0, platforms: emptyPlatforms(), updatedAt: Date.now(),
      });
    }
  }
  const summary = await ensureSiteSummary(ctx, site);
  await ctx.db.patch(summary._id, {
    orderCount: [...grouped.values()].reduce((sum, value) => sum + value.orders, 0),
    revenueUsd: [...grouped.values()].reduce((sum, value) => sum + value.revenueUsd, 0),
    openOrderCount: open, updatedAt: Date.now(),
  });
  await refreshPortfolioSummary(ctx, mode);
}

export async function rebuildSiteCommerceProjection(ctx: ProjectionCtx, siteId: Id<"sites">) {
  const site = await ctx.db.get(siteId);
  if (!site) return;
  const orders = await ctx.db.query("orders").withIndex("by_site", (q) => q.eq("siteId", siteId)).take(251);
  if (orders.length > 250) throw new Error("site commerce repair exceeds the authoritative Shopify snapshot cap");
  const current = shopifyEconomicsReadiness(site) === "current" && !!site.shopifyEconomicsSyncAttemptId;
  await replaceSiteCommerceProjection(ctx, site, current
    ? orders.filter((order) => order.shopifyEconomicsSnapshotAttemptId === site.shopifyEconomicsSyncAttemptId)
    : []);
}

export async function projectCommerceInvalidated(ctx: ProjectionCtx, site: Doc<"sites">) {
  const summary = await ensureSiteSummary(ctx, site);
  await ctx.db.patch(summary._id, { ...siteFields(site), updatedAt: Date.now() });
  await refreshPortfolioSummary(ctx, dataModeOf(site));
}

export async function refreshPortfolioSummary(ctx: ProjectionCtx, mode: DataMode) {
  const rows = await ctx.db.query("dashboardSiteSummaries").withIndex("by_mode_site", (q) => q.eq("dataMode", mode)).take(DASHBOARD_MAX_SITES);
  const topProducts = rows.flatMap((row) => row.topProducts)
    .sort((a, b) => b.views - a.views || (b.marginPct ?? -Infinity) - (a.marginPct ?? -Infinity) || String(a.productId).localeCompare(String(b.productId)))
    .slice(0, TOP_PRODUCT_CAP);
  const current = rows.length > 0 && rows.every((row) => shopifyEconomicsReadiness({
    shopifyDomain: row.shopifyDomain, storeCurrency: row.storeCurrency,
    shopifyAccessVerifiedAt: row.shopifyAccessVerifiedAt,
    shopifyEconomicsSyncStatus: row.shopifyEconomicsSyncStatus as any,
    shopifyEconomicsSyncAttemptId: row.shopifyEconomicsSyncAttemptId,
    shopifyEconomicsSyncAttemptedAt: row.shopifyEconomicsSyncAttemptedAt,
    shopifyEconomicsSyncOrderCutoffAt: row.shopifyEconomicsSyncOrderCutoffAt,
    shopifyEconomicsSyncSucceededAt: row.shopifyEconomicsSyncSucceededAt,
    shopifyEconomicsSyncExpiresAt: row.shopifyEconomicsSyncExpiresAt,
    shopifyEconomicsSyncExpiredAt: row.shopifyEconomicsSyncExpiredAt,
    shopifyEconomicsSyncExpiredAttemptId: row.shopifyEconomicsSyncExpiredAttemptId,
    shopifyEconomicsSyncSinceDays: row.shopifyEconomicsSyncSinceDays,
    shopifyEconomicsSyncProductCount: row.shopifyEconomicsSyncProductCount,
    shopifyEconomicsSyncOrderCount: row.shopifyEconomicsSyncOrderCount,
    shopifyEconomicsSnapshotProtocolVersion: row.shopifyEconomicsSnapshotProtocolVersion,
  }) === "current");
  const value = {
    dataMode: mode, siteCount: rows.length,
    pendingActionCount: rows.reduce((sum, row) => sum + row.pendingActionCount, 0),
    productCount: rows.reduce((sum, row) => sum + row.productCount, 0),
    activeProductCount: rows.reduce((sum, row) => sum + row.activeProductCount, 0),
    reviewCreativeCount: rows.reduce((sum, row) => sum + row.reviewCreativeCount, 0),
    openOrderCount: rows.reduce((sum, row) => sum + row.openOrderCount, 0),
    orderCount: rows.reduce((sum, row) => sum + row.orderCount, 0),
    revenueUsd: rows.reduce((sum, row) => sum + row.revenueUsd, 0),
    commerceVerified: current, topProducts, updatedAt: Date.now(),
  };
  const existing = await ctx.db.query("dashboardPortfolioSummaries").withIndex("by_mode", (q) => q.eq("dataMode", mode)).unique();
  if (existing) await ctx.db.patch(existing._id, value);
  else await ctx.db.insert("dashboardPortfolioSummaries", value);
}

export async function recordControlPlaneHeartbeat(ctx: ProjectionCtx, args: { component: string; checkpoint?: string }) {
  const now = Date.now();
  const existing = await ctx.db.query("dashboardControlPlaneHeartbeats").withIndex("by_component", (q) => q.eq("component", args.component)).unique();
  const value = { heartbeatAt: now, checkpointAt: args.checkpoint ? now : existing?.checkpointAt, checkpoint: args.checkpoint ?? existing?.checkpoint, updatedAt: now };
  if (existing) await ctx.db.patch(existing._id, value);
  else await ctx.db.insert("dashboardControlPlaneHeartbeats", { component: args.component, ...value });
}

export async function deleteSiteProjections(ctx: ProjectionCtx, site: Doc<"sites">) {
  const summary = await ctx.db.query("dashboardSiteSummaries").withIndex("by_site", (q) => q.eq("siteId", site._id)).unique();
  if (summary) await ctx.db.delete(summary._id);
  const daily = await ctx.db.query("dashboardDailyRollups").withIndex("by_site_day", (q) => q.eq("siteId", site._id)).take(DASHBOARD_MAX_DAYS + 1);
  const days = daily.map((row) => row.day);
  for (const row of daily) await ctx.db.delete(row._id);
  for (const day of days) await refreshPortfolioDay(ctx, dataModeOf(site), day);
  await refreshPortfolioSummary(ctx, dataModeOf(site));
}
