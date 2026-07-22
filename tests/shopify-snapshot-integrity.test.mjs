import assert from "node:assert/strict";
import test from "node:test";
import { convexTest } from "convex-test";
import schemaModule from "../convex/schema.ts";
import apiModule from "../convex/_generated/api.js";
import { shopifyEconomicsReadiness } from "../src/lib/shopifySyncState.ts";

const modules = {
  "../convex/sites.ts": () => import("../convex/sites.ts"),
  "../convex/audit.ts": () => import("../convex/audit.ts"),
  "../convex/dashboard.ts": () => import("../convex/dashboard.ts"),
  "../convex/webhooks.ts": () => import("../convex/webhooks.ts"),
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
};
const { api } = apiModule;
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
    siteId, attemptId: "atomic-counts", snapshotReadAt: Date.now(), products: [snapshotProduct()], orders: [snapshotOrder()],
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
  assert.equal(products[0].shopifyEconomicsSnapshotAttemptId, "atomic-counts");
  assert.equal(orders[0].shopifyEconomicsSnapshotAttemptId, "atomic-counts");
  assert.equal(shopifyEconomicsReadiness(site, result.finishedAt), "current");
  await assert.rejects(
    () => service(t).mutation(api.sites.commitEconomicsSnapshot, {
      siteId, attemptId: "atomic-counts", snapshotReadAt: Date.now(), products: [], orders: [], productCount: 999,
    }),
    /Unexpected field/,
  );
});

test("one-day diagnostics and superseded attempts cannot write or finish a snapshot", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await connectedSite(t, "Fenced");
  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "diagnostic", sinceDays: 1 });
  const diagnostic = await service(t).mutation(api.sites.commitEconomicsSnapshot, {
    siteId, attemptId: "diagnostic", snapshotReadAt: Date.now(), products: [snapshotProduct("diagnostic")], orders: [],
  });
  assert.equal(diagnostic.status, "incomplete");
  assert.equal((await t.run((ctx) => ctx.db.query("products").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect())).length, 0);
  assert.equal(shopifyEconomicsReadiness(await t.run((ctx) => ctx.db.get(siteId))), "incomplete");

  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "older", sinceDays: 60 });
  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "newer", sinceDays: 60 });
  await assert.rejects(() => service(t).mutation(api.sites.commitEconomicsSnapshot, {
    siteId, attemptId: "older", snapshotReadAt: Date.now(), products: [snapshotProduct("stale")], orders: [],
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
    siteId, attemptId: "complete-old", snapshotReadAt: Date.now(), products: [snapshotProduct("old")], orders: [snapshotOrder("old")],
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
    siteId, attemptId: "nonzero", snapshotReadAt: Date.now(), products: [snapshotProduct("gone")],
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
  const zero = await service(t).mutation(api.sites.commitEconomicsSnapshot, { siteId, attemptId: "zero", snapshotReadAt: Date.now(), products: [], orders: [] });
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
  assert.equal(shopifyEconomicsReadiness(storedSite, zero.finishedAt), "current");
  const revenue = await service(t).query(api.dashboard.timeseries, { scope: siteId, metric: "revenue", days: 30 });
  assert.equal(revenue.commerceVerified, true);
  assert.equal(revenue.total, 0);
});

test("a webhook/provider observation after attempt start is preserved and makes the attempt incomplete", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await connectedSite(t, "Webhook Race");
  const { attemptedAt } = await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "race", sinceDays: 60 });
  await service(t).mutation(api.webhooks.recordShopifyOrder, {
    siteId, deliveryId: "race-delivery", topic: "orders/create", payloadHash: "race-hash",
    ...snapshotOrder("race"),
  });
  const racedOrder = await t.run(async (ctx) => {
    const row = await ctx.db.query("orders").withIndex("by_site", (q) => q.eq("siteId", siteId)).first();
    await ctx.db.patch(row._id, { shopifyObservedAt: attemptedAt + 1 });
    return row._id;
  });
  const result = await service(t).mutation(api.sites.commitEconomicsSnapshot, {
    siteId, attemptId: "race", snapshotReadAt: Date.now(), products: [], orders: [],
  });
  assert.equal(result.status, "incomplete");
  const [site, order] = await t.run(async (ctx) => [await ctx.db.get(siteId), await ctx.db.get(racedOrder)]);
  assert.equal(site.shopifyEconomicsSyncStatus, "incomplete");
  assert.equal(order.currentTotal, 42);
  assert.equal(order.shopifyEconomicsSnapshotAttemptId, undefined);
});

test("a supplied snapshot merges around newer partial webhook fields deterministically", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await connectedSite(t, "Webhook Merge");
  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "merge-old", sinceDays: 60 });
  await service(t).mutation(api.sites.commitEconomicsSnapshot, {
    siteId, attemptId: "merge-old", snapshotReadAt: Date.now(), products: [], orders: [snapshotOrder("merge", { currentTotal: 40 })],
  });
  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "merge-new", sinceDays: 60 });
  const snapshotReadAt = Date.now();
  await service(t).mutation(api.webhooks.recordShopifyOrder, {
    siteId, deliveryId: "merge-delivery", topic: "orders/updated", payloadHash: "merge-hash",
    shopifyOrderId: "gid://shopify/Order/merge", financialStatus: "REFUNDED",
    creditAdjustmentState: "full", fulfillmentStatus: "shipped", createdAt: Date.now(),
  });
  await t.run(async (ctx) => {
    const row = await ctx.db.query("orders").withIndex("by_site", (q) => q.eq("siteId", siteId)).first();
    await ctx.db.patch(row._id, {
      shopifyObservedAt: snapshotReadAt + 1,
      shopifyEconomicFieldObservedAt: {
        ...row.shopifyEconomicFieldObservedAt,
        financialStatus: snapshotReadAt + 1,
        creditAdjustmentState: snapshotReadAt + 1,
      },
    });
  });
  const result = await service(t).mutation(api.sites.commitEconomicsSnapshot, {
    siteId, attemptId: "merge-new", snapshotReadAt, products: [],
    orders: [snapshotOrder("merge", { currentTotal: 55, financialStatus: "PAID", creditAdjustmentState: "none" })],
  });
  const stored = await t.run((ctx) => ctx.db.query("orders").withIndex("by_site", (q) => q.eq("siteId", siteId)).first());
  assert.equal(result.status, "current");
  assert.equal(stored.currentTotal, 55);
  assert.equal(stored.financialStatus, "REFUNDED");
  assert.equal(stored.creditAdjustmentState, "full");
  assert.equal(stored.fulfillmentStatus, "shipped");
  assert.equal(stored.shopifyEconomicsSnapshotAttemptId, "merge-new");
});
