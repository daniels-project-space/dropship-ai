import assert from "node:assert/strict";
import fs from "node:fs/promises";
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
  "../convex/shopifyEconomics.ts": () => import("../convex/shopifyEconomics.ts"),
  "../convex/shopifyEconomicsExpiry.ts": () => import("../convex/shopifyEconomicsExpiry.ts"),
  "../convex/audit.ts": () => import("../convex/audit.ts"),
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
};
const { api } = apiModule;
const schema = schemaModule.default ?? schemaModule;
const service = (t) => t.withIdentity({ subject: "dropship-ai:service" });

async function runBackfill(t, entity, firstCursor = null) {
  let cursor = firstCursor;
  for (;;) {
    const result = await service(t).mutation(api.dashboardMigration.backfillPage, {
      entity, paginationOpts: { cursor, numItems: 25 },
    });
    if (result.isDone) return result;
    cursor = result.continueCursor;
  }
}

async function runVerification(t) {
  let cursor = null;
  for (;;) {
    const result = await service(t).mutation(api.dashboardMigration.verifyPage, {
      paginationOpts: { cursor, numItems: 5 },
    });
    if (result.isDone) return result;
    cursor = result.continueCursor;
  }
}

test("200-site backfill is resumable, replay-safe, drift-repairable, and feeds bounded portfolio/site snapshots", async () => {
  const t = convexTest({ schema, modules });
  const now = Date.now();
  const siteIds = await t.run(async (ctx) => {
    const ids = [];
    for (let index = 0; index < 200; index++) {
      const siteId = await ctx.db.insert("sites", {
        name: `Fixture ${String(index).padStart(3, "0")}`, niche: "projection fixture", status: "active",
        minKitPriceUsd: 40, minBlendedMarginPct: 70, distributionMode: "semi_manual", createdAt: now + index,
      });
      ids.push(siteId);
      await ctx.db.insert("products", {
        siteId, title: `Product ${index}`, cjFromUsWarehouse: false, cogsUsd: 0, shippingUsd: 0,
        priceUsd: 49, contributionMarginPct: 72, status: index % 2 ? "draft" : "active", createdAt: now + index,
      });
      await ctx.db.insert("actions", {
        siteId, type: "fixture", params: {}, riskTier: "human_gated", status: "pending_approval",
        rationale: "deterministic projection fixture", proposedAt: now + index,
      });
      const creativeId = await ctx.db.insert("creatives", {
        siteId, kind: "product_demo", r2Key: `creatives/fixture-${index}.mp4`, aiGenerated: true,
        aiLabelRequired: true, labelBurned: true, status: "review", revision: 1, createdAt: now + index,
      });
      await ctx.db.insert("posts", {
        siteId, creativeId, platform: index % 2 ? "instagram" : "tiktok", status: "published",
        publishedAt: now, externalPostId: `provider-${index}`, views: index === 0 ? 12_000 : 100,
        engagement: index === 0 ? 600 : 5, metricsProvider: "ayrshare", metricsObservedAt: now, sample: false,
      });
    }
    return ids;
  });

  await service(t).mutation(api.dashboardMigration.start, {});
  const first = await service(t).mutation(api.dashboardMigration.backfillPage, {
    entity: "sites", paginationOpts: { cursor: null, numItems: 25 },
  });
  await assert.rejects(
    () => service(t).mutation(api.dashboardMigration.backfillPage, { entity: "sites", paginationOpts: { cursor: null, numItems: 25 } }),
    /cursor is stale/,
  );
  await runBackfill(t, "sites", first.continueCursor);
  for (const entity of ["products", "actions", "posts", "creatives", "commerce-sites"]) await runBackfill(t, entity);
  const verified = await runVerification(t);
  assert.equal(verified.driftCount, 0);
  await service(t).mutation(api.dashboardMigration.activateReadSwitch, {});

  const shell = await service(t).query(api.dashboard.shellSnapshot, {});
  assert.equal(shell.projectionState, "ready");
  assert.equal(shell.brands.length, 200);
  assert.equal(shell.totalPendingActions, 200);
  assert.equal(shell.contentFit.passed, true);
  assert.equal(shell.contentFit.bestVideo.views, 12_000);
  assert.equal(shell.controlPlane.state, "unknown", "missing heartbeat is never green");

  const portfolio = await service(t).query(api.dashboard.commandCenterSnapshot, { scope: "all", days: 30, platform: "all" });
  assert.equal(portfolio.projectionState, "ready");
  assert.equal(portfolio.views.total, 31_900);
  assert.equal(portfolio.pendingTotal, 200);
  assert.equal(portfolio.coverage.conversion, "unavailable");
  assert.match(portfolio.funnel.conversionAvailability.reason, /not synthesized/);
  const selected = await service(t).query(api.dashboard.commandCenterSnapshot, { scope: siteIds[0], days: 30, platform: "all" });
  assert.equal(selected.views.total, 12_000);

  const firstSummary = await t.run((ctx) => ctx.db.query("dashboardSiteSummaries").withIndex("by_site", (q) => q.eq("siteId", siteIds[0])).unique());
  await t.run((ctx) => ctx.db.patch(firstSummary._id, { pendingActionCount: 999 }));
  await service(t).mutation(api.dashboardMigration.beginVerification, {});
  const drift = await service(t).mutation(api.dashboardMigration.verifyPage, { paginationOpts: { cursor: null, numItems: 5 } });
  assert.ok(drift.driftCount > 0);
  await assert.rejects(() => service(t).mutation(api.dashboardMigration.activateReadSwitch, {}), /verification/);
  await service(t).mutation(api.dashboardMigration.repairSite, { siteId: siteIds[0] });
  assert.equal((await runVerification(t)).driftCount, 0);
  await service(t).mutation(api.dashboardMigration.activateReadSwitch, {});
  assert.equal((await service(t).query(api.dashboard.shellSnapshot, {})).totalPendingActions, 200);
});

test("supported mutations maintain compact counts, content deltas, review state, and exact publication authorization", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await service(t).mutation(api.sites.create, {
    name: "Transactional", niche: "fixture", minKitPriceUsd: 40, minBlendedMarginPct: 70, distributionMode: "semi_manual", status: "active",
  });
  const productId = await service(t).mutation(api.products.upsert, {
    siteId, title: "Compact product", cogsUsd: 1, shippingUsd: 1, priceUsd: 40, cjFromUsWarehouse: false,
  });
  const proposed = await service(t).mutation(api.actions.propose, {
    siteId, type: "fixture", params: {}, riskTier: "human_gated", rationale: "fixture",
  });
  let summary = await t.run((ctx) => ctx.db.query("dashboardSiteSummaries").withIndex("by_site", (q) => q.eq("siteId", siteId)).unique());
  assert.deepEqual({ products: summary.productCount, pending: summary.pendingActionCount }, { products: 1, pending: 1 });
  await service(t).mutation(api.actions.approve, { actionId: proposed.actionId });

  const requested = await service(t).mutation(api.creatives.requestGen, {
    siteId, productId, kind: "product_demo", aiGenerated: true, r2Key: "creatives/transactional.mp4", labelBurned: true, status: "review",
  });
  summary = await t.run((ctx) => ctx.db.query("dashboardSiteSummaries").withIndex("by_site", (q) => q.eq("siteId", siteId)).unique());
  assert.deepEqual({ pending: summary.pendingActionCount, review: summary.reviewCreativeCount }, { pending: 0, review: 1 });
  const approved = await service(t).mutation(api.creatives.approve, { creativeId: requested.creativeId });
  const authorization = await service(t).mutation(api.creatives.authorizePublication, {
    creativeId: requested.creativeId, expectedRevision: approved.revision, caption: "Exact caption",
    destinations: [{ platform: "tiktok", targetAccount: "fixture-account" }],
  });
  const post = await service(t).mutation(api.posts.schedule, {
    siteId, creativeId: requested.creativeId, platform: "tiktok", targetAccount: "fixture-account",
    caption: "Exact caption", dispatchKey: authorization.dispatchKey,
  });
  await service(t).mutation(api.posts.markPublished, { postId: post.postId, externalPostId: "provider-post" });
  await service(t).mutation(api.posts.recordEngagement, { postId: post.postId, views: 15_000, engagement: 700, observedAt: Date.now(), provider: "ayrshare" });
  summary = await t.run((ctx) => ctx.db.query("dashboardSiteSummaries").withIndex("by_site", (q) => q.eq("siteId", siteId)).unique());
  assert.deepEqual({ review: summary.reviewCreativeCount, posts: summary.postCount, published: summary.publishedPostCount }, { review: 0, posts: 1, published: 1 });
  const creative = await t.run((ctx) => ctx.db.get(requested.creativeId));
  assert.deepEqual({ authorized: creative.publicationAuthorized, queue: creative.queueState }, { authorized: true, queue: "none" });
  const daily = await t.run((ctx) => ctx.db.query("dashboardDailyRollups").withIndex("by_site_day", (q) => q.eq("siteId", siteId)).unique());
  assert.deepEqual({ views: daily.views, engagement: daily.engagement, observed: daily.observedPosts }, { views: 15_000, engagement: 700, observed: 1 });
});

test("Shopify snapshot projection replaces bounded daily economics across cancellation, test, and credit transitions", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await service(t).mutation(api.sites.create, {
    name: "Commerce", niche: "fixture", minKitPriceUsd: 40, minBlendedMarginPct: 70, distributionMode: "semi_manual", status: "active",
  });
  await t.run((ctx) => ctx.db.patch(siteId, { shopifyDomain: "commerce.myshopify.com", storeCurrency: "USD", shopifyAccessVerifiedAt: Date.now() }));
  const createdAt = Date.now() - 60_000;
  const order = (suffix, overrides = {}) => ({
    shopifyOrderId: `gid://shopify/Order/${suffix}`, currencyCode: "USD", currentTotal: 50,
    financialStatus: "PAID", test: false, cancelled: false, creditAdjustmentState: "none",
    fulfillmentStatus: "received", createdAt, ...overrides,
  });
  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "projection-1", sinceDays: 60 });
  await service(t).mutation(api.sites.commitEconomicsSnapshot, {
    siteId, attemptId: "projection-1", products: [],
    orders: [order("paid"), order("test", { test: true }), order("cancelled", { cancelled: true }), order("credited", { creditAdjustmentState: "full" })],
  });
  let summary = await t.run((ctx) => ctx.db.query("dashboardSiteSummaries").withIndex("by_site", (q) => q.eq("siteId", siteId)).unique());
  assert.deepEqual({ orders: summary.orderCount, revenue: summary.revenueUsd, open: summary.openOrderCount }, { orders: 1, revenue: 50, open: 1 });

  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "projection-2", sinceDays: 60 });
  await service(t).mutation(api.sites.commitEconomicsSnapshot, {
    siteId, attemptId: "projection-2", products: [],
    orders: [order("paid", { cancelled: true }), order("test", { test: true }), order("cancelled", { cancelled: true }), order("credited", { creditAdjustmentState: "full" })],
  });
  summary = await t.run((ctx) => ctx.db.query("dashboardSiteSummaries").withIndex("by_site", (q) => q.eq("siteId", siteId)).unique());
  assert.deepEqual({ orders: summary.orderCount, revenue: summary.revenueUsd, open: summary.openOrderCount }, { orders: 0, revenue: 0, open: 0 });
  const daily = await t.run((ctx) => ctx.db.query("dashboardDailyRollups").withIndex("by_site_day", (q) => q.eq("siteId", siteId)).unique());
  assert.deepEqual({ orders: daily.orders, revenue: daily.revenueUsd, purchases: daily.purchases }, { orders: 0, revenue: 0, purchases: 0 });
});

test("source contracts forbid ready-path history/N+1 loops and CJ cold load uses one service-vault query", async () => {
  const dashboard = await fs.readFile(new URL("../convex/dashboard.ts", import.meta.url), "utf8");
  const readyCommand = dashboard.slice(dashboard.indexOf("if (ready) {", dashboard.indexOf("export const commandCenterSnapshot")), dashboard.indexOf("} else {", dashboard.indexOf("export const commandCenterSnapshot")));
  assert.match(readyCommand, /dashboardDailyRollups|dashboardPortfolioDailyRollups/);
  assert.doesNotMatch(readyCommand, /query\("(?:posts|orders|products|conversionMetrics)"\)/);

  const creatives = await fs.readFile(new URL("../convex/creatives.ts", import.meta.url), "utf8");
  const readyReview = creatives.slice(creatives.indexOf("const cap = Math.min", creatives.indexOf("export const listForReview")), creatives.indexOf("export const listForPublicationAuthorization"));
  assert.match(readyReview, /by_queue_created_at/);
  assert.doesNotMatch(readyReview, /distributionDispatches/);
  const siteList = creatives.slice(creatives.indexOf("export const listByStatus"), creatives.indexOf("export const listForReview"));
  assert.match(siteList, /publicationAuthorized: row\.publicationAuthorized === true/);

  const cj = await fs.readFile(new URL("../src/lib/cj.ts", import.meta.url), "utf8");
  const bundle = cj.slice(cj.indexOf("async function readTokenBundle"), cj.indexOf("let tokenCoordinator"));
  assert.equal((bundle.match(/getService\("cj"\)/g) ?? []).length, 1);
  assert.doesNotMatch(bundle, /getKey\(/);
  const commandUi = await fs.readFile(new URL("../app/components/CommandCenter.tsx", import.meta.url), "utf8");
  assert.equal((commandUi.match(/useQuery\(/g) ?? []).length, 2, "snapshot plus separately paged recent audit only");
  const shellUi = await fs.readFile(new URL("../app/components/shell/AppShell.tsx", import.meta.url), "utf8");
  assert.equal((shellUi.match(/useQuery\(/g) ?? []).length, 1);
});
