import assert from "node:assert/strict";
import test from "node:test";
import { convexTest } from "convex-test";
import schemaModule from "../convex/schema.ts";
import apiModule from "../convex/_generated/api.js";
import { creditAdjustmentState, eligibleUsdOrder } from "../src/lib/shopifyOrder.ts";
import { listOrders, listOrdersWithCoverage } from "../src/lib/shopify.ts";
import { shopifyEconomicsReadiness, SHOPIFY_ECONOMICS_SYNC_MAX_AGE_MS } from "../src/lib/shopifySyncState.ts";
import { vaultRefForDomain } from "../src/lib/shopifyIdentity.ts";

const modules = {
  "../convex/orders.ts": () => import("../convex/orders.ts"),
  "../convex/webhooks.ts": () => import("../convex/webhooks.ts"),
  "../convex/dashboard.ts": () => import("../convex/dashboard.ts"),
  "../convex/sites.ts": () => import("../convex/sites.ts"),
  "../convex/audit.ts": () => import("../convex/audit.ts"),
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
};
const { api } = apiModule;
const schema = schemaModule.default ?? schemaModule;
const service = (t) => t.withIdentity({ subject: "dropship-ai:service" });

async function site(t, name, extra = {}) {
  return t.run((ctx) => ctx.db.insert("sites", {
    name, niche: "test", status: "active", storeCurrency: "USD", minKitPriceUsd: 40,
    minBlendedMarginPct: 70, distributionMode: "semi_manual", createdAt: Date.now(), ...extra,
  }));
}

function shopifyDelivery(siteId, deliveryId, overrides = {}) {
  return {
    siteId, deliveryId, topic: "orders/create", payloadHash: `hash-${deliveryId}`,
    shopifyOrderId: "gid://shopify/Order/shared", currencyCode: "USD", currentTotal: 50,
    financialStatus: "PAID", test: false, cancelled: false, creditAdjustmentState: "none",
    fulfillmentStatus: "received", createdAt: Date.now(), ...overrides,
  };
}

test("Shopify identities remain tenant-scoped while ambiguous global CJ routes mutate neither tenant", async () => {
  const t = convexTest({ schema, modules });
  const siteA = await site(t, "A");
  const siteB = await site(t, "B");
  await service(t).mutation(api.webhooks.recordShopifyOrder, shopifyDelivery(siteA, "a"));
  await service(t).mutation(api.webhooks.recordShopifyOrder, shopifyDelivery(siteB, "b", { currentTotal: 80 }));
  const orderA = await service(t).query(api.orders.getByShopifyOrder, { siteId: siteA, shopifyOrderId: "gid://shopify/Order/shared" });
  const orderB = await service(t).query(api.orders.getByShopifyOrder, { siteId: siteB, shopifyOrderId: "gid://shopify/Order/shared" });
  assert.notEqual(orderA._id, orderB._id);
  assert.equal(orderA.currentTotal, 50);
  assert.equal(orderB.currentTotal, 80);

  const shared = `dsa-sb-${"a".repeat(32)}`;
  await t.run(async (ctx) => {
    await ctx.db.patch(orderA._id, { cjOrderNumber: shared, cjOrderId: "cj-id-shared" });
    await ctx.db.patch(orderB._id, { cjOrderNumber: shared, cjOrderId: "cj-id-shared" });
  });
  const ambiguous = await service(t).mutation(api.webhooks.recordCjTracking, {
    deliveryId: "cj-b", topic: "ORDER", payloadHash: "cj-hash-b",
    cjOrderNumber: shared, cjOrderId: "cj-id-shared", trackingNumber: "TRACK-B",
  });
  assert.equal(ambiguous.reason, "ambiguous_route");
  assert.equal((await t.run((ctx) => ctx.db.get(orderA._id))).trackingNumber, undefined);
  assert.equal((await t.run((ctx) => ctx.db.get(orderB._id))).trackingNumber, undefined);
  assert.equal((await service(t).query(api.orders.getByCjOrderNumber, { siteId: siteA, cjOrderNumber: shared }))._id, orderA._id);
  assert.equal((await service(t).query(api.orders.getByCjOrderNumber, { siteId: siteB, cjOrderNumber: shared }))._id, orderB._id);
  const byCjIdA = await t.run((ctx) => ctx.db.query("orders").withIndex("by_site_cj_order_id", (q) => q.eq("siteId", siteA).eq("cjOrderId", "cj-id-shared")).first());
  const byCjIdB = await t.run((ctx) => ctx.db.query("orders").withIndex("by_site_cj_order_id", (q) => q.eq("siteId", siteB).eq("cjOrderId", "cj-id-shared")).first());
  assert.equal(byCjIdA._id, orderA._id);
  assert.equal(byCjIdB._id, orderB._id);
});

test("one global CJ route applies once by messageId and rejects cross-tenant identity changes", async () => {
  const t = convexTest({ schema, modules });
  const siteA = await site(t, "CJ-A");
  const siteB = await site(t, "CJ-B");
  await service(t).mutation(api.webhooks.recordShopifyOrder, shopifyDelivery(siteA, "cj-a-order"));
  await service(t).mutation(api.webhooks.recordShopifyOrder, shopifyDelivery(siteB, "cj-b-order", { shopifyOrderId: "gid://shopify/Order/b" }));
  const orderA = await service(t).query(api.orders.getByShopifyOrder, { siteId: siteA, shopifyOrderId: "gid://shopify/Order/shared" });
  const orderB = await service(t).query(api.orders.getByShopifyOrder, { siteId: siteB, shopifyOrderId: "gid://shopify/Order/b" });
  const route = `dsa-sb-${"b".repeat(32)}`;
  await t.run(async (ctx) => {
    await ctx.db.patch(orderA._id, { cjOrderNumber: route, cjOrderId: "cj-a" });
    await ctx.db.patch(orderB._id, { cjOrderNumber: `dsa-sb-${"c".repeat(32)}`, cjOrderId: "cj-b" });
  });
  const input = { deliveryId: "7cceede817dc47ed9748328b64353c5c", topic: "ORDER", payloadHash: "official-order-hash", cjOrderNumber: route, cjOrderId: "cj-a", trackingNumber: "TRACK-A" };
  const first = await service(t).mutation(api.webhooks.recordCjTracking, input);
  const duplicate = await service(t).mutation(api.webhooks.recordCjTracking, input);
  assert.deepEqual([first.duplicate, duplicate.duplicate], [false, true]);
  assert.equal((await t.run((ctx) => ctx.db.get(orderA._id))).trackingNumber, "TRACK-A");
  assert.equal((await t.run((ctx) => ctx.db.get(orderB._id))).trackingNumber, undefined);
  await assert.rejects(() => service(t).mutation(api.webhooks.recordCjTracking, { ...input, payloadHash: "changed" }), /changed content/);
});

test("partial Shopify webhook updates preserve the observed current total", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await site(t, "Partial");
  await service(t).mutation(api.webhooks.recordShopifyOrder, shopifyDelivery(siteId, "create", { currentTotal: 73.25 }));
  await service(t).mutation(api.webhooks.recordShopifyOrder, {
    siteId, deliveryId: "updated", topic: "orders/updated", payloadHash: "hash-updated",
    shopifyOrderId: "gid://shopify/Order/shared", financialStatus: "PAID",
    fulfillmentStatus: "shipped", createdAt: Date.now(),
  });
  const order = await service(t).query(api.orders.getByShopifyOrder, { siteId, shopifyOrderId: "gid://shopify/Order/shared" });
  assert.equal(order.currentTotal, 73.25);
  assert.equal(order.totalUsd, 73.25);
  assert.equal(order.fulfillmentStatus, "shipped");
});

test("dashboard revenue and conversion count only paid real unadjusted USD orders", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await site(t, "Economics");
  const now = Date.now();
  const base = { siteId, fulfillmentStatus: "received", currencyCode: "USD", currentTotal: 40, test: false, cancelled: false, creditAdjustmentState: "none", createdAt: now, sample: false };
  await t.run(async (ctx) => {
    await ctx.db.insert("orders", { ...base, shopifyOrderId: "paid", financialStatus: "PAID" });
    await ctx.db.insert("orders", { ...base, shopifyOrderId: "pending", financialStatus: "PENDING" });
    await ctx.db.insert("orders", { ...base, shopifyOrderId: "test", financialStatus: "PAID", test: true });
    await ctx.db.insert("orders", { ...base, shopifyOrderId: "cancelled", financialStatus: "PAID", cancelled: true });
    await ctx.db.insert("orders", { ...base, shopifyOrderId: "credited", financialStatus: "PARTIALLY_REFUNDED", creditAdjustmentState: "partial", currentTotal: 20 });
    await ctx.db.insert("orders", { ...base, shopifyOrderId: "cad", financialStatus: "PAID", currencyCode: "CAD" });
  });
  const revenue = await service(t).query(api.dashboard.timeseries, { scope: siteId, metric: "revenue", days: 2 });
  const orders = await service(t).query(api.dashboard.timeseries, { scope: siteId, metric: "orders", days: 2 });
  const funnel = await service(t).query(api.dashboard.funnel, { scope: siteId, days: 2 });
  assert.equal(revenue.total, 40);
  assert.equal(revenue.currencyCode, "USD");
  assert.equal(orders.total, 1);
  assert.equal(funnel.stages.at(-1).value, 1);
  assert.equal(funnel.purchaseBasis, "eligible_real_paid_usd_orders");
});

test("economic reducer excludes unpaid, test, cancelled, credited and non-USD facts", () => {
  const paid = { currencyCode: "USD", currentTotal: 10, financialStatus: "PAID", test: false, cancelled: false, creditAdjustmentState: "none" };
  assert.equal(eligibleUsdOrder(paid, "USD"), true);
  for (const patch of [{ financialStatus: "PENDING" }, { test: true }, { cancelled: true }, { creditAdjustmentState: "partial" }, { currencyCode: "CAD" }]) {
    assert.equal(eligibleUsdOrder({ ...paid, ...patch }, "USD"), false);
  }
  assert.equal(eligibleUsdOrder(paid, "CAD"), false);
  assert.equal(creditAdjustmentState("REFUNDED"), "full");
  assert.equal(creditAdjustmentState("PAID", true), "partial");
});

test("a seeded sample site cannot be transitioned into a live store", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await site(t, "Sample", { sample: true });
  await t.run((ctx) => ctx.db.insert("orders", { siteId, shopifyOrderId: "sample-child", fulfillmentStatus: "received", createdAt: 1, sample: true }));
  await assert.rejects(() => service(t).mutation(api.sites.connectStore, { siteId, shopifyDomain: "real.myshopify.com", storeCurrency: "USD" }), /sample site cannot become live/);
  const stored = await t.run((ctx) => ctx.db.get(siteId));
  assert.equal(stored.sample, true);
  assert.equal(stored.shopifyDomain, undefined);
});

test("operator CRUD cannot establish or mutate Shopify identity or economics proof", async () => {
  const t = convexTest({ schema, modules });
  const operator = t.withIdentity({ subject: "dropship-ai:operator" });
  const createArgs = {
    name: "Operator", niche: "test", minKitPriceUsd: 40, minBlendedMarginPct: 70,
    distributionMode: "semi_manual", shopifyDomain: "bypass.myshopify.com",
  };
  await assert.rejects(() => operator.mutation(api.sites.create, createArgs), /Unexpected field/);
  const siteId = await site(t, "No bypass", { status: "provisioning", storeCurrency: undefined });
  for (const patch of [
    { shopifyDomain: "bypass.myshopify.com" },
    { storeCurrency: "USD" },
    { shopifyAccessVerifiedAt: Date.now() },
    { shopifyEconomicsSyncStatus: "current", shopifyEconomicsSyncSucceededAt: Date.now() },
  ]) {
    await assert.rejects(() => operator.mutation(api.sites.update, { siteId, ...patch }), /Unexpected field/);
  }
  const stored = await t.run((ctx) => ctx.db.get(siteId));
  assert.equal(stored.shopifyDomain, undefined);
  assert.equal(stored.storeCurrency, undefined);
  assert.equal(stored.shopifyAccessVerifiedAt, undefined);
  assert.equal(stored.shopifyEconomicsSyncStatus, undefined);
});

test("non-USD stores fail the explicit connection precondition", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await site(t, "CAD", { status: "provisioning", storeCurrency: undefined });
  await assert.rejects(() => service(t).mutation(api.sites.connectStore, { siteId, shopifyDomain: "cad.myshopify.com", storeCurrency: "CAD" }), /require a USD store/);
});

test("first Shopify connection atomically writes recurring reference, identity and currency", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await site(t, "Atomic", { status: "provisioning", storeCurrency: undefined });
  await assert.rejects(() => t.withIdentity({ subject: "dropship-ai:operator" }).mutation(api.sites.connectStore, { siteId, shopifyDomain: "atomic.myshopify.com", storeCurrency: "USD" }), /service runtime/);
  await service(t).mutation(api.sites.connectStore, { siteId, shopifyDomain: "atomic.myshopify.com", storeCurrency: "USD" });
  const stored = await t.run((ctx) => ctx.db.get(siteId));
  const refs = await t.run((ctx) => ctx.db.query("siteSecrets").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect());
  assert.equal(stored.shopifyDomain, "atomic.myshopify.com");
  assert.equal(stored.storeCurrency, "USD");
  assert.equal(typeof stored.shopifyAccessVerifiedAt, "number");
  assert.deepEqual(refs.map(({ key, vaultRef }) => ({ key, vaultRef })), [{ key: "SHOPIFY_ADMIN_TOKEN", vaultRef: "shopify/ATOMIC" }]);
});

test("a verified site cannot rebind domains and preserves all prior tenant state", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await site(t, "Bound", { status: "provisioning", storeCurrency: undefined });
  await service(t).mutation(api.sites.connectStore, { siteId, shopifyDomain: "bound.myshopify.com", storeCurrency: "USD" });
  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "bound-current", sinceDays: 60 });
  await service(t).mutation(api.sites.finishEconomicsSync, { siteId, attemptId: "bound-current", status: "current", productCount: 1, orderCount: 1 });
  await t.run(async (ctx) => {
    await ctx.db.insert("products", { siteId, title: "Kept", cjFromUsWarehouse: true, cogsUsd: 1, shippingUsd: 1, priceUsd: 10, status: "draft", createdAt: 1 });
    await ctx.db.insert("orders", { siteId, shopifyOrderId: "kept-order", fulfillmentStatus: "received", createdAt: 1 });
  });
  const before = await t.run(async (ctx) => ({
    site: await ctx.db.get(siteId),
    refs: await ctx.db.query("siteSecrets").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect(),
    products: await ctx.db.query("products").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect(),
    orders: await ctx.db.query("orders").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect(),
  }));
  await assert.rejects(
    () => service(t).mutation(api.sites.connectStore, { siteId, shopifyDomain: "other.myshopify.com", storeCurrency: "USD" }),
    /cannot be changed/,
  );
  const after = await t.run(async (ctx) => ({
    site: await ctx.db.get(siteId),
    refs: await ctx.db.query("siteSecrets").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect(),
    products: await ctx.db.query("products").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect(),
    orders: await ctx.db.query("orders").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect(),
  }));
  assert.deepEqual(after, before);
});

test("aliased deterministic Shopify vault references cannot cross site boundaries", async () => {
  assert.equal(vaultRefForDomain("repeat--hyphen.myshopify.com"), vaultRefForDomain("repeat-hyphen.myshopify.com"));
  const t = convexTest({ schema, modules });
  const siteA = await site(t, "Alias A", { status: "provisioning", storeCurrency: undefined });
  const siteB = await site(t, "Alias B", { status: "provisioning", storeCurrency: undefined });
  await service(t).mutation(api.sites.connectStore, { siteId: siteA, shopifyDomain: "repeat--hyphen.myshopify.com", storeCurrency: "USD" });
  await assert.rejects(
    () => service(t).mutation(api.sites.connectStore, { siteId: siteB, shopifyDomain: "repeat-hyphen.myshopify.com", storeCurrency: "USD" }),
    /vault reference is already bound/,
  );
  const [storedB, refsB] = await t.run(async (ctx) => [
    await ctx.db.get(siteB),
    await ctx.db.query("siteSecrets").withIndex("by_site", (q) => q.eq("siteId", siteB)).collect(),
  ]);
  assert.equal(storedB.shopifyDomain, undefined);
  assert.deepEqual(refsB, []);
});

test("economics sync records complete zero-commerce success and fails closed after a later failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { orders: {
    pageInfo: { hasNextPage: false, endCursor: null }, nodes: [],
  } } }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const emptyRead = await listOrdersWithCoverage({ shop: "zero.myshopify.com", accessToken: "fixture-token" });
    assert.deepEqual(emptyRead, { items: [], complete: true });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const t = convexTest({ schema, modules });
  const siteId = await site(t, "Zero", { status: "provisioning", storeCurrency: undefined });
  await service(t).mutation(api.sites.connectStore, { siteId, shopifyDomain: "zero.myshopify.com", storeCurrency: "USD" });
  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "zero-success", sinceDays: 60 });
  await service(t).mutation(api.sites.finishEconomicsSync, { siteId, attemptId: "zero-success", status: "current", productCount: 0, orderCount: 0 });
  const successful = await t.run((ctx) => ctx.db.get(siteId));
  assert.equal(successful.shopifyEconomicsSyncProductCount, 0);
  assert.equal(successful.shopifyEconomicsSyncOrderCount, 0);
  assert.equal(shopifyEconomicsReadiness(successful, successful.shopifyEconomicsSyncSucceededAt), "current");

  await service(t).mutation(api.sites.beginEconomicsSync, { siteId, attemptId: "read-orders-denied", sinceDays: 60 });
  await service(t).mutation(api.sites.finishEconomicsSync, { siteId, attemptId: "read-orders-denied", status: "failed" });
  const failed = await t.run((ctx) => ctx.db.get(siteId));
  assert.equal(failed.shopifyEconomicsSyncSucceededAt, successful.shopifyEconomicsSyncSucceededAt);
  assert.equal(failed.shopifyEconomicsSyncOrderCount, 0);
  assert.equal(shopifyEconomicsReadiness(failed), "failed");
});

test("stale and incomplete economics evidence never becomes current readiness", async () => {
  const now = 1_800_000_000_000;
  const identity = { shopifyDomain: "state.myshopify.com", storeCurrency: "USD", shopifyAccessVerifiedAt: now - 1 };
  assert.equal(shopifyEconomicsReadiness({ ...identity, shopifyEconomicsSyncStatus: "current", shopifyEconomicsSyncSucceededAt: now - SHOPIFY_ECONOMICS_SYNC_MAX_AGE_MS - 1 }, now), "stale");
  assert.equal(shopifyEconomicsReadiness({ ...identity, shopifyEconomicsSyncStatus: "incomplete", shopifyEconomicsSyncSucceededAt: now - 1 }, now), "incomplete");
});

test("missing read_orders fails and a 250-row hard-cap reports incomplete coverage", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ errors: [{ message: "Access denied for orders field. Required access: read_orders." }] }), { status: 200, headers: { "content-type": "application/json" } });
    await assert.rejects(() => listOrdersWithCoverage({ shop: "scope.myshopify.com", accessToken: "fixture-token" }), /read_orders/);

    let page = 0;
    globalThis.fetch = async () => {
      const offset = page++ * 50;
      return new Response(JSON.stringify({ data: { orders: {
        pageInfo: { hasNextPage: true, endCursor: `cursor-${page}` },
        nodes: Array.from({ length: 50 }, (_, index) => ({
          id: `gid://shopify/Order/${offset + index}`, name: `#${offset + index}`, createdAt: "2026-07-22T00:00:00Z",
          displayFulfillmentStatus: "UNFULFILLED", displayFinancialStatus: "PAID", test: false, cancelledAt: null,
          currentTotalPriceSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } }, refunds: [], lineItems: { nodes: [] },
        })),
      } } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const read = await listOrdersWithCoverage({ shop: "cap.myshopify.com", accessToken: "fixture-token" });
    assert.equal(read.items.length, 250);
    assert.equal(read.complete, false);
    assert.equal(page, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bounded connected-site verification backfills legacy currency before current order economics", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await site(t, "Legacy", { shopifyDomain: "legacy.myshopify.com", storeCurrency: undefined, shopifyAccessVerifiedAt: undefined });
  await t.run((ctx) => ctx.db.insert("siteSecrets", { siteId, key: "SHOPIFY_ADMIN_TOKEN", vaultRef: "shopify/LEGACY" }));
  await service(t).mutation(api.sites.verifyConnectedStore, { siteId, shopifyDomain: "legacy.myshopify.com", storeCurrency: "USD" });
  await service(t).mutation(api.orders.upsertFromShopify, { siteId, orders: [{ shopifyOrderId: "gid://shopify/Order/legacy", currencyCode: "USD", currentTotal: 64.5, financialStatus: "PAID", test: false, cancelled: false, creditAdjustmentState: "none", fulfillmentStatus: "received", createdAt: 1 }] });
  const stored = await t.run((ctx) => ctx.db.get(siteId));
  const order = await service(t).query(api.orders.getByShopifyOrder, { siteId, shopifyOrderId: "gid://shopify/Order/legacy" });
  assert.equal(stored.storeCurrency, "USD");
  assert.equal(typeof stored.shopifyAccessVerifiedAt, "number");
  assert.equal(order.currentTotal, 64.5);
  assert.equal(eligibleUsdOrder(order, stored.storeCurrency), true);
});

test("Shopify domain or currency mismatch changes no legacy connection state", async () => {
  for (const args of [
    { shopifyDomain: "other.myshopify.com", storeCurrency: "USD" },
    { shopifyDomain: "legacy.myshopify.com", storeCurrency: "CAD" },
  ]) {
    const t = convexTest({ schema, modules });
    const siteId = await site(t, "Mismatch", { shopifyDomain: "legacy.myshopify.com", storeCurrency: undefined, shopifyAccessVerifiedAt: undefined });
    await t.run((ctx) => ctx.db.insert("siteSecrets", { siteId, key: "SHOPIFY_ADMIN_TOKEN", vaultRef: "shopify/LEGACY" }));
    await assert.rejects(() => service(t).mutation(api.sites.verifyConnectedStore, { siteId, ...args }));
    const stored = await t.run((ctx) => ctx.db.get(siteId));
    assert.equal(stored.shopifyDomain, "legacy.myshopify.com");
    assert.equal(stored.storeCurrency, undefined);
    assert.equal(stored.shopifyAccessVerifiedAt, undefined);
  }
});

test("Shopify sync reads current money, currency, payment, test, cancellation and credit facts", async () => {
  const originalFetch = globalThis.fetch;
  let query = "";
  globalThis.fetch = async (_url, init) => {
    query = JSON.parse(init.body).query;
    return new Response(JSON.stringify({ data: { orders: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{
        id: "gid://shopify/Order/1", name: "#1", createdAt: "2026-07-22T00:00:00Z",
        displayFulfillmentStatus: "UNFULFILLED", displayFinancialStatus: "PARTIALLY_REFUNDED",
        test: false, cancelledAt: null,
        currentTotalPriceSet: { shopMoney: { amount: "42.50", currencyCode: "USD" } },
        refunds: [{ id: "gid://shopify/Refund/1" }], lineItems: { nodes: [] },
      }],
    } } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const [order] = await listOrders({ shop: "example.myshopify.com", accessToken: "scoped-test" }, { limit: 1 });
    assert.match(query, /currentTotalPriceSet/);
    for (const field of ["displayFinancialStatus", "test", "cancelledAt", "refunds"]) assert.match(query, new RegExp(field));
    assert.equal(order.currentTotal, 42.5);
    assert.equal(order.currencyCode, "USD");
    assert.equal(order.financialStatus, "PARTIALLY_REFUNDED");
    assert.equal(order.creditAdjustmentState, "partial");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
