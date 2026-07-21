import assert from "node:assert/strict";
import test from "node:test";
import { convexTest } from "convex-test";
import schemaModule from "../convex/schema.ts";
import apiModule from "../convex/_generated/api.js";
import { cjStagingInputDigest } from "../src/lib/cjOrder.ts";

const modules = {
  "../convex/orders.ts": () => import("../convex/orders.ts"),
  "../convex/webhooks.ts": () => import("../convex/webhooks.ts"),
  "../convex/actions.ts": () => import("../convex/actions.ts"),
  "../convex/audit.ts": () => import("../convex/audit.ts"),
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
};
const { api } = apiModule;
const schema = schemaModule.default ?? schemaModule;
const service = (t) => t.withIdentity({ subject: "dropship-ai:service" });
const shipping = { shippingZip: "90210", shippingCountryCode: "US", shippingCountry: "United States", shippingProvince: "CA", shippingCity: "Beverly Hills", shippingAddress: "1 Test Way", shippingCustomerName: "Test User", shippingPhone: "555" };
const lines = [{ productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/1", quantity: 1 }];

async function seed(t, status = "pending", runnableAt = 1) {
  return t.run(async (ctx) => {
    const siteId = await ctx.db.insert("sites", { name: "Test", niche: "test", status: "active", minKitPriceUsd: 40, minBlendedMarginPct: 70, distributionMode: "semi_manual", createdAt: 1 });
    const orderId = await ctx.db.insert("orders", { siteId, shopifyOrderId: "gid://shopify/Order/1", totalUsd: 50, fulfillmentStatus: "received", createdAt: 1 });
    const intentId = await ctx.db.insert("cjStagingIntents", { siteId, orderId, deliveryId: "delivery-a", payloadHash: "hash-a", status, attempt: 1, leaseGeneration: 2, failureCount: 0, runnableAt, shipping, shopifyLines: lines, stagingInputDigest: cjStagingInputDigest({ shipping, shopifyLines: lines }), createdAt: 1, updatedAt: 1 });
    return { siteId, orderId, intentId };
  });
}

test("Convex handlers reject anonymous service calls and due index returns only oldest due rows", async () => {
  const t = convexTest({ schema, modules });
  await assert.rejects(() => t.query(api.orders.listDueCjStagingIntents, { limit: 25 }), /UNAUTHENTICATED/);
  const a = await seed(t, "pending", 1);
  const b = await seed(t, "pending", Date.now() + 60_000);
  await t.run(async (ctx) => {
    await ctx.db.patch(b.intentId, { status: "needs_attention", runnableAt: 1 });
    await ctx.db.insert("cjStagingIntents", { siteId: a.siteId, orderId: a.orderId, deliveryId: "delivery-no-due", payloadHash: "hash-none", status: "pending", attempt: 0, shipping, shopifyLines: lines, createdAt: 1, updatedAt: 1 });
  });
  const due = await service(t).query(api.orders.listDueCjStagingIntents, { limit: 999 });
  assert.deepEqual(due.map((row) => row._id), [a.intentId]);
});

test("Convex receipt handler links order and intent atomically, including repaired legacy duplicate receipts", async () => {
  const t = convexTest({ schema, modules });
  const args = { deliveryId: "delivery-a", topic: "orders/create", payloadHash: "hash-a", shopifyOrderId: "gid://shopify/Order/1", totalUsd: 50, fulfillmentStatus: "received", createdAt: 1, stagingInput: { shipping, shopifyLines: lines } };
  const siteId = await t.run((ctx) => ctx.db.insert("sites", { name: "Test", niche: "test", status: "active", minKitPriceUsd: 40, minBlendedMarginPct: 70, distributionMode: "semi_manual", createdAt: 1 }));
  const first = await service(t).mutation(api.webhooks.recordShopifyOrder, { siteId, ...args });
  assert.equal(first.duplicate, false);
  const receipt = await t.run((ctx) => ctx.db.query("webhookReceipts").withIndex("by_provider_site_delivery", (q) => q.eq("provider", "shopify").eq("siteId", siteId).eq("deliveryId", args.deliveryId)).first());
  assert.equal(receipt.cjStagingIntentId, first.intentId);
  await t.run(async (ctx) => { await ctx.db.patch(receipt._id, { cjStagingIntentId: undefined }); });
  const replay = await service(t).mutation(api.webhooks.recordShopifyOrder, { siteId, ...args });
  assert.equal(replay.intentId, first.intentId);
  const repaired = await t.run((ctx) => ctx.db.get(receipt._id));
  assert.equal(repaired.cjStagingIntentId, first.intentId);
});

test("Convex failure handler fences stale workers and consumes exactly five accepted failures", async () => {
  const t = convexTest({ schema, modules });
  const { intentId } = await seed(t, "preflighting", 1);
  const stale = await service(t).mutation(api.orders.recordCjStagingFailure, { intentId, expectedPhase: "preflighting", expectedAttempt: 1, leaseGeneration: 1, kind: "retryable", errorCode: "provider_unavailable" });
  assert.equal(stale.ignored, true);
  for (let n = 1; n <= 5; n++) {
    await t.run(async (ctx) => { await ctx.db.patch(intentId, { status: "preflighting", attempt: n, leaseGeneration: n + 2, leaseExpiresAt: Date.now() + 1 }); });
    const result = await service(t).mutation(api.orders.recordCjStagingFailure, { intentId, expectedPhase: "preflighting", expectedAttempt: n, leaseGeneration: n + 2, kind: "retryable", errorCode: "provider_unavailable" });
    assert.equal(result.ignored, false);
  }
  const final = await t.run((ctx) => ctx.db.get(intentId));
  assert.equal(final.failureCount, 5);
  assert.equal(final.status, "needs_attention");
  const ignored = await service(t).mutation(api.orders.recordCjStagingFailure, { intentId, expectedPhase: "preflighting", expectedAttempt: 5, leaseGeneration: 7, kind: "retryable", errorCode: "provider_unavailable" });
  assert.equal(ignored.ignored, true);
});

test("Convex rollout is resumable and completion stops legacy status fan-out", async () => {
  const t = convexTest({ schema, modules });
  const { intentId } = await seed(t, "pending", 1);
  await t.run(async (ctx) => { await ctx.db.patch(intentId, { runnableAt: undefined }); });
  const legacy = await t.run((ctx) => ctx.db.query("cjStagingIntents").withIndex("by_status", (q) => q.eq("status", "pending")).collect());
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].runnableAt, undefined);
  const first = await service(t).mutation(api.orders.reconcileLegacyCjStagingIntents, { limit: 25 });
  assert.equal(first.repaired, 1);
  assert.equal((await t.run((ctx) => ctx.db.get(intentId))).runnableAt !== undefined, true);
  let result = first;
  for (let n = 0; n < 8 && !result.completed; n++) result = await service(t).mutation(api.orders.reconcileLegacyCjStagingIntents, { limit: 25 });
  assert.equal(result.completed, true);
  assert.deepEqual(await service(t).mutation(api.orders.reconcileLegacyCjStagingIntents, { limit: 25 }), { repaired: 0, completed: true });
});
