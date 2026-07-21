import assert from "node:assert/strict";
import test from "node:test";
import { convexTest } from "convex-test";
import schemaModule from "../convex/schema.ts";
import apiModule from "../convex/_generated/api.js";
import { cjOrderInputHash, cjStagingInputDigest } from "../src/lib/cjOrder.ts";
import { cjStagingGenerationFingerprint } from "../src/lib/cjStagingState.ts";

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

async function seedApprovedDispatch(t) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const siteId = await ctx.db.insert("sites", { name: "Dispatch", niche: "test", status: "active", minKitPriceUsd: 40, minBlendedMarginPct: 70, distributionMode: "semi_manual", createdAt: now });
    const orderId = await ctx.db.insert("orders", { siteId, shopifyOrderId: "gid://shopify/Order/dispatch", totalUsd: 50, fulfillmentStatus: "received", createdAt: now });
    const cjOrderInput = { orderNumber: "dsa-sb-dispatch", ...shipping, logisticName: "USPS", fromCountryCode: "US", products: [{ vid: "v1", quantity: 1 }] };
    const inputHash = cjOrderInputHash(cjOrderInput);
    const quoteInputDigest = "q".repeat(64);
    const preflight = { logisticName: "USPS", fromCountryCode: "US", quotedAt: now, quotedPriceUsd: 5 };
    const generation = 1;
    const generationFingerprint = cjStagingGenerationFingerprint({ generation, inputHash, quoteInputDigest, ...preflight });
    const actionId = await ctx.db.insert("actions", { siteId, type: "dispatch_cj_sandbox_order", riskTier: "human_gated", status: "approved", params: { orderId, orderNumber: cjOrderInput.orderNumber, inputHash, generation, generationFingerprint, quoteInputDigest, isSandbox: 1, payType: 3, logisticName: "USPS", fromCountryCode: "US", logisticsQuotedAt: now, logisticsQuotedPriceUsd: 5 }, rationale: "test", proposedAt: now });
    await ctx.db.patch(orderId, { cjOrderInput, cjLogisticsPreflight: preflight, cjOrderInputHash: inputHash, cjOrderNumber: cjOrderInput.orderNumber, cjDispatchGeneration: generation, cjDispatchGenerationFingerprint: generationFingerprint, cjQuoteInputDigest: quoteInputDigest, cjApprovalActionId: actionId, cjDispatchStatus: "staged", cjDispatchAttempt: 0 });
    return { siteId, orderId, actionId };
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

test("final CJ provider writers reject stale immutable reservation receipts", async () => {
  const t = convexTest({ schema, modules });
  const { orderId, actionId } = await seedApprovedDispatch(t);
  await assert.rejects(() => t.mutation(api.orders.claimSandboxCjDispatch, { actionId }), /UNAUTHENTICATED/);
  const claim = await service(t).mutation(api.orders.claimSandboxCjDispatch, { actionId });
  assert.equal(claim.state, "reserved");
  assert.equal(claim.receipt.attempt, 1);
  // Simulate a newer reservation after reconciliation. A late worker from attempt 1 may not
  // mark success, ambiguity, or reconciliation on attempt 2.
  await t.run((ctx) => ctx.db.patch(orderId, { cjDispatchAttempt: 2 }));
  const complete = await service(t).mutation(api.orders.markSandboxCjDispatched, { actionId, orderId, cjOrderId: "cj-old", receipt: claim.receipt });
  const ambiguous = await service(t).mutation(api.orders.markSandboxCjAmbiguous, { actionId, orderId, reason: "lost", receipt: claim.receipt });
  const reconcile = await service(t).mutation(api.orders.reconcileSandboxCjDispatch, { actionId, orderId, receipt: claim.receipt });
  assert.equal(complete.ignored, true);
  assert.equal(ambiguous.ignored, true);
  assert.equal(reconcile.state, "ignored");
  const order = await t.run((ctx) => ctx.db.get(orderId));
  assert.equal(order.cjDispatchStatus, "reserved");
  assert.equal(order.cjOrderId, undefined);
});

test("provider intake and tracking handlers require the service identity", async () => {
  const t = convexTest({ schema, modules });
  const { orderId } = await seedApprovedDispatch(t);
  const order = await t.run((ctx) => ctx.db.get(orderId));
  await assert.rejects(() => t.mutation(api.orders.applyTracking, { cjOrderNumber: order.cjOrderNumber, status: "shipped" }), /UNAUTHENTICATED/);
  await assert.rejects(() => t.mutation(api.webhooks.recordCjTracking, { siteId: order.siteId, deliveryId: "d", topic: "ORDER", payloadHash: "h", cjOrderNumber: order.cjOrderNumber }), /UNAUTHENTICATED/);
});

test("approval resolution races close the same claimed intent without re-arming it", async () => {
  const t = convexTest({ schema, modules });
  const { siteId, orderId, actionId } = await seedApprovedDispatch(t);
  const now = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.patch(actionId, { status: "pending_approval", approvalDispatchKey: "approval:test", approvalDispatchStatus: "pending" });
    await ctx.db.insert("cjStagingIntents", { siteId, orderId, deliveryId: "approval-race", payloadHash: "approval-race", status: "staged", actionId, attempt: 1, leaseGeneration: 1, failureCount: 0, runnableAt: now, shipping, shopifyLines: lines, createdAt: now, updatedAt: now });
  });
  const intent = await t.run((ctx) => ctx.db.query("cjStagingIntents").withIndex("by_order", (q) => q.eq("orderId", orderId)).first());
  const claim = await service(t).mutation(api.orders.claimCjStagingApprovalDispatch, { intentId: intent._id });
  assert.equal(claim.state, "dispatch");
  // This models a human approval between the durable claim and beginApproval/retry.
  await t.run((ctx) => ctx.db.patch(actionId, { status: "approved", resolvedAt: Date.now() }));
  const closed = await service(t).mutation(api.orders.resolveCjStagingApproval, { intentId: intent._id, actionId, approvalDispatchKey: "approval:test", leaseGeneration: claim.leaseGeneration });
  assert.equal(closed.ignored, false);
  const terminal = await t.run((ctx) => ctx.db.get(intent._id));
  assert.equal(terminal.status, "approval_resolved");
  assert.equal(terminal.runnableAt, undefined);
  assert.equal(terminal.leaseExpiresAt, undefined);
  assert.equal((await service(t).mutation(api.orders.claimCjStagingApprovalDispatch, { intentId: intent._id })).state, "reused");
});
