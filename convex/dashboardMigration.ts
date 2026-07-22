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
} from "./dashboardProjections";
import { eligibleUsdOrder } from "../src/lib/shopifyOrder";

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
          const queueState = source.status === "review" ? "review"
            : source.status === "approved" && source.publicationAuthorized !== true ? "publication_authorization" : "none";
          const publicationAuthorized = source.publicationAuthorized === true;
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
  const currentOrders = site.shopifyEconomicsSyncStatus === "current" && site.shopifyEconomicsSyncAttemptId
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
  return { counts, posts, currentOrders };
}

function expectedDaily(posts: any[], orders: any[]) {
  const result = new Map<string, { publishedPosts: number; observedPosts: number; views: number; engagement: number; orders: number; revenueUsd: number; purchases: number }>();
  const day = (key: string) => {
    const value = result.get(key) ?? { publishedPosts: 0, observedPosts: 0, views: 0, engagement: 0, orders: 0, revenueUsd: 0, purchases: 0 };
    result.set(key, value);
    return value;
  };
  for (const post of posts) {
    if (post.status !== "published") continue;
    if ((post.publishedAt ?? post._creationTime) < Date.now() - DASHBOARD_MAX_DAYS * 24 * 60 * 60 * 1000) continue;
    const value = day(dashboardDay(post.publishedAt ?? post._creationTime));
    value.publishedPosts++;
    if (providerObservedPost(post)) { value.observedPosts++; value.views += post.views ?? 0; value.engagement += post.engagement ?? 0; }
  }
  for (const order of orders) {
    const value = day(dashboardDay(order.createdAt));
    value.orders++; value.purchases++; value.revenueUsd += order.currentTotal;
  }
  return result;
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
    if (state.completed) return { continueCursor: null, isDone: true, driftCount: state.driftCount, reused: true };
    if ((paginationOpts.cursor ?? null) !== (state.cursor ?? null)) throw new Error("dashboard-v1 verification cursor is stale");
    const page = await ctx.db.query("sites").paginate({ cursor: state.cursor ?? null, numItems: Math.min(paginationOpts.numItems, 5) });
    let drift = 0;
    for (const site of page.page) {
      const expected = await expectedSite(ctx, site);
      const actual = await ctx.db.query("dashboardSiteSummaries").withIndex("by_site", (q) => q.eq("siteId", site._id)).unique();
      const daily = await ctx.db.query("dashboardDailyRollups").withIndex("by_site_day", (q) => q.eq("siteId", site._id)).take(DASHBOARD_MAX_DAYS + 1);
      const dailyExpected = expectedDaily(expected.posts, expected.currentOrders);
      const dailyMatches = dailyExpected.size === daily.filter((row) => row.publishedPosts || row.orders || row.views || row.engagement).length
        && [...dailyExpected].every(([day, facts]) => sameNumbers(facts, daily.find((row) => row.day === day)));
      if (!actual || !sameNumbers(expected.counts, actual) || !dailyMatches) drift++;
    }
    const driftCount = state.driftCount + drift;
    await ctx.db.patch(state._id, {
      cursor: page.isDone ? undefined : page.continueCursor,
      completed: page.isDone, verified: page.isDone && driftCount === 0,
      phase: "verifying", driftCount, processed: state.processed + page.page.length, updatedAt: Date.now(),
    });
    return { continueCursor: page.isDone ? null : page.continueCursor, isDone: page.isDone, driftCount, reused: false };
  },
});

export const beginVerification = mutation({
  args: {},
  handler: async (ctx) => {
    const state = await migrationRow(ctx, "verification");
    const readSwitch = await migrationRow(ctx, "read-switch");
    if (!state || !readSwitch) throw new Error("dashboard-v1 migration has not been started");
    const reset = { cursor: undefined, completed: false, verified: false, driftCount: 0, processed: 0, phase: "verifying" as const, updatedAt: Date.now() };
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
    const products = await ctx.db.query("products").withIndex("by_site", (q) => q.eq("siteId", siteId)).take(VERIFY_SOURCE_CAP);
    const topProducts = products.map((product) => ({
      productId: product._id, title: product.title, siteName: site.name, views: 0,
      marginPct: product.contributionMarginPct, priceUsd: product.priceUsd, trend: [], status: product.status,
    })).sort((a, b) => (b.marginPct ?? -Infinity) - (a.marginPct ?? -Infinity)).slice(0, 25);
    const existingDaily = await ctx.db.query("dashboardDailyRollups").withIndex("by_site_day", (q) => q.eq("siteId", siteId)).take(DASHBOARD_MAX_DAYS + 1);
    for (const row of existingDaily) await ctx.db.delete(row._id);
    for (const row of existingDaily) await refreshPortfolioDay(ctx, dataModeOf(site), row.day);
    for (const post of expected.posts) await projectPostTransition(ctx, null, post);
    await replaceSiteCommerceProjection(ctx, site, expected.currentOrders);
    await ctx.db.patch(summary._id, { ...expected.counts, topProducts, updatedAt: Date.now() });
    await refreshPortfolioSummary(ctx, site.sample === true ? "sample" : "live");
    const verification = await migrationRow(ctx, "verification");
    if (verification) await ctx.db.patch(verification._id, {
      cursor: undefined, completed: false, verified: false, driftCount: 0, processed: 0, phase: "verifying", updatedAt: Date.now(),
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
