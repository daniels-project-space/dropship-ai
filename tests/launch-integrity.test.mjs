import assert from "node:assert/strict";
import test from "node:test";
import { convexTest } from "convex-test";
import schemaModule from "../convex/schema.ts";
import apiModule from "../convex/_generated/api.js";
import { creditAdjustmentState, eligibleUsdOrder } from "../src/lib/shopifyOrder.ts";
import { listOrders } from "../src/lib/shopify.ts";

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

test("Shopify and CJ provider identities collide safely across tenants", async () => {
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

  await t.run(async (ctx) => {
    await ctx.db.patch(orderA._id, { cjOrderNumber: "cj-number-shared", cjOrderId: "cj-id-shared" });
    await ctx.db.patch(orderB._id, { cjOrderNumber: "cj-number-shared", cjOrderId: "cj-id-shared" });
  });
  await service(t).mutation(api.webhooks.recordCjTracking, {
    siteId: siteB, deliveryId: "cj-b", topic: "ORDER", payloadHash: "cj-hash-b",
    cjOrderNumber: "cj-number-shared", cjOrderId: "cj-id-shared", trackingNumber: "TRACK-B",
  });
  assert.equal((await t.run((ctx) => ctx.db.get(orderA._id))).trackingNumber, undefined);
  assert.equal((await t.run((ctx) => ctx.db.get(orderB._id))).trackingNumber, "TRACK-B");
  assert.equal((await service(t).query(api.orders.getByCjOrderNumber, { siteId: siteA, cjOrderNumber: "cj-number-shared" }))._id, orderA._id);
  assert.equal((await service(t).query(api.orders.getByCjOrderNumber, { siteId: siteB, cjOrderNumber: "cj-number-shared" }))._id, orderB._id);
  const byCjIdA = await t.run((ctx) => ctx.db.query("orders").withIndex("by_site_cj_order_id", (q) => q.eq("siteId", siteA).eq("cjOrderId", "cj-id-shared")).first());
  const byCjIdB = await t.run((ctx) => ctx.db.query("orders").withIndex("by_site_cj_order_id", (q) => q.eq("siteId", siteB).eq("cjOrderId", "cj-id-shared")).first());
  assert.equal(byCjIdA._id, orderA._id);
  assert.equal(byCjIdB._id, orderB._id);
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

test("non-USD stores fail the explicit connection precondition", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await site(t, "CAD", { status: "provisioning", storeCurrency: undefined });
  await assert.rejects(() => service(t).mutation(api.sites.connectStore, { siteId, shopifyDomain: "cad.myshopify.com", storeCurrency: "CAD" }), /require a USD store/);
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
