import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { eligibleUsdOrder } from "../src/lib/shopifyOrder";
import { shopifyEconomicsReadiness } from "../src/lib/shopifySyncState";

export const DASHBOARD_PROJECTION = "dashboard-v1";
export const DASHBOARD_MAX_SITES = 500;
export const DASHBOARD_MAX_DAYS = 180;
export const DASHBOARD_MAX_PRODUCTS_PER_SITE = 500;
export const DASHBOARD_MAX_POSTS_PER_DAY = 1_000;
const TOP_PRODUCT_CAP = 25;
const DAY_MS = 24 * 60 * 60 * 1_000;

export type ProjectionCtx = Pick<MutationCtx, "db">;
export type DataMode = "live" | "sample";
type Platform = "tiktok" | "instagram" | "youtube" | "facebook";
type ReceiptEntity = "product" | "action" | "post" | "creative";

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

export function emptyPlatforms() {
  return {
    tiktok: { posts: 0, views: 0, engagement: 0 },
    instagram: { posts: 0, views: 0, engagement: 0 },
    youtube: { posts: 0, views: 0, engagement: 0 },
    facebook: { posts: 0, views: 0, engagement: 0 },
  };
}

export function siteFields(site: Doc<"sites">) {
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

function readinessFromSummary(row: any): boolean {
  return shopifyEconomicsReadiness(row) === "current";
}

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
    .filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])]));
  return value;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function productOrder(a: any, b: any): number {
  return b.views - a.views
    || (b.marginPct ?? -Infinity) - (a.marginPct ?? -Infinity)
    || String(a.productId).localeCompare(String(b.productId));
}

function compactProduct(product: Doc<"products">, siteName: string) {
  return {
    productId: product._id, title: product.title, siteName, views: 0,
    marginPct: product.contributionMarginPct, priceUsd: product.priceUsd, trend: [], status: product.status,
  };
}

async function portfolioRow(ctx: ProjectionCtx, mode: DataMode) {
  const existing = await ctx.db.query("dashboardPortfolioSummaries").withIndex("by_mode", (q) => q.eq("dataMode", mode)).unique();
  if (existing) return existing;
  const id = await ctx.db.insert("dashboardPortfolioSummaries", {
    dataMode: mode, siteCount: 0, pendingActionCount: 0, productCount: 0,
    activeProductCount: 0, reviewCreativeCount: 0, openOrderCount: 0, orderCount: 0,
    revenueUsd: 0, commerceVerified: false, commerceCurrentSiteCount: 0, topProducts: [], updatedAt: Date.now(),
  });
  return (await ctx.db.get(id))!;
}

const portfolioCountKeys = [
  "pendingActionCount", "productCount", "activeProductCount", "reviewCreativeCount",
  "openOrderCount", "orderCount", "revenueUsd",
] as const;

async function applyPortfolioSummaryTransition(ctx: ProjectionCtx, before: any | null, after: any | null) {
  const modes = new Set<DataMode>([before?.dataMode, after?.dataMode].filter(Boolean));
  for (const mode of modes) {
    const row = await portfolioRow(ctx, mode);
    const b = before?.dataMode === mode ? before : null;
    const a = after?.dataMode === mode ? after : null;
    const patch: any = {
      siteCount: Math.max(0, row.siteCount + Number(!!a) - Number(!!b)), updatedAt: Date.now(),
    };
    for (const key of portfolioCountKeys) patch[key] = Math.max(0, row[key] + (a?.[key] ?? 0) - (b?.[key] ?? 0));
    const currentCount = (row.commerceCurrentSiteCount ?? 0)
      + Number(!!a && readinessFromSummary(a)) - Number(!!b && readinessFromSummary(b));
    patch.commerceCurrentSiteCount = Math.max(0, currentCount);
    patch.commerceVerified = patch.siteCount > 0 && patch.commerceCurrentSiteCount === patch.siteCount;

    const oldTop = b?.topProducts ?? [];
    const newTop = a?.topProducts ?? [];
    if (!same(oldTop, newTop)) {
      const oldById = new Map(oldTop.map((p: any) => [String(p.productId), p]));
      const newById = new Map(newTop.map((p: any) => [String(p.productId), p]));
      const invalidated = row.topProducts.some((p) => {
        const old = oldById.get(String(p.productId));
        return old && !same(old, newById.get(String(p.productId)));
      });
      if (invalidated) {
        await ctx.db.patch(row._id, patch);
        await refreshPortfolioSummary(ctx, mode);
        continue;
      }
      patch.topProducts = [...row.topProducts, ...newTop]
        .filter((p, index, all) => all.findIndex((x) => x.productId === p.productId) === index)
        .sort(productOrder).slice(0, TOP_PRODUCT_CAP);
    }
    await ctx.db.patch(row._id, patch);
  }
}

export async function ensureSiteSummary(ctx: ProjectionCtx, site: Doc<"sites">) {
  const existing = await ctx.db.query("dashboardSiteSummaries").withIndex("by_site", (q) => q.eq("siteId", site._id)).unique();
  if (existing) return existing;
  const id = await ctx.db.insert("dashboardSiteSummaries", {
    siteId: site._id, ...siteFields(site), productCount: 0, activeProductCount: 0,
    pendingActionCount: 0, postCount: 0, publishedPostCount: 0, reviewCreativeCount: 0,
    openOrderCount: 0, orderCount: 0, revenueUsd: 0, topProducts: [], updatedAt: Date.now(),
  });
  const created = (await ctx.db.get(id))!;
  const modeRows = await ctx.db.query("dashboardSiteSummaries").withIndex("by_mode_site", (q) => q.eq("dataMode", dataModeOf(site))).take(DASHBOARD_MAX_SITES + 1);
  if (modeRows.length > DASHBOARD_MAX_SITES) throw new Error(`portfolio ${dataModeOf(site)} exceeds ${DASHBOARD_MAX_SITES} sites`);
  await applyPortfolioSummaryTransition(ctx, null, created);
  return created;
}

async function patchSiteSummary(ctx: ProjectionCtx, site: Doc<"sites">, patch: Record<string, unknown>, updatePortfolio = true) {
  const before = await ensureSiteSummary(ctx, site);
  await ctx.db.patch(before._id, { ...patch, updatedAt: Date.now() });
  const after = (await ctx.db.get(before._id))!;
  if (updatePortfolio) await applyPortfolioSummaryTransition(ctx, before, after);
  return after;
}

export async function projectSite(ctx: ProjectionCtx, site: Doc<"sites">) {
  const before = await ensureSiteSummary(ctx, site);
  const renamedTop = before.name === site.name
    ? before.topProducts : before.topProducts.map((product) => ({ ...product, siteName: site.name }));
  await patchSiteSummary(ctx, site, { ...siteFields(site), topProducts: renamedTop });
  if (before.dataMode !== dataModeOf(site)) {
    const daily = await ctx.db.query("dashboardDailyRollups").withIndex("by_site_day", (q) => q.eq("siteId", site._id)).take(DASHBOARD_MAX_DAYS + 1);
    if (daily.length > DASHBOARD_MAX_DAYS) throw new Error(`site ${site._id} exceeds rolling mode-transfer bound`);
    for (const row of daily) {
      const zero = { ...row, orders: 0, revenueUsd: 0, purchases: 0, publishedPosts: 0, observedPosts: 0, views: 0, engagement: 0, platforms: emptyPlatforms(), bestPost: undefined };
      await applyPortfolioDayTransition(ctx, site, row, zero, before.dataMode);
      await ctx.db.patch(row._id, { dataMode: dataModeOf(site), updatedAt: Date.now() });
      const moved = (await ctx.db.get(row._id))!;
      await applyPortfolioDayTransition(ctx, site, zero, moved, dataModeOf(site));
    }
    const creatives = await ctx.db.query("creatives").withIndex("by_site_status", (q) => q.eq("siteId", site._id)).take(5_001);
    if (creatives.length > 5_000) throw new Error(`site ${site._id} exceeds bounded queue mode transfer`);
    for (const creative of creatives) await ctx.db.patch(creative._id, { dashboardDataMode: dataModeOf(site) });
  }
  // Every freshness transition away from current withholds the previous snapshot immediately.
  if (shopifyEconomicsReadiness(site) !== "current" && (before.orderCount || before.revenueUsd || before.openOrderCount)) {
    await replaceSiteCommerceProjection(ctx, site, []);
  }
}

async function receipt(ctx: ProjectionCtx, entity: ReceiptEntity, sourceId: string) {
  return ctx.db.query("dashboardProjectionReceipts")
    .withIndex("by_entity_source", (q) => q.eq("entity", entity).eq("sourceId", sourceId)).unique();
}

async function commitReceipt(ctx: ProjectionCtx, entity: ReceiptEntity, sourceId: string, siteId: Id<"sites"> | null, contribution: any | null) {
  const existing = await receipt(ctx, entity, sourceId);
  if (!contribution) {
    if (existing) await ctx.db.delete(existing._id);
    return;
  }
  const value = { entity, sourceId, siteId: siteId!, contribution, updatedAt: Date.now() };
  if (existing) await ctx.db.patch(existing._id, value);
  else await ctx.db.insert("dashboardProjectionReceipts", value);
}

async function authoritativeProducts(ctx: ProjectionCtx, site: Doc<"sites">) {
  const products = await ctx.db.query("products").withIndex("by_site", (q) => q.eq("siteId", site._id)).take(DASHBOARD_MAX_PRODUCTS_PER_SITE + 1);
  if (products.length > DASHBOARD_MAX_PRODUCTS_PER_SITE) throw new Error(`site ${site._id} product projection exceeds ${DASHBOARD_MAX_PRODUCTS_PER_SITE}; page or reduce source truth before continuing`);
  return products;
}

export async function projectProductTransition(ctx: ProjectionCtx, _before: Doc<"products"> | null, after: Doc<"products"> | null) {
  const source = after ?? _before;
  if (!source) return;
  const priorReceipt = await receipt(ctx, "product", String(source._id));
  const prior = priorReceipt?.contribution ?? null;
  const site = after ? await ctx.db.get(after.siteId) : priorReceipt ? await ctx.db.get(priorReceipt.siteId) : null;
  const desired = after && site ? { siteId: after.siteId, active: after.status === "active", product: compactProduct(after, site.name) } : null;
  if (same(prior, desired)) return;

  const siteIds = new Set<Id<"sites">>([prior?.siteId, desired?.siteId].filter(Boolean));
  for (const siteId of siteIds) {
    const targetSite = await ctx.db.get(siteId);
    if (!targetSite) continue;
    const summary = await ensureSiteSummary(ctx, targetSite);
    const b = prior?.siteId === siteId ? prior : null;
    const a = desired?.siteId === siteId ? desired : null;
    const retainedWasTouched = !!b && summary.topProducts.some((p) => p.productId === source._id);
    let topProducts: any[];
    if (retainedWasTouched) {
      topProducts = (await authoritativeProducts(ctx, targetSite)).map((p) => compactProduct(p, targetSite.name)).sort(productOrder).slice(0, TOP_PRODUCT_CAP);
    } else {
      topProducts = summary.topProducts.filter((p) => p.productId !== source._id);
      if (a) topProducts.push(a.product);
      topProducts = topProducts.sort(productOrder).slice(0, TOP_PRODUCT_CAP);
    }
    await patchSiteSummary(ctx, targetSite, {
      productCount: Math.max(0, summary.productCount + Number(!!a) - Number(!!b)),
      activeProductCount: Math.max(0, summary.activeProductCount + Number(!!a?.active) - Number(!!b?.active)),
      topProducts,
    });
  }
  await commitReceipt(ctx, "product", String(source._id), desired?.siteId ?? null, desired);
}

/** Snapshot reducers use one bounded authoritative replacement and refresh receipts atomically. */
export async function rebuildSiteProductsProjection(ctx: ProjectionCtx, site: Doc<"sites">) {
  const products = await authoritativeProducts(ctx, site);
  const summary = await ensureSiteSummary(ctx, site);
  const topProducts = products.map((product) => compactProduct(product, site.name)).sort(productOrder).slice(0, TOP_PRODUCT_CAP);
  await patchSiteSummary(ctx, site, {
    productCount: products.length,
    activeProductCount: products.filter((product) => product.status === "active").length,
    topProducts,
  });
  for (const product of products) {
    await commitReceipt(ctx, "product", String(product._id), site._id, {
      siteId: site._id, active: product.status === "active", product: compactProduct(product, site.name),
    });
  }
  // Summary was captured before the patch only to preserve a stable transactional dependency.
  void summary;
}

async function changeReceiptCount(ctx: ProjectionCtx, entity: "action" | "creative", source: any, after: any | null, field: "pendingActionCount" | "reviewCreativeCount", active: (row: any) => boolean) {
  const priorReceipt = await receipt(ctx, entity, String(source._id));
  const prior = priorReceipt?.contribution ?? null;
  const desired = after ? { siteId: after.siteId, active: active(after) } : null;
  if (same(prior, desired)) return;
  const siteIds = new Set<Id<"sites">>([prior?.siteId, desired?.siteId].filter(Boolean));
  for (const siteId of siteIds) {
    const site = await ctx.db.get(siteId);
    if (!site) continue;
    const summary = await ensureSiteSummary(ctx, site);
    const b = prior?.siteId === siteId && prior.active ? 1 : 0;
    const a = desired?.siteId === siteId && desired.active ? 1 : 0;
    await patchSiteSummary(ctx, site, { [field]: Math.max(0, summary[field] + a - b) });
  }
  await commitReceipt(ctx, entity, String(source._id), desired?.siteId ?? null, desired);
}

export async function projectActionTransition(ctx: ProjectionCtx, before: Doc<"actions"> | null, after: Doc<"actions"> | null) {
  const source = after ?? before;
  if (source) await changeReceiptCount(ctx, "action", source, after, "pendingActionCount", (row) => row.status === "pending_approval");
}

export async function projectCreativeTransition(ctx: ProjectionCtx, before: Doc<"creatives"> | null, after: Doc<"creatives"> | null) {
  const source = after ?? before;
  if (!source) return;
  let normalized = after;
  if (after) {
    const site = await ctx.db.get(after.siteId);
    if (!site) return;
    const dashboardDataMode = dataModeOf(site);
    const queueState = after.status === "review" ? "review"
      : after.status === "approved" && after.publicationAuthorized !== true ? "publication_authorization" : "none";
    if (after.dashboardDataMode !== dashboardDataMode || after.queueState !== queueState) {
      await ctx.db.patch(after._id, { dashboardDataMode, queueState });
      normalized = (await ctx.db.get(after._id))!;
    }
  }
  await changeReceiptCount(ctx, "creative", source, normalized, "reviewCreativeCount", (row) => row.status === "review");
}

function postContribution(row: Doc<"posts"> | null) {
  if (!row) return null;
  const publishedAt = row.publishedAt ?? row._creationTime;
  const inWindow = row.status === "published" && publishedAt >= Date.now() - DASHBOARD_MAX_DAYS * DAY_MS;
  const observed = inWindow && providerObservedPost(row);
  return {
    siteId: row.siteId, exists: true, published: row.status === "published",
    fact: inWindow ? {
      day: dashboardDay(publishedAt), publishedPosts: 1, observedPosts: observed ? 1 : 0,
      views: observed ? row.views ?? 0 : 0, engagement: observed ? row.engagement ?? 0 : 0,
      platform: row.platform, postId: row._id, creativeId: row.creativeId,
      publishedAt: row.publishedAt,
    } : null,
  };
}

async function getOrCreateDaily(ctx: ProjectionCtx, site: Doc<"sites">, day: string) {
  const existing = await ctx.db.query("dashboardDailyRollups").withIndex("by_site_day", (q) => q.eq("siteId", site._id).eq("day", day)).unique();
  if (existing) return existing;
  const id = await ctx.db.insert("dashboardDailyRollups", {
    siteId: site._id, dataMode: dataModeOf(site), day, orders: 0, revenueUsd: 0, purchases: 0,
    commerceProjected: false, publishedPosts: 0, observedPosts: 0, views: 0, engagement: 0,
    platforms: emptyPlatforms(), updatedAt: Date.now(),
  });
  return (await ctx.db.get(id))!;
}

async function portfolioDailyRow(ctx: ProjectionCtx, mode: DataMode, day: string) {
  const existing = await ctx.db.query("dashboardPortfolioDailyRollups").withIndex("by_mode_day", (q) => q.eq("dataMode", mode).eq("day", day)).unique();
  if (existing) return existing;
  const id = await ctx.db.insert("dashboardPortfolioDailyRollups", {
    dataMode: mode, day, orders: 0, revenueUsd: 0, purchases: 0, publishedPosts: 0,
    observedPosts: 0, views: 0, engagement: 0, platforms: emptyPlatforms(), updatedAt: Date.now(),
  });
  return (await ctx.db.get(id))!;
}

async function bestForSiteDay(ctx: ProjectionCtx, siteId: Id<"sites">, day: string) {
  const posts = await ctx.db.query("posts").withIndex("by_site_dashboard_day", (q) => q.eq("siteId", siteId).eq("dashboardPublishedDay", day)).take(DASHBOARD_MAX_POSTS_PER_DAY + 1);
  if (posts.length > DASHBOARD_MAX_POSTS_PER_DAY) throw new Error(`site ${siteId} day ${day} exceeds bounded post-winner recomputation`);
  const best = posts.filter((post) => post.status === "published" && providerObservedPost(post))
    .sort((a, b) => (b.views ?? 0) - (a.views ?? 0) || String(a._id).localeCompare(String(b._id)))[0];
  if (!best) return undefined;
  const creative = await ctx.db.get(best.creativeId);
  return {
    postId: best._id, creativeId: best.creativeId, platform: best.platform,
    views: best.views ?? 0, engagement: best.engagement ?? 0, publishedAt: best.publishedAt,
    r2Key: creative?.r2Key || undefined,
  };
}

async function recomputePortfolioBest(ctx: ProjectionCtx, mode: DataMode, day: string) {
  const rows = await ctx.db.query("dashboardDailyRollups").withIndex("by_mode_day", (q) => q.eq("dataMode", mode).eq("day", day)).take(DASHBOARD_MAX_SITES + 1);
  if (rows.length > DASHBOARD_MAX_SITES) throw new Error(`portfolio ${mode} exceeds ${DASHBOARD_MAX_SITES} sites`);
  const winner = rows.filter((row) => row.bestPost).sort((a, b) => b.bestPost!.views - a.bestPost!.views || String(a.bestPost!.postId).localeCompare(String(b.bestPost!.postId)))[0];
  if (!winner?.bestPost) return undefined;
  const site = await ctx.db.get(winner.siteId);
  return site ? { ...winner.bestPost, siteId: winner.siteId, siteName: site.name } : undefined;
}

async function applyPortfolioDayTransition(ctx: ProjectionCtx, site: Doc<"sites">, before: any, after: any, mode: DataMode = dataModeOf(site)) {
  const row = await portfolioDailyRow(ctx, mode, after.day);
  const platforms = structuredClone(row.platforms);
  for (const platform of Object.keys(platforms) as Platform[]) {
    for (const key of ["posts", "views", "engagement"] as const) {
      platforms[platform][key] = Math.max(0, platforms[platform][key] + after.platforms[platform][key] - before.platforms[platform][key]);
    }
  }
  let bestPost = row.bestPost;
  const oldSiteBest = before.bestPost;
  const newSiteBest = after.bestPost;
  const invalidated = !!oldSiteBest && row.bestPost?.postId === oldSiteBest.postId && !same(oldSiteBest, newSiteBest);
  if (invalidated) bestPost = await recomputePortfolioBest(ctx, mode, after.day);
  else if (newSiteBest && (!bestPost || newSiteBest.views > bestPost.views
    || (newSiteBest.views === bestPost.views && String(newSiteBest.postId) < String(bestPost.postId)))) {
    bestPost = { ...newSiteBest, siteId: site._id, siteName: site.name };
  }
  const patch: any = { platforms, bestPost, updatedAt: Date.now() };
  for (const key of ["orders", "revenueUsd", "purchases", "publishedPosts", "observedPosts", "views", "engagement"] as const) {
    patch[key] = Math.max(0, row[key] + after[key] - before[key]);
  }
  await ctx.db.patch(row._id, patch);
}

async function patchDaily(ctx: ProjectionCtx, site: Doc<"sites">, before: any, patch: any) {
  await ctx.db.patch(before._id, { ...patch, updatedAt: Date.now() });
  const after = (await ctx.db.get(before._id))!;
  await applyPortfolioDayTransition(ctx, site, before, after);
  return after;
}

async function applyPostFactDay(ctx: ProjectionCtx, site: Doc<"sites">, day: string, b: any | null, a: any | null) {
  const daily = await getOrCreateDaily(ctx, site, day);
  const platforms = structuredClone(daily.platforms);
  for (const fact of [b && { sign: -1, fact: b }, a && { sign: 1, fact: a }].filter(Boolean) as any[]) {
    const platform = fact.fact.platform as Platform;
    platforms[platform].posts += fact.sign * fact.fact.observedPosts;
    platforms[platform].views += fact.sign * fact.fact.views;
    platforms[platform].engagement += fact.sign * fact.fact.engagement;
  }
  let bestPost = daily.bestPost;
  const invalidated = !!b && bestPost?.postId === b.postId && (!a || a.views < b.views || a.observedPosts === 0);
  if (invalidated) bestPost = await bestForSiteDay(ctx, site._id, day);
  else if (a?.observedPosts && (!bestPost || a.views > bestPost.views
    || (a.views === bestPost.views && String(a.postId) < String(bestPost.postId)))) {
    const creative = await ctx.db.get(a.creativeId as Id<"creatives">);
    bestPost = {
      postId: a.postId, creativeId: a.creativeId, platform: a.platform, views: a.views,
      engagement: a.engagement, publishedAt: a.publishedAt, r2Key: creative?.r2Key || undefined,
    };
  }
  await patchDaily(ctx, site, daily, {
    publishedPosts: Math.max(0, daily.publishedPosts + (a?.publishedPosts ?? 0) - (b?.publishedPosts ?? 0)),
    observedPosts: Math.max(0, daily.observedPosts + (a?.observedPosts ?? 0) - (b?.observedPosts ?? 0)),
    views: Math.max(0, daily.views + (a?.views ?? 0) - (b?.views ?? 0)),
    engagement: Math.max(0, daily.engagement + (a?.engagement ?? 0) - (b?.engagement ?? 0)),
    platforms, bestPost,
  });
}

async function pruneExpiredSiteDays(ctx: ProjectionCtx, site: Doc<"sites">) {
  const cutoff = dashboardDay(Date.now() - (DASHBOARD_MAX_DAYS - 1) * DAY_MS);
  const expired = await ctx.db.query("dashboardDailyRollups").withIndex("by_site_day", (q) => q.eq("siteId", site._id).lt("day", cutoff)).take(DASHBOARD_MAX_DAYS + 1);
  if (expired.length > DASHBOARD_MAX_DAYS) throw new Error(`site ${site._id} has more than ${DASHBOARD_MAX_DAYS} expired rollups; use paged migration repair`);
  for (const row of expired) {
    const zero = { ...row, orders: 0, revenueUsd: 0, purchases: 0, publishedPosts: 0, observedPosts: 0, views: 0, engagement: 0, platforms: emptyPlatforms(), bestPost: undefined };
    await applyPortfolioDayTransition(ctx, site, row, zero);
    await ctx.db.delete(row._id);
    const remaining = await ctx.db.query("dashboardDailyRollups").withIndex("by_mode_day", (q) => q.eq("dataMode", dataModeOf(site)).eq("day", row.day)).first();
    if (!remaining) {
      const portfolio = await ctx.db.query("dashboardPortfolioDailyRollups").withIndex("by_mode_day", (q) => q.eq("dataMode", dataModeOf(site)).eq("day", row.day)).unique();
      if (portfolio) await ctx.db.delete(portfolio._id);
    }
  }
  // A portfolio can contain staggered inactive sites, so its retention cannot depend on every
  // site receiving another write. Any mode write enforces the global rolling boundary directly.
  const expiredPortfolio = await ctx.db.query("dashboardPortfolioDailyRollups")
    .withIndex("by_mode_day", (q) => q.eq("dataMode", dataModeOf(site)).lt("day", cutoff)).take(DASHBOARD_MAX_DAYS + 1);
  if (expiredPortfolio.length > DASHBOARD_MAX_DAYS) throw new Error(`portfolio ${dataModeOf(site)} exceeds bounded retention cleanup`);
  for (const row of expiredPortfolio) await ctx.db.delete(row._id);
}

export async function projectPostTransition(ctx: ProjectionCtx, before: Doc<"posts"> | null, after: Doc<"posts"> | null) {
  const source = after ?? before;
  if (!source) return;
  let normalized = after;
  if (after) {
    const desiredDay = after.status === "published" ? dashboardDay(after.publishedAt ?? after._creationTime) : undefined;
    if (after.dashboardPublishedDay !== desiredDay) {
      await ctx.db.patch(after._id, { dashboardPublishedDay: desiredDay });
      normalized = (await ctx.db.get(after._id))!;
    }
  }
  const priorReceipt = await receipt(ctx, "post", String(source._id));
  const prior = priorReceipt?.contribution ?? null;
  const desired = postContribution(normalized);
  if (same(prior, desired)) return;
  const siteIds = new Set<Id<"sites">>([prior?.siteId, desired?.siteId].filter(Boolean));
  for (const siteId of siteIds) {
    const site = await ctx.db.get(siteId);
    if (!site) continue;
    const summary = await ensureSiteSummary(ctx, site);
    const b = prior?.siteId === siteId ? prior : null;
    const a = desired?.siteId === siteId ? desired : null;
    await patchSiteSummary(ctx, site, {
      postCount: Math.max(0, summary.postCount + Number(!!a?.exists) - Number(!!b?.exists)),
      publishedPostCount: Math.max(0, summary.publishedPostCount + Number(!!a?.published) - Number(!!b?.published)),
    }, false);
    for (const day of new Set<string>([b?.fact?.day, a?.fact?.day].filter(Boolean))) {
      await applyPostFactDay(ctx, site, day, b?.fact?.day === day ? b.fact : null, a?.fact?.day === day ? a.fact : null);
    }
    await pruneExpiredSiteDays(ctx, site);
  }
  await commitReceipt(ctx, "post", String(source._id), desired?.siteId ?? null, desired);
}

function commerceEligible(order: Pick<Doc<"orders">, "currencyCode" | "currentTotal" | "financialStatus" | "test" | "cancelled" | "creditAdjustmentState">, currency?: string) {
  return eligibleUsdOrder(order, currency);
}

export async function replaceSiteCommerceProjection(
  ctx: ProjectionCtx,
  site: Doc<"sites">,
  orders: Array<Pick<Doc<"orders">, "createdAt" | "currencyCode" | "currentTotal" | "financialStatus" | "test" | "cancelled" | "creditAdjustmentState" | "fulfillmentStatus">>,
) {
  const eligible = orders.filter((order) => commerceEligible(order, site.storeCurrency));
  const cutoff = dashboardDay(Date.now() - (DASHBOARD_MAX_DAYS - 1) * DAY_MS);
  const grouped = new Map<string, { orders: number; revenueUsd: number; purchases: number }>();
  for (const order of eligible) {
    const day = dashboardDay(order.createdAt);
    if (day < cutoff) continue;
    const value = grouped.get(day) ?? { orders: 0, revenueUsd: 0, purchases: 0 };
    value.orders++; value.purchases++; value.revenueUsd += order.currentTotal!; grouped.set(day, value);
  }
  const previous = await ctx.db.query("dashboardDailyRollups")
    .withIndex("by_site_commerce_day", (q) => q.eq("siteId", site._id).eq("commerceProjected", true)).take(DASHBOARD_MAX_DAYS + 1);
  if (previous.length > DASHBOARD_MAX_DAYS) throw new Error(`site ${site._id} commerce projection exceeds rolling day bound`);
  const byDay = new Map(previous.map((row) => [row.day, row]));
  for (const day of new Set([...byDay.keys(), ...grouped.keys()])) {
    const row = byDay.get(day) ?? await getOrCreateDaily(ctx, site, day);
    const next = grouped.get(day) ?? { orders: 0, revenueUsd: 0, purchases: 0 };
    await patchDaily(ctx, site, row, { ...next, commerceProjected: grouped.has(day) });
  }
  const summary = await ensureSiteSummary(ctx, site);
  await patchSiteSummary(ctx, site, {
    ...siteFields(site), orderCount: eligible.length,
    revenueUsd: eligible.reduce((sum, order) => sum + order.currentTotal!, 0),
    openOrderCount: eligible.filter((order) => order.fulfillmentStatus === "received").length,
  });
  void summary;
  await pruneExpiredSiteDays(ctx, site);
}

export async function rebuildSiteCommerceProjection(ctx: ProjectionCtx, siteId: Id<"sites">) {
  const site = await ctx.db.get(siteId);
  if (!site) return;
  const orders = await ctx.db.query("orders").withIndex("by_site", (q) => q.eq("siteId", siteId)).take(251);
  if (orders.length > 250) throw new Error("site commerce repair exceeds the authoritative Shopify snapshot cap");
  const current = shopifyEconomicsReadiness(site) === "current" && !!site.shopifyEconomicsSyncAttemptId;
  await replaceSiteCommerceProjection(ctx, site, current
    ? orders.filter((order) => order.shopifyEconomicsSnapshotAttemptId === site.shopifyEconomicsSyncAttemptId) : []);
}

export async function projectCommerceInvalidated(ctx: ProjectionCtx, site: Doc<"sites">) {
  await replaceSiteCommerceProjection(ctx, site, []);
}

/** Bounded exact rebuild, reserved for migration/repair and extrema invalidation. */
export async function refreshPortfolioSummary(ctx: ProjectionCtx, mode: DataMode) {
  const rows = await ctx.db.query("dashboardSiteSummaries").withIndex("by_mode_site", (q) => q.eq("dataMode", mode)).take(DASHBOARD_MAX_SITES + 1);
  if (rows.length > DASHBOARD_MAX_SITES) throw new Error(`portfolio ${mode} exceeds ${DASHBOARD_MAX_SITES} sites; page source truth before activation`);
  const currentCount = rows.filter(readinessFromSummary).length;
  const value = {
    dataMode: mode, siteCount: rows.length,
    pendingActionCount: rows.reduce((sum, row) => sum + row.pendingActionCount, 0),
    productCount: rows.reduce((sum, row) => sum + row.productCount, 0),
    activeProductCount: rows.reduce((sum, row) => sum + row.activeProductCount, 0),
    reviewCreativeCount: rows.reduce((sum, row) => sum + row.reviewCreativeCount, 0),
    openOrderCount: rows.reduce((sum, row) => sum + row.openOrderCount, 0),
    orderCount: rows.reduce((sum, row) => sum + row.orderCount, 0),
    revenueUsd: rows.reduce((sum, row) => sum + row.revenueUsd, 0),
    commerceVerified: rows.length > 0 && currentCount === rows.length,
    commerceCurrentSiteCount: currentCount,
    topProducts: rows.flatMap((row) => row.topProducts).sort(productOrder).slice(0, TOP_PRODUCT_CAP),
    updatedAt: Date.now(),
  };
  const existing = await ctx.db.query("dashboardPortfolioSummaries").withIndex("by_mode", (q) => q.eq("dataMode", mode)).unique();
  if (existing) await ctx.db.patch(existing._id, value);
  else await ctx.db.insert("dashboardPortfolioSummaries", value);
}

export async function refreshPortfolioDay(ctx: ProjectionCtx, mode: DataMode, day: string) {
  const siteRows = await ctx.db.query("dashboardDailyRollups").withIndex("by_mode_day", (q) => q.eq("dataMode", mode).eq("day", day)).take(DASHBOARD_MAX_SITES + 1);
  if (siteRows.length > DASHBOARD_MAX_SITES) throw new Error(`portfolio ${mode} day ${day} exceeds site bound`);
  const totals = { orders: 0, revenueUsd: 0, purchases: 0, publishedPosts: 0, observedPosts: 0, views: 0, engagement: 0 };
  const platforms = emptyPlatforms();
  for (const row of siteRows) {
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += row[key];
    for (const platform of Object.keys(platforms) as Platform[]) for (const key of ["posts", "views", "engagement"] as const) platforms[platform][key] += row.platforms[platform][key];
  }
  const bestPost = await recomputePortfolioBest(ctx, mode, day);
  const existing = await ctx.db.query("dashboardPortfolioDailyRollups").withIndex("by_mode_day", (q) => q.eq("dataMode", mode).eq("day", day)).unique();
  const value = { dataMode: mode, day, ...totals, platforms, bestPost, updatedAt: Date.now() };
  if (existing) await ctx.db.patch(existing._id, value); else await ctx.db.insert("dashboardPortfolioDailyRollups", value);
}

export async function resetSiteProjectionReceipts(ctx: ProjectionCtx, siteId: Id<"sites">) {
  for (const entity of ["product", "action", "post", "creative"] as const) {
    const rows = await ctx.db.query("dashboardProjectionReceipts").withIndex("by_site_entity", (q) => q.eq("siteId", siteId).eq("entity", entity)).take(5_001);
    if (rows.length > 5_000) throw new Error(`site ${siteId} exceeds bounded ${entity} receipt repair`);
    for (const row of rows) await ctx.db.delete(row._id);
  }
}

export async function recordControlPlaneHeartbeat(ctx: ProjectionCtx, args: { component: string; checkpoint?: string }) {
  const now = Date.now();
  const existing = await ctx.db.query("dashboardControlPlaneHeartbeats").withIndex("by_component", (q) => q.eq("component", args.component)).unique();
  const value = { heartbeatAt: now, checkpointAt: args.checkpoint ? now : existing?.checkpointAt, checkpoint: args.checkpoint ?? existing?.checkpoint, updatedAt: now };
  if (existing) await ctx.db.patch(existing._id, value); else await ctx.db.insert("dashboardControlPlaneHeartbeats", { component: args.component, ...value });
}

export async function deleteSiteProjections(ctx: ProjectionCtx, site: Doc<"sites">) {
  await resetSiteProjectionReceipts(ctx, site._id);
  const summary = await ctx.db.query("dashboardSiteSummaries").withIndex("by_site", (q) => q.eq("siteId", site._id)).unique();
  if (summary) {
    await applyPortfolioSummaryTransition(ctx, summary, null);
    await ctx.db.delete(summary._id);
  }
  const daily = await ctx.db.query("dashboardDailyRollups").withIndex("by_site_day", (q) => q.eq("siteId", site._id)).take(DASHBOARD_MAX_DAYS + 1);
  if (daily.length > DASHBOARD_MAX_DAYS) throw new Error(`site ${site._id} exceeds rolling daily bound`);
  for (const row of daily) {
    const zero = { ...row, orders: 0, revenueUsd: 0, purchases: 0, publishedPosts: 0, observedPosts: 0, views: 0, engagement: 0, platforms: emptyPlatforms(), bestPost: undefined };
    await applyPortfolioDayTransition(ctx, site, row, zero);
    await ctx.db.delete(row._id);
    const remaining = await ctx.db.query("dashboardDailyRollups").withIndex("by_mode_day", (q) => q.eq("dataMode", dataModeOf(site)).eq("day", row.day)).first();
    if (!remaining) {
      const portfolio = await ctx.db.query("dashboardPortfolioDailyRollups").withIndex("by_mode_day", (q) => q.eq("dataMode", dataModeOf(site)).eq("day", row.day)).unique();
      if (portfolio) await ctx.db.delete(portfolio._id);
    }
  }
}
