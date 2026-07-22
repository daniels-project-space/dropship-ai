import assert from "node:assert/strict";
import test from "node:test";
import { handleShopifySync } from "../app/api/shopify/sync/route.ts";
import { syncShopify } from "../src/lib/shopifySync.ts";
import { parseShopifySyncRequest } from "../src/lib/shopifySyncRequest.ts";
import { commercePresentationState } from "../src/lib/commercePresentation.ts";

const config = { shop: "fixture.myshopify.com", accessToken: "fixture-token" };
const shop = { name: "Fixture", myshopifyDomain: config.shop, currencyCode: "USD" };
const product = {
  id: "gid://shopify/Product/1", title: "Fixture product", status: "ACTIVE",
  priceUsd: 49, imageUrl: null,
};
const order = {
  id: "gid://shopify/Order/1", name: "#1", createdAt: Date.now(),
  displayFulfillmentStatus: "UNFULFILLED", currencyCode: "USD", currentTotal: 42,
  financialStatus: "PAID", test: false, cancelled: false, creditAdjustmentState: "none",
  lineItems: [],
};

function harness(overrides = {}) {
  const mutations = [];
  const client = {
    mutation: async (_reference, args) => {
      mutations.push(args);
      if ("products" in args && "orders" in args) {
        return { status: "current", productCount: args.products.length, orderCount: args.orders.length, finishedAt: 1234 };
      }
      return { ignored: false };
    },
  };
  return {
    mutations,
    dependencies: {
      client,
      createAttemptId: () => "attempt-fixture",
      readShop: async () => shop,
      readProducts: async () => ({ items: [product], complete: true }),
      readOrders: async () => ({ items: [order], complete: true }),
      now: () => 5678,
      ...overrides,
    },
  };
}

test("sync request parsing bounds site identity and coverage without coercion", () => {
  assert.deepEqual(parseShopifySyncRequest({ siteId: "j123456789", sinceDays: 60 }), { siteId: "j123456789", sinceDays: 60 });
  assert.deepEqual(parseShopifySyncRequest({ siteId: "j123456789" }), { siteId: "j123456789", sinceDays: 60 });
  for (const value of [
    null, [], {}, { siteId: " spaced " }, { siteId: "bad-id" }, { siteId: "x".repeat(129) },
    { siteId: "j123", sinceDays: "60" }, { siteId: "j123", sinceDays: 0 },
    { siteId: "j123", sinceDays: 61 }, { siteId: "j123", sinceDays: 1.5 },
  ]) assert.equal(parseShopifySyncRequest(value), null);
});

test("malformed sync JSON returns 400 with zero state, vault, or provider activity", async () => {
  let activity = 0;
  const dependencies = {
    authorize: async () => ({ ok: true }),
    sync: async () => { activity++; throw new Error("must not run"); },
    resolveConfig: async () => { activity++; throw new Error("must not run"); },
  };
  for (const request of [
    new Request("https://example.test/api/shopify/sync", { method: "POST", body: "{" }),
    new Request("https://example.test/api/shopify/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ siteId: "bad-id", sinceDays: 60 }) }),
    new Request("https://example.test/api/shopify/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ siteId: "j123", sinceDays: 600 }) }),
  ]) {
    const response = await handleShopifySync(request, dependencies);
    assert.equal(response.status, 400);
  }
  assert.equal(activity, 0);
});

test("a complete one-day diagnostic never calls the atomic success reducer", async () => {
  const run = harness();
  const result = await syncShopify("j123", config, { sinceDays: 1 }, run.dependencies);
  assert.equal(result.economicsSync, "incomplete");
  assert.equal(run.mutations.some((args) => "products" in args || "orders" in args), false);
  assert.deepEqual(run.mutations.at(-1), {
    siteId: "j123", attemptId: "attempt-fixture", status: "incomplete", reason: "noncanonical_window",
  });
});

test("failure after verified identity durably marks the active attempt failed", async () => {
  const run = harness({ readProducts: async () => { throw new Error("catalogue read failed"); } });
  await assert.rejects(() => syncShopify("j123", config, { sinceDays: 60 }, run.dependencies), /catalogue read failed/);
  assert.equal(run.mutations.length, 3);
  assert.deepEqual(run.mutations.at(-1), {
    siteId: "j123", attemptId: "attempt-fixture", status: "failed", reason: "provider_or_commit_failure",
  });
});

test("truncated products or orders perform zero mirror snapshot writes", async () => {
  for (const [kind, overrides] of [
    ["product_truncation", { readProducts: async () => ({ items: [product], complete: false }) }],
    ["order_truncation", { readOrders: async () => ({ items: [order], complete: false }) }],
  ]) {
    const run = harness(overrides);
    const result = await syncShopify("j123", config, { sinceDays: 60 }, run.dependencies);
    assert.equal(result.economicsSync, "incomplete");
    assert.equal(run.mutations.some((args) => "products" in args || "orders" in args), false);
    assert.equal(run.mutations.at(-1).reason, kind);
  }
});

test("complete canonical coverage reaches exactly one atomic snapshot commit", async () => {
  const run = harness();
  const result = await syncShopify("j123", config, { sinceDays: 60 }, run.dependencies);
  assert.deepEqual(result, { productCount: 1, orderCount: 1, lastSyncedAt: 1234, economicsSync: "current" });
  const commits = run.mutations.filter((args) => "products" in args && "orders" in args);
  assert.equal(commits.length, 1);
  assert.equal("productCount" in commits[0], false);
  assert.equal("orderCount" in commits[0], false);
});

test("commerce presentation withholds values and a current claim without canonical proof", () => {
  assert.deepEqual(commercePresentationState({ days: 30, revenueVerified: false, ordersVerified: true, funnelVerified: true }), {
    verified: false, loading: false, label: "Unverified", detail: "Awaiting current sync",
  });
  assert.equal(commercePresentationState({ days: 90, revenueVerified: true, ordersVerified: true, funnelVerified: true }).verified, false);
  assert.equal(commercePresentationState({ days: 30, revenueVerified: true, ordersVerified: true, funnelVerified: true }).label, "Current");
});
