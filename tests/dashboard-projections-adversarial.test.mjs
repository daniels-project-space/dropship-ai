import assert from "node:assert/strict";
import test from "node:test";
import "./helpers/unref-long-convex-timers.mjs";
import { convexTest } from "convex-test";
import schemaModule from "../convex/schema.ts";
import apiModule from "../convex/_generated/api.js";

const modules = {
  "../convex/dashboardMigration.ts": () => import("../convex/dashboardMigration.ts"),
  "../convex/dashboard.ts": () => import("../convex/dashboard.ts"),
  "../convex/sites.ts": () => import("../convex/sites.ts"),
  "../convex/products.ts": () => import("../convex/products.ts"),
  "../convex/actions.ts": () => import("../convex/actions.ts"),
  "../convex/creatives.ts": () => import("../convex/creatives.ts"),
  "../convex/posts.ts": () => import("../convex/posts.ts"),
  "../convex/admin.ts": () => import("../convex/admin.ts"),
  "../convex/audit.ts": () => import("../convex/audit.ts"),
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
};
const { api } = apiModule;
const schema = schemaModule.default ?? schemaModule;
const service = (t) => t.withIdentity({ subject: "dropship-ai:service" });

async function backfill(t, entity) {
  let cursor = null;
  for (;;) {
    const result = await service(t).mutation(api.dashboardMigration.backfillPage, { entity, paginationOpts: { cursor, numItems: 25 } });
    if (result.isDone) return result;
    cursor = result.continueCursor;
  }
}

async function summary(t, siteId) {
  return t.run((ctx) => ctx.db.query("dashboardSiteSummaries").withIndex("by_site", (q) => q.eq("siteId", siteId)).unique());
}

test("live writers and backfill share exactly-once receipts across insert, pre-page update, replay, delete, and restart", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await service(t).mutation(api.sites.create, {
    name: "Receipt fence", niche: "fixture", minKitPriceUsd: 40, minBlendedMarginPct: 70,
    distributionMode: "semi_manual", status: "active",
  });
  await service(t).mutation(api.dashboardMigration.start, {});
  await backfill(t, "sites");
  const first = await service(t).mutation(api.products.upsert, {
    siteId, title: "Live insert", cogsUsd: 1, shippingUsd: 1, priceUsd: 50,
    contributionMarginPct: 80, cjFromUsWarehouse: false,
  });
  const legacy = await t.run((ctx) => ctx.db.insert("products", {
    siteId, title: "Legacy update", cjFromUsWarehouse: false, cogsUsd: 2, shippingUsd: 2,
    priceUsd: 40, contributionMarginPct: 65, status: "draft", createdAt: Date.now(),
  }));
  await service(t).mutation(api.products.setStatus, { productId: legacy, status: "archived" });
  assert.equal((await summary(t, siteId)).productCount, 2, "pre-page update applies the complete current row once");
  await backfill(t, "products");
  assert.equal((await summary(t, siteId)).productCount, 2, "backfill does not reapply live receipts");
  const restart = await service(t).mutation(api.dashboardMigration.backfillPage, { entity: "products", paginationOpts: { cursor: null, numItems: 25 } });
  assert.equal(restart.reused, true);
  await service(t).mutation(api.admin.deleteProduct, { productId: first });
  assert.equal((await summary(t, siteId)).productCount, 1);
  assert.equal((await service(t).mutation(api.admin.deleteProduct, { productId: first })).deleted, false);
  assert.equal((await summary(t, siteId)).productCount, 1, "delete replay is harmless");
});

test("beginning a replacement snapshot immediately withholds site/day and portfolio commerce", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await service(t).mutation(api.sites.create, {
    name: "Commerce fence", niche: "fixture", minKitPriceUsd: 40, minBlendedMarginPct: 70,
    distributionMode: "semi_manual", status: "active",
  });
  await t.run((ctx) => ctx.db.patch(siteId, { shopifyDomain: "fence.myshopify.com", storeCurrency: "USD", shopifyAccessVerifiedAt: Date.now() }));
  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "current-1", sinceDays: 60 });
  await service(t).mutation(api.sites.commitEconomicsSnapshot, {
    siteId, attemptId: "current-1", products: [], orders: [{
      shopifyOrderId: "gid://shopify/Order/1", currencyCode: "USD", currentTotal: 50,
      financialStatus: "PAID", test: false, cancelled: false, creditAdjustmentState: "none",
      fulfillmentStatus: "received", createdAt: Date.now() - 1_000,
    }],
  });
  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "replacement-2", sinceDays: 60 });
  const site = await summary(t, siteId);
  const day = await t.run((ctx) => ctx.db.query("dashboardDailyRollups").withIndex("by_site_day", (q) => q.eq("siteId", siteId)).unique());
  const portfolio = await t.run((ctx) => ctx.db.query("dashboardPortfolioSummaries").withIndex("by_mode", (q) => q.eq("dataMode", "live")).unique());
  const portfolioDay = await t.run((ctx) => ctx.db.query("dashboardPortfolioDailyRollups").withIndex("by_mode_day", (q) => q.eq("dataMode", "live").eq("day", day.day)).unique());
  assert.deepEqual([site.orderCount, site.revenueUsd, site.openOrderCount], [0, 0, 0]);
  assert.deepEqual([day.orders, day.revenueUsd, day.purchases], [0, 0, 0]);
  assert.deepEqual([portfolio.orderCount, portfolio.revenueUsd, portfolio.openOrderCount], [0, 0, 0]);
  assert.deepEqual([portfolioDay.orders, portfolioDay.revenueUsd, portfolioDay.purchases], [0, 0, 0]);
});

test("downward provider correction promotes the authoritative observed daily and portfolio winner", async () => {
  const t = convexTest({ schema, modules });
  const now = Date.now();
  const { siteId, high, low } = await t.run(async (ctx) => {
    const siteId = await ctx.db.insert("sites", { name: "Extrema", niche: "fixture", status: "active", minKitPriceUsd: 40, minBlendedMarginPct: 70, distributionMode: "semi_manual", createdAt: now });
    const creativeId = await ctx.db.insert("creatives", { siteId, kind: "product_demo", r2Key: "winner.mp4", aiGenerated: true, aiLabelRequired: true, labelBurned: true, status: "approved", createdAt: now });
    const make = (externalPostId, views) => ctx.db.insert("posts", { siteId, creativeId, platform: "tiktok", status: "published", publishedAt: now, externalPostId, views, engagement: 1, metricsProvider: "ayrshare", metricsObservedAt: now });
    return { siteId, high: await make("high", 200), low: await make("low", 100) };
  });
  await service(t).mutation(api.dashboardMigration.start, {});
  await backfill(t, "sites"); await backfill(t, "posts");
  await service(t).mutation(api.posts.recordEngagement, { postId: high, views: 50, engagement: 1, observedAt: now + 1, provider: "ayrshare" });
  const daily = await t.run((ctx) => ctx.db.query("dashboardDailyRollups").withIndex("by_site_day", (q) => q.eq("siteId", siteId)).unique());
  const portfolio = await t.run((ctx) => ctx.db.query("dashboardPortfolioDailyRollups").withIndex("by_mode_day", (q) => q.eq("dataMode", "live").eq("day", daily.day)).unique());
  assert.equal(daily.bestPost.postId, low);
  assert.equal(daily.bestPost.views, 100);
  assert.equal(portfolio.bestPost.postId, low);
});

test("verification detects served compact top-product drift and blocks activation", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await service(t).mutation(api.sites.create, { name: "Verify payload", niche: "fixture", minKitPriceUsd: 40, minBlendedMarginPct: 70, distributionMode: "semi_manual", status: "active" });
  await service(t).mutation(api.products.upsert, { siteId, title: "Winner", cogsUsd: 1, shippingUsd: 1, priceUsd: 50, contributionMarginPct: 80, cjFromUsWarehouse: false });
  await service(t).mutation(api.dashboardMigration.start, {});
  for (const entity of ["sites", "products", "actions", "posts", "creatives", "commerce-sites"]) await backfill(t, entity);
  const row = await summary(t, siteId);
  await t.run((ctx) => ctx.db.patch(row._id, { topProducts: [] }));
  await service(t).mutation(api.dashboardMigration.beginVerification, {});
  const result = await service(t).mutation(api.dashboardMigration.verifyPage, { paginationOpts: { cursor: null, numItems: 5 } });
  assert.equal(result.driftCount, 1);
  assert.deepEqual(result.driftSites, [siteId]);
  await assert.rejects(() => service(t).mutation(api.dashboardMigration.activateReadSwitch, {}), /verification/);
});

test("deleting a retained winner promotes product 26 from authoritative source truth", async () => {
  const t = convexTest({ schema, modules });
  const now = Date.now();
  const { siteId, winner, promoted } = await t.run(async (ctx) => {
    const siteId = await ctx.db.insert("sites", { name: "Live", niche: "fixture", status: "active", minKitPriceUsd: 40, minBlendedMarginPct: 70, distributionMode: "semi_manual", createdAt: now });
    const products = [];
    for (let index = 0; index < 26; index++) products.push(await ctx.db.insert("products", { siteId, title: `P${index}`, cjFromUsWarehouse: false, cogsUsd: 1, shippingUsd: 1, priceUsd: 50, contributionMarginPct: 100 - index, status: "draft", createdAt: now + index }));
    return { siteId, winner: products[0], promoted: products[25] };
  });
  await service(t).mutation(api.dashboardMigration.start, {});
  await backfill(t, "sites"); await backfill(t, "products");
  await service(t).mutation(api.admin.deleteProduct, { productId: winner });
  const row = await summary(t, siteId);
  assert.equal(row.productCount, 25);
  assert.ok(row.topProducts.some((product) => product.productId === promoted));
});

test("201 newer sample rows cannot starve either live human queue", async () => {
  const t = convexTest({ schema, modules });
  const now = Date.now();
  const { liveReview, liveAuthorization } = await t.run(async (ctx) => {
    const siteId = await ctx.db.insert("sites", { name: "Live", niche: "fixture", status: "active", minKitPriceUsd: 40, minBlendedMarginPct: 70, distributionMode: "semi_manual", createdAt: now });
    const liveReview = await ctx.db.insert("creatives", { siteId, kind: "product_demo", r2Key: "live-review.mp4", aiGenerated: true, aiLabelRequired: true, labelBurned: true, status: "review", publicationAuthorized: false, queueState: "review", dashboardDataMode: "live", createdAt: now - 10_000 });
    const liveAuthorization = await ctx.db.insert("creatives", { siteId, kind: "product_demo", r2Key: "live-auth.mp4", aiGenerated: true, aiLabelRequired: true, labelBurned: true, status: "approved", publicationAuthorized: false, queueState: "publication_authorization", dashboardDataMode: "live", createdAt: now - 10_000 });
    for (let index = 0; index < 201; index++) {
      const sampleId = await ctx.db.insert("sites", { name: `Sample ${index}`, niche: "fixture", status: "active", minKitPriceUsd: 40, minBlendedMarginPct: 70, distributionMode: "semi_manual", createdAt: now + index, sample: true });
      for (const [status, queueState] of [["review", "review"], ["approved", "publication_authorization"]]) await ctx.db.insert("creatives", { siteId: sampleId, kind: "product_demo", r2Key: `sample-${index}-${status}.mp4`, aiGenerated: true, aiLabelRequired: true, labelBurned: true, status, publicationAuthorized: false, queueState, dashboardDataMode: "sample", createdAt: now + index });
    }
    await ctx.db.insert("dashboardProjectionMigrations", { name: "dashboard-v1", entity: "read-switch", phase: "ready", completed: true, verified: true, driftCount: 0, processed: 0, updatedAt: now });
    return { liveReview, liveAuthorization };
  });
  const reviews = await service(t).query(api.creatives.listForReview, { limit: 100 });
  const authorizations = await service(t).query(api.creatives.listForPublicationAuthorization, { limit: 100 });
  assert.deepEqual(reviews.map((row) => row._id), [liveReview]);
  assert.deepEqual(authorizations.map((row) => row._id), [liveAuthorization]);
});
