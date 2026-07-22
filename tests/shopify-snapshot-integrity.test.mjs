import assert from "node:assert/strict";
import test, { mock } from "node:test";
import "./helpers/unref-long-convex-timers.mjs";
import { convexTest } from "convex-test";
import schemaModule from "../convex/schema.ts";
import apiModule from "../convex/_generated/api.js";
import {
  shopifyEconomicsReadiness,
  SHOPIFY_ECONOMICS_SNAPSHOT_PROTOCOL_VERSION,
  SHOPIFY_ECONOMICS_SYNC_MAX_AGE_MS,
} from "../src/lib/shopifySyncState.ts";
import { shopifyEconomicsStatusReadiness } from "../app/api/status/route.ts";

const modules = {
  "../convex/sites.ts": () => import("../convex/sites.ts"),
  "../convex/audit.ts": () => import("../convex/audit.ts"),
  "../convex/dashboard.ts": () => import("../convex/dashboard.ts"),
  "../convex/webhooks.ts": () => import("../convex/webhooks.ts"),
  "../convex/orders.ts": () => import("../convex/orders.ts"),
  "../convex/products.ts": () => import("../convex/products.ts"),
  "../convex/shopifyEconomics.ts": () => import("../convex/shopifyEconomics.ts"),
  "../convex/shopifyEconomicsExpiry.ts": () => import("../convex/shopifyEconomicsExpiry.ts"),
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
};
const { api, internal } = apiModule;
const schema = schemaModule.default ?? schemaModule;
const service = (t) => t.withIdentity({ subject: "dropship-ai:service" });

async function connectedSite(t, name = "Snapshot") {
  const siteId = await t.run((ctx) => ctx.db.insert("sites", {
    name, niche: "test", status: "provisioning", minKitPriceUsd: 40,
    minBlendedMarginPct: 70, distributionMode: "semi_manual", createdAt: Date.now(),
  }));
  await service(t).mutation(api.sites.connectStore, {
    siteId, shopifyDomain: `${name.toLowerCase().replaceAll(" ", "-")}.myshopify.com`, storeCurrency: "USD",
  });
  return siteId;
}

const product = (id = "1") => ({
  shopifyProductId: `gid://shopify/Product/${id}`, title: `Product ${id}`,
  priceUsd: 49, status: "ACTIVE",
});
const snapshotProduct = (id = "1") => ({ ...product(id), status: "active" });
const snapshotOrder = (id = "1", patch = {}) => ({
  shopifyOrderId: `gid://shopify/Order/${id}`, currencyCode: "USD", currentTotal: 42,
  financialStatus: "PAID", test: false, cancelled: false, creditAdjustmentState: "none",
  fulfillmentStatus: "received", createdAt: Date.now(), ...patch,
});

test("atomic snapshot success derives zero-inclusive counts from its own writes", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await connectedSite(t, "Atomic Counts");
  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "atomic-counts", sinceDays: 60 });
  const result = await service(t).mutation(api.sites.commitEconomicsSnapshot, {
    siteId, attemptId: "atomic-counts", products: [snapshotProduct()], orders: [snapshotOrder()],
  });
  assert.deepEqual({ status: result.status, productCount: result.productCount, orderCount: result.orderCount },
    { status: "current", productCount: 1, orderCount: 1 });
  const [site, products, orders] = await t.run(async (ctx) => [
    await ctx.db.get(siteId),
    await ctx.db.query("products").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect(),
    await ctx.db.query("orders").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect(),
  ]);
  assert.equal(site.shopifyEconomicsSyncProductCount, products.length);
  assert.equal(site.shopifyEconomicsSyncOrderCount, orders.length);
  assert.equal(site.shopifyEconomicsSnapshotProtocolVersion, SHOPIFY_ECONOMICS_SNAPSHOT_PROTOCOL_VERSION);
  assert.equal(site.shopifyEconomicsSyncOrderCutoffAt, site.shopifyEconomicsSyncAttemptedAt - 60 * 24 * 60 * 60 * 1000);
  assert.equal(site.shopifyEconomicsSyncSucceededAt, result.finishedAt);
  assert.equal(site.shopifyEconomicsSyncExpiresAt, result.finishedAt + SHOPIFY_ECONOMICS_SYNC_MAX_AGE_MS);
  assert.equal(site.shopifyEconomicsSyncExpiredAt, undefined);
  assert.equal(site.shopifyEconomicsSyncExpiredAttemptId, undefined);
  assert.equal(products[0].shopifyEconomicsSnapshotAttemptId, "atomic-counts");
  assert.equal(orders[0].shopifyEconomicsSnapshotAttemptId, "atomic-counts");
  assert.equal(shopifyEconomicsReadiness(site), "current");
  const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].name, "shopifyEconomicsExpiry:expireEconomicsSnapshot");
  assert.equal(scheduled[0].scheduledTime, site.shopifyEconomicsSyncExpiresAt);
  assert.deepEqual(scheduled[0].args, [{
    siteId,
    attemptId: "atomic-counts",
    protocolVersion: SHOPIFY_ECONOMICS_SNAPSHOT_PROTOCOL_VERSION,
    succeededAt: site.shopifyEconomicsSyncSucceededAt,
    expiresAt: site.shopifyEconomicsSyncExpiresAt,
  }]);
  await assert.rejects(
    () => service(t).mutation(api.sites.commitEconomicsSnapshot, {
      siteId, attemptId: "atomic-counts", products: [], orders: [], productCount: 999,
    }),
    /Unexpected field/,
  );
});

test("legacy current rows without atomic generation proof are incomplete and never verified zero commerce", async () => {
  const t = convexTest({ schema, modules });
  const now = Date.now();
  const siteId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("sites", {
      name: "Legacy Current", niche: "test", status: "active", storeCurrency: "USD",
      minKitPriceUsd: 40, minBlendedMarginPct: 70, distributionMode: "semi_manual",
      createdAt: now, shopifyDomain: "legacy-current.myshopify.com", shopifyAccessVerifiedAt: now,
      shopifyEconomicsSyncStatus: "current", shopifyEconomicsSyncAttemptId: "legacy-current",
      shopifyEconomicsSyncSucceededAt: now, shopifyEconomicsSyncSinceDays: 60,
      shopifyEconomicsSyncProductCount: 0, shopifyEconomicsSyncOrderCount: 1,
    });
    await ctx.db.insert("orders", {
      siteId: id, shopifyOrderId: "gid://shopify/Order/legacy-current", fulfillmentStatus: "received",
      currencyCode: "USD", currentTotal: 99, financialStatus: "PAID", test: false,
      cancelled: false, creditAdjustmentState: "none", createdAt: now,
      shopifyEconomicsSnapshotAttemptId: "former-separate-writer",
    });
    return id;
  });

  const site = await t.run((ctx) => ctx.db.get(siteId));
  const [portfolio, timeseries, funnel, brand, summary] = await Promise.all([
    service(t).query(api.dashboard.portfolio, {}),
    service(t).query(api.dashboard.timeseries, { scope: siteId, metric: "revenue", days: 30 }),
    service(t).query(api.dashboard.funnel, { scope: siteId, days: 30 }),
    service(t).query(api.dashboard.brandDetail, { siteId }),
    service(t).query(api.dashboard.siteSummary, { siteId }),
  ]);
  assert.equal(shopifyEconomicsReadiness(site), "incomplete");
  assert.equal(shopifyEconomicsStatusReadiness(site), "incomplete");
  assert.equal(portfolio.sites[0].shopifyEconomicsSyncState, "incomplete");
  assert.equal(portfolio.sites[0].ordersAwaitingFulfillment, 0);
  assert.deepEqual({ verified: timeseries.commerceVerified, total: timeseries.total }, { verified: false, total: 0 });
  assert.equal(funnel.commerceVerified, false);
  assert.equal(brand.economicsReadiness, "incomplete");
  assert.deepEqual({ orderCount: brand.orderCount, revenueUsd: brand.revenueUsd }, { orderCount: 0, revenueUsd: 0 });
  assert.equal(summary.economicsReadiness, "incomplete");
});

test("durable expiry alone invalidates every reactive commerce surface after a stopped sync", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await connectedSite(t, "Stopped Sync");
  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "stopped-sync", sinceDays: 60 });
  await service(t).mutation(api.sites.commitEconomicsSnapshot, {
    siteId, attemptId: "stopped-sync", products: [snapshotProduct("expiry")],
    orders: [snapshotOrder("expiry")],
  });
  const [beforeSite, beforeProduct, beforeOrder, scheduled] = await t.run(async (ctx) => [
    await ctx.db.get(siteId),
    await ctx.db.query("products").withIndex("by_site", (q) => q.eq("siteId", siteId)).first(),
    await ctx.db.query("orders").withIndex("by_site", (q) => q.eq("siteId", siteId)).first(),
    await ctx.db.system.query("_scheduled_functions").collect(),
  ]);
  assert.equal(shopifyEconomicsReadiness(beforeSite), "current");
  assert.equal(scheduled.length, 1);

  mock.method(Date, "now", () => beforeSite.shopifyEconomicsSyncExpiresAt);
  try {
    const transition = await t.mutation(
      internal.shopifyEconomicsExpiry.expireEconomicsSnapshot,
      scheduled[0].args[0],
    );
    assert.deepEqual(transition, { expired: true, reason: "expired" });
  } finally {
    mock.restoreAll();
  }

  const [afterSite, afterProduct, afterOrder, portfolio, timeseries, funnel, brand, summary, expiryAudits] = await Promise.all([
    t.run((ctx) => ctx.db.get(siteId)),
    t.run((ctx) => ctx.db.get(beforeProduct._id)),
    t.run((ctx) => ctx.db.get(beforeOrder._id)),
    service(t).query(api.dashboard.portfolio, {}),
    service(t).query(api.dashboard.timeseries, { scope: siteId, metric: "revenue", days: 30 }),
    service(t).query(api.dashboard.funnel, { scope: siteId, days: 30 }),
    service(t).query(api.dashboard.brandDetail, { siteId }),
    service(t).query(api.dashboard.siteSummary, { siteId }),
    t.run((ctx) => ctx.db.query("auditLog").withIndex("by_site_at", (q) => q.eq("siteId", siteId)).collect()),
  ]);
  assert.equal(afterSite.shopifyEconomicsSyncStatus, "current");
  assert.equal(afterSite.shopifyEconomicsSyncExpiredAt, beforeSite.shopifyEconomicsSyncExpiresAt);
  assert.equal(afterSite.shopifyEconomicsSyncExpiredAttemptId, "stopped-sync");
  assert.equal(shopifyEconomicsReadiness(afterSite), "stale");
  assert.equal(shopifyEconomicsStatusReadiness(afterSite), "stale");
  assert.equal(portfolio.sites[0].shopifyEconomicsSyncState, "stale");
  assert.equal(portfolio.sites[0].ordersAwaitingFulfillment, 0);
  assert.deepEqual({ verified: timeseries.commerceVerified, total: timeseries.total }, { verified: false, total: 0 });
  assert.equal(funnel.commerceVerified, false);
  assert.equal(brand.economicsReadiness, "stale");
  assert.deepEqual({ orderCount: brand.orderCount, revenueUsd: brand.revenueUsd }, { orderCount: 0, revenueUsd: 0 });
  assert.equal(summary.economicsReadiness, "stale");
  assert.deepEqual(afterProduct, beforeProduct);
  assert.deepEqual(afterOrder, beforeOrder);
  assert.equal(expiryAudits.filter((row) => row.event === "shopify_economics_sync_expired").length, 1);
});

test("old and repeated expiry transitions cannot demote a newer generation", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await connectedSite(t, "Expiry Fence");
  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "expiry-old", sinceDays: 60 });
  await service(t).mutation(api.sites.commitEconomicsSnapshot, { siteId, attemptId: "expiry-old", products: [], orders: [] });
  const oldScheduled = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()))[0];
  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "expiry-new", sinceDays: 60 });
  await service(t).mutation(api.sites.commitEconomicsSnapshot, { siteId, attemptId: "expiry-new", products: [], orders: [] });
  const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  const newScheduled = scheduled.find((row) => row.args[0].attemptId === "expiry-new");
  assert.equal(scheduled.length, 2);

  mock.method(Date, "now", () => Math.max(oldScheduled.args[0].expiresAt, newScheduled.args[0].expiresAt));
  try {
    assert.deepEqual(
      await t.mutation(internal.shopifyEconomicsExpiry.expireEconomicsSnapshot, oldScheduled.args[0]),
      { expired: false, reason: "superseded" },
    );
    const stillNew = await t.run((ctx) => ctx.db.get(siteId));
    assert.equal(stillNew.shopifyEconomicsSyncAttemptId, "expiry-new");
    assert.equal(shopifyEconomicsReadiness(stillNew), "current");
    assert.deepEqual(
      await t.mutation(internal.shopifyEconomicsExpiry.expireEconomicsSnapshot, newScheduled.args[0]),
      { expired: true, reason: "expired" },
    );
    assert.deepEqual(
      await t.mutation(internal.shopifyEconomicsExpiry.expireEconomicsSnapshot, newScheduled.args[0]),
      { expired: false, reason: "already_expired" },
    );
  } finally {
    mock.restoreAll();
  }
  const [site, audit] = await t.run(async (ctx) => [
    await ctx.db.get(siteId),
    await ctx.db.query("auditLog").withIndex("by_site_at", (q) => q.eq("siteId", siteId)).collect(),
  ]);
  assert.equal(shopifyEconomicsReadiness(site), "stale");
  assert.equal(audit.filter((row) => row.event === "shopify_economics_sync_expired").length, 1);
});

test("expiry leaves observation-invalidated, pending, failed, and incomplete attempts unchanged", async () => {
  for (const state of ["observation", "pending", "failed", "incomplete"]) {
    const t = convexTest({ schema, modules });
    const siteId = await connectedSite(t, `Expiry ${state}`);
    await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: `${state}-old`, sinceDays: 60 });
    await service(t).mutation(api.sites.commitEconomicsSnapshot, { siteId, attemptId: `${state}-old`, products: [], orders: [] });
    const scheduled = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()))[0];
    if (state === "observation") {
      await service(t).mutation(api.webhooks.recordShopifyOrder, {
        siteId, deliveryId: "expiry-observation", topic: "orders/create", payloadHash: "expiry-observation-hash",
        ...snapshotOrder("expiry-observation"),
      });
    } else {
      await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: `${state}-new`, sinceDays: 60 });
      if (state === "failed" || state === "incomplete") {
        await service(t).mutation(api.sites.markEconomicsSyncNotCurrent, {
          siteId, attemptId: `${state}-new`, status: state,
        });
      }
    }
    const before = await t.run((ctx) => ctx.db.get(siteId));
    mock.method(Date, "now", () => scheduled.args[0].expiresAt);
    try {
      await t.mutation(internal.shopifyEconomicsExpiry.expireEconomicsSnapshot, scheduled.args[0]);
    } finally {
      mock.restoreAll();
    }
    const after = await t.run((ctx) => ctx.db.get(siteId));
    assert.deepEqual(after, before);
    assert.equal(after.shopifyEconomicsSyncExpiredAt, undefined);
    assert.equal(after.shopifyEconomicsSyncStatus, state === "observation" ? "incomplete" : state);
  }
});

test("one-day diagnostics and superseded attempts cannot write or finish a snapshot", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await connectedSite(t, "Fenced");
  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "diagnostic", sinceDays: 1 });
  const diagnostic = await service(t).mutation(api.sites.commitEconomicsSnapshot, {
    siteId, attemptId: "diagnostic", products: [snapshotProduct("diagnostic")], orders: [],
  });
  assert.equal(diagnostic.status, "incomplete");
  assert.equal((await t.run((ctx) => ctx.db.query("products").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect())).length, 0);
  assert.equal(shopifyEconomicsReadiness(await t.run((ctx) => ctx.db.get(siteId))), "incomplete");

  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "older", sinceDays: 60 });
  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "newer", sinceDays: 60 });
  await assert.rejects(() => service(t).mutation(api.sites.commitEconomicsSnapshot, {
    siteId, attemptId: "older", products: [snapshotProduct("stale")], orders: [],
  }), /superseded/);
  const ignored = await service(t).mutation(api.sites.markEconomicsSyncNotCurrent, {
    siteId, attemptId: "older", status: "failed",
  });
  assert.equal(ignored.ignored, true);
  const stored = await t.run((ctx) => ctx.db.get(siteId));
  assert.equal(stored.shopifyEconomicsSyncAttemptId, "newer");
  assert.equal(stored.shopifyEconomicsSyncStatus, "pending");
  assert.equal((await t.run((ctx) => ctx.db.query("products").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect())).length, 0);
});

test("an incomplete attempt writes no mirror rows and leaves the older complete dataset intact", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await connectedSite(t, "Truncation");
  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "complete-old", sinceDays: 60 });
  await service(t).mutation(api.sites.commitEconomicsSnapshot, {
    siteId, attemptId: "complete-old", products: [snapshotProduct("old")], orders: [snapshotOrder("old")],
  });
  const before = await t.run(async (ctx) => ({
    products: await ctx.db.query("products").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect(),
    orders: await ctx.db.query("orders").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect(),
  }));
  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "truncated-new", sinceDays: 60 });
  await service(t).mutation(api.sites.markEconomicsSyncNotCurrent, {
    siteId, attemptId: "truncated-new", status: "incomplete", reason: "product_truncation",
  });
  const after = await t.run(async (ctx) => ({
    site: await ctx.db.get(siteId),
    products: await ctx.db.query("products").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect(),
    orders: await ctx.db.query("orders").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect(),
  }));
  assert.deepEqual(after.products, before.products);
  assert.deepEqual(after.orders, before.orders);
  assert.equal(shopifyEconomicsReadiness(after.site), "incomplete");
});

test("a later complete zero snapshot archives missing provider products and excludes stale revenue without erasing lineage", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await connectedSite(t, "Zero Reconcile");
  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "nonzero", sinceDays: 60 });
  await service(t).mutation(api.sites.commitEconomicsSnapshot, {
    siteId, attemptId: "nonzero", products: [snapshotProduct("gone")],
    orders: [snapshotOrder("gone", { fulfillmentStatus: "shipped" })],
  });
  const [providerProduct, providerOrder] = await t.run(async (ctx) => [
    await ctx.db.query("products").withIndex("by_site", (q) => q.eq("siteId", siteId)).filter((q) => q.neq(q.field("shopifyProductId"), undefined)).first(),
    await ctx.db.query("orders").withIndex("by_site", (q) => q.eq("siteId", siteId)).first(),
  ]);
  await t.run(async (ctx) => {
    await ctx.db.patch(providerProduct._id, { cjProductId: "cj-kept", cjVariantId: "cj-variant-kept" });
    await ctx.db.patch(providerOrder._id, { cjOrderId: "cj-order-kept", trackingNumber: "tracking-kept" });
    await ctx.db.insert("products", {
      siteId, title: "Local lineage", cjProductId: "cj-local", cjFromUsWarehouse: true,
      cogsUsd: 1, shippingUsd: 1, priceUsd: 10, status: "active", createdAt: 1,
    });
  });
  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "zero", sinceDays: 60 });
  const zero = await service(t).mutation(api.sites.commitEconomicsSnapshot, { siteId, attemptId: "zero", products: [], orders: [] });
  const [storedSite, storedProviderProduct, storedProviderOrder, localProduct] = await t.run(async (ctx) => [
    await ctx.db.get(siteId), await ctx.db.get(providerProduct._id), await ctx.db.get(providerOrder._id),
    await ctx.db.query("products").withIndex("by_site", (q) => q.eq("siteId", siteId)).filter((q) => q.eq(q.field("cjProductId"), "cj-local")).first(),
  ]);
  assert.deepEqual({ productCount: zero.productCount, orderCount: zero.orderCount }, { productCount: 0, orderCount: 0 });
  assert.equal(storedProviderProduct.status, "archived");
  assert.equal(storedProviderProduct.cjProductId, "cj-kept");
  assert.equal(storedProviderProduct.shopifyEconomicsSnapshotAttemptId, undefined);
  assert.equal(storedProviderOrder.cjOrderId, "cj-order-kept");
  assert.equal(storedProviderOrder.trackingNumber, "tracking-kept");
  assert.equal(storedProviderOrder.shopifyEconomicsSnapshotAttemptId, undefined);
  assert.equal(localProduct.status, "active");
  assert.equal(shopifyEconomicsReadiness(storedSite), "current");
  const revenue = await service(t).query(api.dashboard.timeseries, { scope: siteId, metric: "revenue", days: 30 });
  assert.equal(revenue.commerceVerified, true);
  assert.equal(revenue.total, 0);
});

test("commit first then provider observation preserves the fact and demotes the generation", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await connectedSite(t, "Commit First");
  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "commit-first", sinceDays: 60 });
  const committed = await service(t).mutation(api.sites.commitEconomicsSnapshot, {
    siteId, attemptId: "commit-first", products: [], orders: [],
  });
  assert.equal(committed.status, "current");
  await service(t).mutation(api.webhooks.recordShopifyOrder, {
    siteId, deliveryId: "commit-first-delivery", topic: "orders/create", payloadHash: "commit-first-hash",
    ...snapshotOrder("after-commit", { currentTotal: 91 }),
  });
  const [site, order] = await t.run(async (ctx) => [
    await ctx.db.get(siteId),
    await ctx.db.query("orders").withIndex("by_site", (q) => q.eq("siteId", siteId)).first(),
  ]);
  assert.equal(site.shopifyEconomicsSyncStatus, "incomplete");
  assert.equal(site.shopifyEconomicsSyncAttemptId, "commit-first");
  assert.equal(order.currentTotal, 91);
  assert.equal(order.shopifyEconomicsSnapshotAttemptId, undefined);
});

test("orders.record, approved draft completion, and duplicate webhook use the same pending fence", async () => {
  const t = convexTest({ schema, modules });
  const orderSite = await connectedSite(t, "Orders Record");
  await service(t).mutation(api.sites.beginEconomicsSync, { siteId: orderSite, attemptId: "orders-record", sinceDays: 60 });
  await service(t).mutation(api.orders.record, {
    siteId: orderSite, shopifyOrderId: "gid://shopify/Order/recorded", currencyCode: "USD",
    currentTotal: 63, financialStatus: "PAID", test: false, cancelled: false,
    creditAdjustmentState: "none", fulfillmentStatus: "received",
  });
  const orderCommit = await service(t).mutation(api.sites.commitEconomicsSnapshot, {
    siteId: orderSite, attemptId: "orders-record", products: [], orders: [],
  });
  assert.equal(orderCommit.status, "incomplete");
  assert.equal((await t.run((ctx) => ctx.db.get(orderSite))).shopifyEconomicsSyncAttemptId, "orders-record");

  const draftSite = await connectedSite(t, "Draft Completion");
  const readAt = Date.now();
  const { productId, actionId } = await t.run(async (ctx) => {
    const evidenceId = await ctx.db.insert("cjEvidence", {
      siteId: draftSite, cjProductId: "cj-product", cjVariantId: "cj-variant", title: "Draft",
      cogsUsd: 5, shippingUsd: 5, inventoryQty: 10, fromUsWarehouse: true,
      fromCountryCode: "US", inventoryVerified: true, sourceUrl: "https://example.test/source",
      mediaUrl: "https://example.test/image.jpg", traceId: "evidence-trace", readAt,
    });
    const productId = await ctx.db.insert("products", {
      siteId: draftSite, title: "Draft", cjProductId: "cj-product", cjVariantId: "cj-variant",
      cjEvidenceId: evidenceId, cjFromUsWarehouse: true, cogsUsd: 5, shippingUsd: 5,
      landedCostUsd: 10, priceUsd: 50, contributionMarginPct: 80, sourceVerifiedAt: readAt,
      status: "draft", shopifyDraftImportStatus: "creating", shopifyDraftImportTraceId: "draft-trace",
      createdAt: readAt,
    });
    const actionId = await ctx.db.insert("actions", {
      siteId: draftSite, type: "import_sourced_product", riskTier: "human_gated", status: "approved",
      params: { productId, evidenceId, cjProductId: "cj-product", cjVariantId: "cj-variant", priceUsd: 50, cogsUsd: 5, shippingUsd: 5, landedCostUsd: 10, contributionMarginPct: 80, evidenceReadAt: readAt },
      rationale: "fixture approval", proposedAt: readAt, resolvedAt: readAt,
    });
    await ctx.db.insert("traces", {
      traceId: "draft-trace", siteId: draftSite, operation: "shopify.product.create_draft",
      target: `shopify:draft:${productId}`, idempotencyKey: `shopify:draft:${productId}`,
      status: "started", detail: { productId, actionId, evidenceId, published: false }, startedAt: readAt,
    });
    return { productId, actionId };
  });
  await service(t).mutation(api.sites.beginEconomicsSync, { siteId: draftSite, attemptId: "draft-completion", sinceDays: 60 });
  await service(t).mutation(api.products.completeApprovedShopifyDraftImport, {
    siteId: draftSite, productId, actionId, traceId: "draft-trace",
    shopifyProductId: "gid://shopify/Product/imported", shopifyVariantId: "gid://shopify/ProductVariant/imported",
  });
  const draftCommit = await service(t).mutation(api.sites.commitEconomicsSnapshot, {
    siteId: draftSite, attemptId: "draft-completion", products: [], orders: [],
  });
  const [draftState, imported] = await t.run(async (ctx) => [await ctx.db.get(draftSite), await ctx.db.get(productId)]);
  assert.equal(draftCommit.status, "incomplete");
  assert.equal(draftState.shopifyEconomicsSyncAttemptId, "draft-completion");
  assert.equal(imported.shopifyDraftImportStatus, "created");
  assert.equal(imported.shopifyEconomicsSnapshotAttemptId, undefined);

  const duplicateSite = await connectedSite(t, "Duplicate Webhook");
  const delivery = {
    siteId: duplicateSite, deliveryId: "same-delivery", topic: "orders/create", payloadHash: "same-hash",
    ...snapshotOrder("same-delivery"),
  };
  await service(t).mutation(api.webhooks.recordShopifyOrder, delivery);
  await service(t).mutation(api.sites.beginEconomicsSync, { siteId: duplicateSite, attemptId: "duplicate-pending", sinceDays: 60 });
  const duplicate = await service(t).mutation(api.webhooks.recordShopifyOrder, delivery);
  const duplicateState = await t.run((ctx) => ctx.db.get(duplicateSite));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicateState.shopifyEconomicsSyncStatus, "pending");
  assert.equal(duplicateState.shopifyEconomicsSyncAttemptId, "duplicate-pending");
});

test("the reducer reads only provider catalogue rows and the indexed durable order window", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await connectedSite(t, "Bounded History");
  const { orderCutoffAt } = await service(t).mutation(api.sites.beginEconomicsSync, {
    siteId, attemptId: "bounded-history", sinceDays: 60,
  });
  const seeded = await t.run(async (ctx) => {
    const localProducts = [];
    const oldOrders = [];
    for (let index = 0; index < 350; index++) {
      localProducts.push(await ctx.db.insert("products", {
        siteId, title: `Local ${index}`, cjFromUsWarehouse: true, cogsUsd: 1, shippingUsd: 1,
        priceUsd: 10, status: "active", createdAt: index,
      }));
      oldOrders.push(await ctx.db.insert("orders", {
        siteId, shopifyOrderId: `gid://shopify/Order/historical-${index}`,
        cjOrderId: `cj-historical-${index}`, fulfillmentStatus: "delivered",
        trackingNumber: `tracking-${index}`, createdAt: orderCutoffAt - index - 1,
      }));
    }
    const windowOrder = await ctx.db.insert("orders", {
      siteId, shopifyOrderId: "gid://shopify/Order/window", cjOrderId: "cj-window",
      fulfillmentStatus: "shipped", trackingNumber: "tracking-window", createdAt: orderCutoffAt + 1,
      shopifyEconomicsSnapshotAttemptId: "older-generation",
    });
    return { localProducts, oldOrders, windowOrder };
  });
  const result = await service(t).mutation(api.sites.commitEconomicsSnapshot, {
    siteId, attemptId: "bounded-history", products: [], orders: [],
  });
  assert.equal(result.status, "current");
  const [oldFirst, oldLast, localFirst, windowOrder] = await t.run(async (ctx) => [
    await ctx.db.get(seeded.oldOrders[0]), await ctx.db.get(seeded.oldOrders.at(-1)),
    await ctx.db.get(seeded.localProducts[0]), await ctx.db.get(seeded.windowOrder),
  ]);
  for (const old of [oldFirst, oldLast]) {
    assert.equal(old.fulfillmentStatus, "delivered");
    assert.match(old.cjOrderId, /^cj-historical-/);
    assert.match(old.trackingNumber, /^tracking-/);
    assert.equal(old.shopifyEconomicsExcludedAt, undefined);
  }
  assert.equal(localFirst.status, "active");
  assert.equal(windowOrder.cjOrderId, "cj-window");
  assert.equal(windowOrder.fulfillmentStatus, "shipped");
  assert.equal(windowOrder.shopifyEconomicsSnapshotAttemptId, undefined);
  assert.equal(typeof windowOrder.shopifyEconomicsExcludedAt, "number");
});

test("a local canonical window beyond the established cap fails closed with zero snapshot writes", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await connectedSite(t, "Local Cap");
  const { orderCutoffAt } = await service(t).mutation(api.sites.beginEconomicsSync, {
    siteId, attemptId: "local-cap", sinceDays: 60,
  });
  const ids = await t.run(async (ctx) => {
    const ids = [];
    for (let index = 0; index < 251; index++) {
      ids.push(await ctx.db.insert("orders", {
        siteId, shopifyOrderId: `gid://shopify/Order/window-${index}`,
        fulfillmentStatus: "received", createdAt: orderCutoffAt + index,
      }));
    }
    return ids;
  });
  const result = await service(t).mutation(api.sites.commitEconomicsSnapshot, {
    siteId, attemptId: "local-cap", products: [], orders: [],
  });
  assert.equal(result.status, "incomplete");
  assert.equal(result.reason, "local_order_window_exceeds_cap");
  const [site, first, last] = await t.run(async (ctx) => [
    await ctx.db.get(siteId), await ctx.db.get(ids[0]), await ctx.db.get(ids.at(-1)),
  ]);
  assert.equal(site.shopifyEconomicsSyncStatus, "incomplete");
  for (const row of [first, last]) {
    assert.equal(row.shopifyEconomicsSnapshotAttemptId, undefined);
    assert.equal(row.shopifyEconomicsExcludedAt, undefined);
  }
});

test("client clocks are outside the success capability", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await connectedSite(t, "No Caller Clock");
  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "no-clock", sinceDays: 60 });
  for (const snapshotReadAt of [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(() => service(t).mutation(api.sites.commitEconomicsSnapshot, {
      siteId, attemptId: "no-clock", snapshotReadAt, products: [], orders: [],
    }), /Unexpected field/);
  }
  const state = await t.run((ctx) => ctx.db.get(siteId));
  assert.equal(state.shopifyEconomicsSyncStatus, "pending");
  const committed = await service(t).mutation(api.sites.commitEconomicsSnapshot, {
    siteId, attemptId: "no-clock", products: [], orders: [],
  });
  assert.equal(committed.status, "current");
});
