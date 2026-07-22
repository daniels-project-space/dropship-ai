// Resumable dashboard-v1 rollout. Every page and its cursor commit atomically, so replaying a
// network response cannot double-apply a source contribution. Direct dashboard-table edits are
// outside the supported mutation contract and must be corrected through verifyPage/repairSite.
import { mutation } from "./authz";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
  DASHBOARD_MAX_DAYS,
  DASHBOARD_PROJECTION,
  ensureSiteSummary,
  projectActionTransition,
  projectCreativeTransition,
  projectPostTransition,
  projectProductTransition,
  projectSite,
  providerObservedPost,
  dashboardDay,
  dataModeOf,
  refreshPortfolioDay,
  recordControlPlaneHeartbeat,
  refreshPortfolioSummary,
  replaceSiteCommerceProjection,
  resetSiteProjectionReceipts,
  emptyPlatforms,
  siteFields,
} from "./dashboardProjections";
import { eligibleUsdOrder } from "../src/lib/shopifyOrder";
import { shopifyEconomicsReadiness } from "../src/lib/shopifySyncState";

const entity = v.union(
  v.literal("sites"), v.literal("products"), v.literal("actions"),
  v.literal("posts"), v.literal("creatives"), v.literal("commerce-sites"),
);
const ENTITIES = ["sites", "products", "actions", "posts", "creatives", "commerce-sites"] as const;
const VERIFY_SOURCE_CAP = 5_000;

async function migrationRow(ctx: any, name: string) {
  return ctx.db.query("dashboardProjectionMigrations")
    .withIndex("by_name_entity", (q: any) => q.eq("name", DASHBOARD_PROJECTION).eq("entity", name)).unique();
}

export const start = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await migrationRow(ctx, "read-switch");
    if (existing) return { reused: true as const, phase: existing.phase };
    const now = Date.now();
    for (const name of [...ENTITIES, "verification", "read-switch"]) {
      await ctx.db.insert("dashboardProjectionMigrations", {
        name: DASHBOARD_PROJECTION, entity: name, phase: "backfilling", completed: false,
        verified: false, driftCount: 0, processed: 0, updatedAt: now,
      });
    }
    return { reused: false as const, phase: "backfilling" as const };
  },
});

async function sourcePage(ctx: any, name: typeof ENTITIES[number], opts: { cursor: string | null; numItems: number }) {
  switch (name) {
    case "sites": return ctx.db.query("sites").paginate(opts);
    case "products": return ctx.db.query("products").paginate(opts);
    case "actions": return ctx.db.query("actions").paginate(opts);
    case "posts": return ctx.db.query("posts").paginate(opts);
    case "creatives": return ctx.db.query("creatives").paginate(opts);
    case "commerce-sites": return ctx.db.query("sites").paginate(opts);
  }
}

export const backfillPage = mutation({
  args: { entity, paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const state = await migrationRow(ctx, args.entity);
    if (!state) throw new Error("dashboard-v1 migration has not been started");
    if (state.completed) return { continueCursor: state.cursor ?? null, isDone: true, processed: state.processed, reused: true };
    // The durable cursor, not a caller-selected cursor, is the idempotency boundary.
    if ((args.paginationOpts.cursor ?? null) !== (state.cursor ?? null)) throw new Error("dashboard-v1 cursor is stale");
    // Projection helpers deliberately refresh compact portfolio state in the same transaction.
    // Keep contribution pages single-row so a 200-site portfolio cannot multiply those reads
    // inside one Convex transaction; site bootstrap itself is safe at 25 compact rows.
    const numItems = Math.min(args.paginationOpts.numItems, args.entity === "sites" ? 25 : 1);
    const page = await sourcePage(ctx, args.entity, { cursor: state.cursor ?? null, numItems });
    for (const source of page.page as any[]) {
      switch (args.entity) {
        case "sites": await projectSite(ctx, source); break;
        case "products": await projectProductTransition(ctx, null, source); break;
        case "actions": await projectActionTransition(ctx, null, source); break;
        case "posts": await projectPostTransition(ctx, null, source); break;
        case "creatives": {
          const dispatch = source.status === "approved"
            ? await ctx.db.query("distributionDispatches").withIndex("by_creative", (q: any) => q.eq("creativeId", source._id)).first() : null;
          const publicationAuthorized = !!dispatch;
          const queueState = source.status === "review" ? "review"
            : source.status === "approved" && !publicationAuthorized ? "publication_authorization" : "none";
          if (source.queueState !== queueState || source.publicationAuthorized !== publicationAuthorized) {
            await ctx.db.patch(source._id, { queueState, publicationAuthorized });
          }
          await projectCreativeTransition(ctx, null, { ...source, queueState, publicationAuthorized });
          break;
        }
        case "commerce-sites": {
          const orders = await ctx.db.query("orders").withIndex("by_site", (q: any) => q.eq("siteId", source._id)).take(251);
          if (orders.length > 250) throw new Error(`site ${source._id} exceeds the authoritative Shopify snapshot cap; reconcile source coverage first`);
          const current = source.shopifyEconomicsSyncStatus === "current" && !!source.shopifyEconomicsSyncAttemptId;
          const eligible = current ? orders.filter((order: any) => order.shopifyEconomicsSnapshotAttemptId === source.shopifyEconomicsSyncAttemptId) : [];
          await replaceSiteCommerceProjection(ctx, source, eligible);
          break;
        }
      }
    }
    await ctx.db.patch(state._id, {
      cursor: page.isDone ? undefined : page.continueCursor,
      completed: page.isDone,
      phase: page.isDone ? "verifying" : "backfilling",
      processed: state.processed + page.page.length,
      updatedAt: Date.now(),
    });
    return { continueCursor: page.isDone ? null : page.continueCursor, isDone: page.isDone, processed: state.processed + page.page.length, reused: false };
  },
});

function sameNumbers(expected: Record<string, number>, actual: any): boolean {
  return Object.entries(expected).every(([key, value]) => actual?.[key] === value);
}

async function expectedSite(ctx: any, site: Doc<"sites">) {
  const [products, actions, posts, creatives, orders] = await Promise.all([
    ctx.db.query("products").withIndex("by_site", (q: any) => q.eq("siteId", site._id)).take(VERIFY_SOURCE_CAP + 1),
    ctx.db.query("actions").withIndex("by_site_status", (q: any) => q.eq("siteId", site._id)).take(VERIFY_SOURCE_CAP + 1),
    ctx.db.query("posts").withIndex("by_site_status", (q: any) => q.eq("siteId", site._id)).take(VERIFY_SOURCE_CAP + 1),
    ctx.db.query("creatives").withIndex("by_site_status", (q: any) => q.eq("siteId", site._id)).take(VERIFY_SOURCE_CAP + 1),
    ctx.db.query("orders").withIndex("by_site", (q: any) => q.eq("siteId", site._id)).take(251),
  ]);
  if ([products, actions, posts, creatives].some((rows) => rows.length > VERIFY_SOURCE_CAP) || orders.length > 250) {
    throw new Error(`site ${site._id} exceeds a bounded verification page; use entity-page repair before activation`);
  }
  const currentOrders = shopifyEconomicsReadiness(site) === "current" && site.shopifyEconomicsSyncAttemptId
    ? orders.filter((order: any) => order.shopifyEconomicsSnapshotAttemptId === site.shopifyEconomicsSyncAttemptId && eligibleUsdOrder(order, site.storeCurrency)) : [];
  const counts = {
    productCount: products.length,
    activeProductCount: products.filter((row: any) => row.status === "active").length,
    pendingActionCount: actions.filter((row: any) => row.status === "pending_approval").length,
    postCount: posts.length,
    publishedPostCount: posts.filter((row: any) => row.status === "published").length,
    reviewCreativeCount: creatives.filter((row: any) => row.status === "review").length,
    openOrderCount: currentOrders.filter((row: any) => row.fulfillmentStatus === "received").length,
    orderCount: currentOrders.length,
    revenueUsd: currentOrders.reduce((sum: number, row: any) => sum + row.currentTotal, 0),
  };
  return { counts, products, actions, posts, creatives, currentOrders };
}

async function expectedDaily(ctx: any, posts: any[], orders: any[]) {
  const result = new Map<string, any>();
  const day = (key: string) => {
    const value = result.get(key) ?? { publishedPosts: 0, observedPosts: 0, views: 0, engagement: 0, orders: 0, revenueUsd: 0, purchases: 0, platforms: emptyPlatforms(), bestPost: undefined };
    result.set(key, value);
    return value;
  };
  for (const post of posts) {
    if (post.status !== "published") continue;
    if ((post.publishedAt ?? post._creationTime) < Date.now() - DASHBOARD_MAX_DAYS * 24 * 60 * 60 * 1000) continue;
    const value = day(dashboardDay(post.publishedAt ?? post._creationTime));
    value.publishedPosts++;
    if (providerObservedPost(post)) {
      value.observedPosts++; value.views += post.views ?? 0; value.engagement += post.engagement ?? 0;
      value.platforms[post.platform].posts++; value.platforms[post.platform].views += post.views ?? 0; value.platforms[post.platform].engagement += post.engagement ?? 0;
      if (!value.bestPost || (post.views ?? 0) > value.bestPost.views
        || ((post.views ?? 0) === value.bestPost.views && String(post._id) < String(value.bestPost.postId))) {
        const creative = await ctx.db.get(post.creativeId);
        value.bestPost = { postId: post._id, creativeId: post.creativeId, platform: post.platform, views: post.views ?? 0, engagement: post.engagement ?? 0, publishedAt: post.publishedAt, r2Key: creative?.r2Key || undefined };
      }
    }
  }
  for (const order of orders) {
    const value = day(dashboardDay(order.createdAt));
    value.orders++; value.purchases++; value.revenueUsd += order.currentTotal;
  }
  return result;
}

function servedDaily(row: any) {
  return {
    publishedPosts: row?.publishedPosts ?? 0, observedPosts: row?.observedPosts ?? 0,
    views: row?.views ?? 0, engagement: row?.engagement ?? 0,
    orders: row?.orders ?? 0, revenueUsd: row?.revenueUsd ?? 0, purchases: row?.purchases ?? 0,
    platforms: row?.platforms ?? emptyPlatforms(), bestPost: row?.bestPost,
  };
}

function hasServedDailyFacts(row: any) {
  return row.publishedPosts || row.observedPosts || row.views || row.engagement
    || row.orders || row.revenueUsd || row.purchases || row.bestPost
    || Object.values(row.platforms ?? {}).some((bucket: any) => bucket.posts || bucket.views || bucket.engagement);
}

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
    .filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])]));
  return value;
}
function samePayload(a: unknown, b: unknown) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }

function expectedTopProducts(products: any[], site: Doc<"sites">) {
  return products.map((product) => ({
    productId: product._id, title: product.title, siteName: site.name, views: 0,
    marginPct: product.contributionMarginPct, priceUsd: product.priceUsd, trend: [], status: product.status,
  })).sort((a, b) => b.views - a.views || (b.marginPct ?? -Infinity) - (a.marginPct ?? -Infinity)
    || String(a.productId).localeCompare(String(b.productId))).slice(0, 25);
}

function metadataMatches(site: Doc<"sites">, actual: any) {
  return Object.entries(siteFields(site)).every(([key, value]) => actual?.[key] === value);
}

async function expectedPortfolioDay(ctx: any, mode: "live" | "sample", day: string) {
  const rows = await ctx.db.query("dashboardDailyRollups").withIndex("by_mode_day", (q: any) => q.eq("dataMode", mode).eq("day", day)).take(501);
  if (rows.length > 500) throw new Error(`portfolio ${mode} exceeds bounded site verification`);
  const value: any = { orders: 0, revenueUsd: 0, purchases: 0, publishedPosts: 0, observedPosts: 0, views: 0, engagement: 0, platforms: emptyPlatforms(), bestPost: undefined };
  for (const row of rows) {
    const site = await ctx.db.get(row.siteId);
    if (!site || dataModeOf(site) !== mode) value.__invalidProjection = true;
    for (const key of ["orders", "revenueUsd", "purchases", "publishedPosts", "observedPosts", "views", "engagement"]) value[key] += row[key];
    for (const platform of Object.keys(value.platforms)) for (const key of ["posts", "views", "engagement"]) value.platforms[platform][key] += row.platforms[platform][key];
    if (row.bestPost && (!value.bestPost || row.bestPost.views > value.bestPost.views
      || (row.bestPost.views === value.bestPost.views && String(row.bestPost.postId) < String(value.bestPost.postId)))) {
      if (site) value.bestPost = { ...row.bestPost, siteId: row.siteId, siteName: site.name };
    }
  }
  return value;
}

export const verifyPage = mutation({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    for (const name of ENTITIES) {
      const state = await migrationRow(ctx, name);
      if (!state?.completed) throw new Error(`dashboard-v1 ${name} backfill is incomplete`);
    }
    const state = await migrationRow(ctx, "verification");
    if (!state) throw new Error("dashboard-v1 migration has not been started");
    if (state.completed) return { continueCursor: null, isDone: true, driftCount: state.driftCount, driftSites: state.driftSites ?? [], driftDays: state.driftDays ?? [], reused: true };
    if ((paginationOpts.cursor ?? null) !== (state.cursor ?? null)) throw new Error("dashboard-v1 verification cursor is stale");
    const stage = state.verificationStage ?? "sites";
    let drift = 0;
    const driftSites = [...(state.driftSites ?? [])];
    const driftDays = [...(state.driftDays ?? [])];

    if (stage === "sites") {
      const page = await ctx.db.query("sites").paginate({ cursor: state.cursor ?? null, numItems: Math.min(paginationOpts.numItems, 5) });
      for (const site of page.page) {
        const expected = await expectedSite(ctx, site);
        const actual = await ctx.db.query("dashboardSiteSummaries").withIndex("by_site", (q) => q.eq("siteId", site._id)).unique();
        const daily = await ctx.db.query("dashboardDailyRollups").withIndex("by_site_day", (q) => q.eq("siteId", site._id)).take(DASHBOARD_MAX_DAYS + 1);
        const dailyExpected = await expectedDaily(ctx, expected.posts, expected.currentOrders);
        const dailyMatches = daily.length <= DASHBOARD_MAX_DAYS
          && dailyExpected.size === daily.filter(hasServedDailyFacts).length
          && [...dailyExpected].every(([day, facts]) => samePayload(facts, servedDaily(daily.find((row) => row.day === day))));
        const topMatches = samePayload(expectedTopProducts(expected.products, site), actual?.topProducts ?? []);
        let queuesMatch = true;
        for (const creative of expected.creatives as any[]) {
          const dispatch = creative.status === "approved"
            ? await ctx.db.query("distributionDispatches").withIndex("by_creative", (q) => q.eq("creativeId", creative._id)).first() : null;
          const authorized = !!dispatch;
          const queue = creative.status === "review" ? "review" : creative.status === "approved" && !authorized ? "publication_authorization" : "none";
          if (creative.dashboardDataMode !== dataModeOf(site) || creative.queueState !== queue || creative.publicationAuthorized !== authorized) queuesMatch = false;
        }
        const receiptCount = await ctx.db.query("dashboardProjectionReceipts").withIndex("by_site_entity", (q) => q.eq("siteId", site._id)).take(VERIFY_SOURCE_CAP * 4 + 1);
        const expectedReceiptKeys = new Set([
          ...expected.products.map((row: any) => `product:${row._id}`), ...expected.actions.map((row: any) => `action:${row._id}`),
          ...expected.posts.map((row: any) => `post:${row._id}`), ...expected.creatives.map((row: any) => `creative:${row._id}`),
        ]);
        const receiptsMatch = receiptCount.length === expectedReceiptKeys.size
          && receiptCount.every((row) => expectedReceiptKeys.has(`${row.entity}:${row.sourceId}`));
        let portfolioDaysPresent = true;
        for (const day of dailyExpected.keys()) {
          if (!await ctx.db.query("dashboardPortfolioDailyRollups").withIndex("by_mode_day", (q) => q.eq("dataMode", dataModeOf(site)).eq("day", day)).unique()) {
            portfolioDaysPresent = false;
            if (!driftDays.includes(`${dataModeOf(site)}:${day}`) && driftDays.length < 100) driftDays.push(`${dataModeOf(site)}:${day}`);
          }
        }
        if (!actual || !sameNumbers(expected.counts, actual) || !metadataMatches(site, actual)
          || !topMatches || !dailyMatches || !queuesMatch || !receiptsMatch || !portfolioDaysPresent) {
          drift++;
          if (!driftSites.includes(site._id) && driftSites.length < 100) driftSites.push(site._id);
        }
      }
      const driftCount = state.driftCount + drift;
      const nextCursor = page.isDone ? "__portfolio_days__" : page.continueCursor;
      await ctx.db.patch(state._id, {
        cursor: nextCursor, verificationStage: page.isDone ? "portfolio-days" : "sites",
        driftCount, driftSites, driftDays, processed: state.processed + page.page.length, updatedAt: Date.now(),
      });
      return { continueCursor: nextCursor, isDone: false, driftCount, driftSites, driftDays, reused: false };
    }

    const cursor = state.cursor === "__portfolio_days__" ? null : state.cursor ?? null;
    const page = await ctx.db.query("dashboardPortfolioDailyRollups").paginate({ cursor, numItems: Math.min(paginationOpts.numItems, 5) });
    for (const row of page.page) {
      const expected = await expectedPortfolioDay(ctx, row.dataMode, row.day);
      if (!samePayload(expected, servedDaily(row))) {
        drift++;
        const key = `${row.dataMode}:${row.day}`;
        if (!driftDays.includes(key) && driftDays.length < 100) driftDays.push(key);
      }
    }
    if (page.isDone) {
      const sourceSites = await ctx.db.query("sites").take(501);
      if (sourceSites.length > 500) throw new Error("site source exceeds bounded portfolio verification");
      for (const mode of ["live", "sample"] as const) {
        const rows = await ctx.db.query("dashboardSiteSummaries").withIndex("by_mode_site", (q) => q.eq("dataMode", mode)).take(501);
        if (rows.length > 500) throw new Error(`portfolio ${mode} exceeds bounded site verification`);
        const actual = await ctx.db.query("dashboardPortfolioSummaries").withIndex("by_mode", (q) => q.eq("dataMode", mode)).unique();
        const top = rows.flatMap((row) => row.topProducts).sort((a, b) => b.views - a.views || (b.marginPct ?? -Infinity) - (a.marginPct ?? -Infinity) || String(a.productId).localeCompare(String(b.productId))).slice(0, 25);
        const currentCount = rows.filter((row) => shopifyEconomicsReadiness(row as any) === "current").length;
        const expected = {
          siteCount: rows.length, pendingActionCount: rows.reduce((s, r) => s + r.pendingActionCount, 0),
          productCount: rows.reduce((s, r) => s + r.productCount, 0), activeProductCount: rows.reduce((s, r) => s + r.activeProductCount, 0),
          reviewCreativeCount: rows.reduce((s, r) => s + r.reviewCreativeCount, 0), openOrderCount: rows.reduce((s, r) => s + r.openOrderCount, 0),
          orderCount: rows.reduce((s, r) => s + r.orderCount, 0), revenueUsd: rows.reduce((s, r) => s + r.revenueUsd, 0),
          commerceVerified: rows.length > 0 && currentCount === rows.length,
        };
        if (rows.length !== sourceSites.filter((site) => dataModeOf(site) === mode).length) drift++;
        if (!(rows.length === 0 && !actual)
          && (!actual || !sameNumbers(expected as any, actual) || actual.commerceVerified !== expected.commerceVerified || !samePayload(actual.topProducts, top))) drift++;
      }
    }
    const driftCount = state.driftCount + drift;
    await ctx.db.patch(state._id, {
      cursor: page.isDone ? undefined : page.continueCursor, completed: page.isDone,
      verified: page.isDone && driftCount === 0, driftCount, driftSites, driftDays,
      processed: state.processed + page.page.length, updatedAt: Date.now(),
    });
    return { continueCursor: page.isDone ? null : page.continueCursor, isDone: page.isDone, driftCount, driftSites, driftDays, reused: false };
  },
});

export const beginVerification = mutation({
  args: {},
  handler: async (ctx) => {
    const state = await migrationRow(ctx, "verification");
    const readSwitch = await migrationRow(ctx, "read-switch");
    if (!state || !readSwitch) throw new Error("dashboard-v1 migration has not been started");
    const reset = { cursor: undefined, completed: false, verified: false, driftCount: 0, processed: 0, driftSites: [], driftDays: [], verificationStage: "sites" as const, phase: "verifying" as const, updatedAt: Date.now() };
    await ctx.db.patch(state._id, reset);
    await ctx.db.patch(readSwitch._id, { phase: "verifying", completed: false, verified: false, updatedAt: Date.now() });
    return { phase: "verifying" as const };
  },
});

export const repairSite = mutation({
  args: { siteId: v.id("sites") },
  handler: async (ctx, { siteId }) => {
    const site = await ctx.db.get(siteId);
    if (!site) throw new Error("site not found");
    const expected = await expectedSite(ctx, site);
    const summary = await ensureSiteSummary(ctx, site);
    await resetSiteProjectionReceipts(ctx, siteId);
    const existingDaily = await ctx.db.query("dashboardDailyRollups").withIndex("by_site_day", (q) => q.eq("siteId", siteId)).take(DASHBOARD_MAX_DAYS + 1);
    if (existingDaily.length > DASHBOARD_MAX_DAYS) throw new Error(`site ${siteId} exceeds rolling daily repair bound`);
    for (const row of existingDaily) await ctx.db.delete(row._id);
    for (const row of existingDaily) await refreshPortfolioDay(ctx, dataModeOf(site), row.day);
    await ctx.db.patch(summary._id, {
      ...siteFields(site), productCount: 0, activeProductCount: 0, pendingActionCount: 0,
      postCount: 0, publishedPostCount: 0, reviewCreativeCount: 0,
      openOrderCount: 0, orderCount: 0, revenueUsd: 0, topProducts: [], updatedAt: Date.now(),
    });
    for (const product of expected.products) await projectProductTransition(ctx, null, product);
    for (const action of expected.actions) await projectActionTransition(ctx, null, action);
    for (const creative0 of expected.creatives) {
      const dispatch = creative0.status === "approved"
        ? await ctx.db.query("distributionDispatches").withIndex("by_creative", (q) => q.eq("creativeId", creative0._id)).first() : null;
      const publicationAuthorized = !!dispatch;
      const queueState = creative0.status === "review" ? "review"
        : creative0.status === "approved" && !publicationAuthorized ? "publication_authorization" : "none";
      await ctx.db.patch(creative0._id, { publicationAuthorized, queueState });
      await projectCreativeTransition(ctx, null, (await ctx.db.get(creative0._id as any))! as any);
    }
    for (const post of expected.posts) await projectPostTransition(ctx, null, post);
    await replaceSiteCommerceProjection(ctx, site, expected.currentOrders);
    await refreshPortfolioSummary(ctx, site.sample === true ? "sample" : "live");
    const verification = await migrationRow(ctx, "verification");
    if (verification) await ctx.db.patch(verification._id, {
      cursor: undefined, completed: false, verified: false, driftCount: 0, processed: 0,
      driftSites: [], driftDays: [], verificationStage: "sites", phase: "verifying", updatedAt: Date.now(),
    });
    return { repaired: true as const, expected: expected.counts };
  },
});

export const activateReadSwitch = mutation({
  args: {},
  handler: async (ctx) => {
    for (const name of ENTITIES) {
      const state = await migrationRow(ctx, name);
      if (!state?.completed) throw new Error(`dashboard-v1 ${name} backfill is incomplete`);
    }
    const verification = await migrationRow(ctx, "verification");
    if (!verification?.completed || !verification.verified || verification.driftCount !== 0) {
      throw new Error("dashboard-v1 bounded verification has not completed without drift");
    }
    const state = await migrationRow(ctx, "read-switch");
    if (!state) throw new Error("dashboard-v1 migration has not been started");
    await ctx.db.patch(state._id, { phase: "ready", completed: true, verified: true, driftCount: 0, updatedAt: Date.now() });
    return { phase: "ready" as const, activatedAt: Date.now() };
  },
});

export const heartbeat = mutation({
  args: { component: v.literal("brain"), checkpoint: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity?.subject !== "dropship-ai:service") throw new Error("UNAUTHENTICATED: heartbeat requires the service runtime");
    await recordControlPlaneHeartbeat(ctx, args);
    return { recordedAt: Date.now() };
  },
});
