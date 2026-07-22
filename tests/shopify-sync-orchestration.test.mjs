import assert from "node:assert/strict";
import test from "node:test";
import { convexTest } from "convex-test";
import { handleShopifySync } from "../app/api/shopify/sync/route.ts";
import { syncShopify } from "../src/lib/shopifySync.ts";
import { parseShopifySyncRequest } from "../src/lib/shopifySyncRequest.ts";
import { commercePresentationState } from "../src/lib/commercePresentation.ts";
import schemaModule from "../convex/schema.ts";
import apiModule from "../convex/_generated/api.js";

const modules = {
  "../convex/sites.ts": () => import("../convex/sites.ts"),
  "../convex/audit.ts": () => import("../convex/audit.ts"),
  "../convex/webhooks.ts": () => import("../convex/webhooks.ts"),
  "../convex/shopifyEconomics.ts": () => import("../convex/shopifyEconomics.ts"),
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
};
const { api } = apiModule;
const schema = schemaModule.default ?? schemaModule;
const service = (t) => t.withIdentity({ subject: "dropship-ai:service" });

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
      if ("sinceDays" in args && !("status" in args)) {
        return { attemptedAt: 10_000, orderCutoffAt: 10_000 - args.sinceDays * 86_400_000 };
      }
      if ("products" in args && "orders" in args) {
        return { status: "current", productCount: args.products.length, orderCount: args.orders.length, finishedAt: 1234 };
      }
      if ("status" in args) return { ignored: false, attemptMatched: true, status: args.status, finishedAt: 2345 };
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
  assert.equal("snapshotReadAt" in commits[0], false);
});

test("an applied webhook inside a real provider-read promise causally invalidates sync and route", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await t.run((ctx) => ctx.db.insert("sites", {
    name: "Orchestration Race", niche: "test", status: "provisioning", minKitPriceUsd: 40,
    minBlendedMarginPct: 70, distributionMode: "semi_manual", createdAt: Date.now(),
  }));
  await service(t).mutation(api.sites.connectStore, {
    siteId, shopifyDomain: config.shop, storeCurrency: "USD",
  });
  const client = { mutation: (reference, args) => service(t).mutation(reference, args) };
  let durableCutoff;
  let dependencyClockCalls = 0;
  const dependencies = {
    client,
    createAttemptId: () => "orchestration-race",
    readShop: async () => shop,
    // The mutation occurs after begin and while this provider read remains unresolved.
    readProducts: async () => {
      await service(t).mutation(api.webhooks.recordShopifyOrder, {
        siteId, deliveryId: "during-read", topic: "orders/create", payloadHash: "during-read-hash",
        shopifyOrderId: "gid://shopify/Order/during-read", fulfillmentStatus: "received",
        createdAt: Date.now(), currencyCode: "USD", currentTotal: 77, financialStatus: "PAID",
        test: false, cancelled: false, creditAdjustmentState: "none",
      });
      return { items: [], complete: true };
    },
    readOrders: async (_cfg, options) => {
      durableCutoff = options.createdAtMin;
      return { items: [], complete: true };
    },
    // A former caller clock can be arbitrarily skewed; sync no longer reads it.
    now: () => { dependencyClockCalls++; return Number.MAX_SAFE_INTEGER; },
  };
  let canonicalResult;
  const response = await handleShopifySync(new Request("https://example.test/api/shopify/sync", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ siteId, sinceDays: 60 }),
  }), {
    authorize: async () => ({ ok: true }),
    resolveConfig: async () => config,
    sync: async (id, resolveConfig, options) => {
      canonicalResult = await syncShopify(id, resolveConfig, options, dependencies);
      return canonicalResult;
    },
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).state, "incomplete");
  assert.equal(canonicalResult.economicsSync, "incomplete");
  assert.equal(dependencyClockCalls, 0);

  const state = await t.run(async (ctx) => ({
    site: await ctx.db.get(siteId),
    products: await ctx.db.query("products").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect(),
    orders: await ctx.db.query("orders").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect(),
  }));
  assert.equal(durableCutoff, state.site.shopifyEconomicsSyncOrderCutoffAt);
  assert.equal(state.site.shopifyEconomicsSyncStatus, "incomplete");
  assert.equal(state.site.shopifyEconomicsSyncAttemptId, "orchestration-race");
  assert.equal(state.site.shopifyEconomicsSyncSucceededAt, undefined);
  assert.equal(state.site.shopifyEconomicsSyncProductCount, undefined);
  assert.equal(state.site.shopifyEconomicsSyncOrderCount, undefined);
  assert.equal(state.products.length, 0);
  assert.equal(state.orders.length, 1);
  assert.equal(state.orders[0].currentTotal, 77);
  assert.equal(state.orders[0].shopifyEconomicsSnapshotAttemptId, undefined);
});

test("a provider-read failure cannot overwrite an already-incomplete race result", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await t.run((ctx) => ctx.db.insert("sites", {
    name: "Race Then Failure", niche: "test", status: "provisioning", minKitPriceUsd: 40,
    minBlendedMarginPct: 70, distributionMode: "semi_manual", createdAt: Date.now(),
  }));
  await service(t).mutation(api.sites.connectStore, {
    siteId, shopifyDomain: config.shop, storeCurrency: "USD",
  });
  const result = await syncShopify(siteId, config, { sinceDays: 60 }, {
    client: { mutation: (reference, args) => service(t).mutation(reference, args) },
    createAttemptId: () => "race-then-failure",
    readShop: async () => shop,
    readProducts: async () => {
      await service(t).mutation(api.webhooks.recordShopifyOrder, {
        siteId, deliveryId: "race-then-failure", topic: "orders/create", payloadHash: "race-then-failure-hash",
        shopifyOrderId: "gid://shopify/Order/race-then-failure", fulfillmentStatus: "received",
        createdAt: Date.now(), currencyCode: "USD", currentTotal: 88, financialStatus: "PAID",
        test: false, cancelled: false, creditAdjustmentState: "none",
      });
      throw new Error("catalogue dependency failed after observation");
    },
    readOrders: async () => ({ items: [], complete: true }),
  });
  assert.equal(result.economicsSync, "incomplete");
  const site = await t.run((ctx) => ctx.db.get(siteId));
  assert.equal(site.shopifyEconomicsSyncStatus, "incomplete");
  assert.equal(site.shopifyEconomicsSyncAttemptId, "race-then-failure");
  assert.equal(site.shopifyEconomicsSyncInvalidationReason, "shopify_webhook_order_observation");
});

test("commerce presentation withholds values and a current claim without canonical proof", () => {
  assert.deepEqual(commercePresentationState({ days: 30, revenueVerified: false, ordersVerified: true, funnelVerified: true }), {
    verified: false, loading: false, label: "Unverified", detail: "Awaiting current sync",
  });
  assert.equal(commercePresentationState({ days: 90, revenueVerified: true, ordersVerified: true, funnelVerified: true }).verified, false);
  assert.equal(commercePresentationState({ days: 30, revenueVerified: true, ordersVerified: true, funnelVerified: true }).label, "Current");
});
