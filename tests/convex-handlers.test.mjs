import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { convexTest } from "convex-test";
import schemaModule from "../convex/schema.ts";
import apiModule from "../convex/_generated/api.js";
import { cjFreightQuoteDigest, cjOrderInputHash, cjStagingInputDigest, sandboxOrderNumber } from "../src/lib/cjOrder.ts";
import { cjStagingGenerationFingerprint } from "../src/lib/cjStagingState.ts";
import { executeSandboxCjDispatch } from "../src/lib/sandboxCjDispatchExecutor.ts";

const modules = {
  "../convex/orders.ts": () => import("../convex/orders.ts"),
  "../convex/webhooks.ts": () => import("../convex/webhooks.ts"),
  "../convex/actions.ts": () => import("../convex/actions.ts"),
  "../convex/ops.ts": () => import("../convex/ops.ts"),
  "../convex/products.ts": () => import("../convex/products.ts"),
  "../convex/audit.ts": () => import("../convex/audit.ts"),
  "../convex/creatives.ts": () => import("../convex/creatives.ts"),
  "../convex/posts.ts": () => import("../convex/posts.ts"),
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

async function claimDispatch(t, actionId, run = "run-1", token = "t".repeat(64)) {
  return service(t).mutation(api.orders.claimSandboxCjDispatch, { actionId, triggerRunId: run, leaseToken: token });
}

function convexExecutor(t, actionId, run, token, hooks = {}) {
  const call = (name, args) => service(t).mutation(api.orders[name], args);
  return {
    claim: async () => { const value = await claimDispatch(t, actionId, run, token); if (hooks.afterClaim) await hooks.afterClaim(value); return value; },
    beginProviderCall: async ({ orderId, receipt }) => { const value = await call("beginSandboxCjProviderCall", { actionId, orderId, receipt }); if (hooks.afterBegin) await hooks.afterBegin(value); return value; },
    beginReconciliation: async ({ orderId, receipt }) => { const value = await call("beginSandboxCjDispatchReconciliation", { actionId, orderId, receipt }); if (hooks.afterBeginReconciliation) await hooks.afterBeginReconciliation(value); return value; },
    findByOrderNumber: async () => null,
    reconcile: ({ orderId, receipt, lookup }) => call("reconcileSandboxCjDispatchExecution", { actionId, orderId, receipt, ...(lookup ? { lookup } : {}) }),
    createSandboxOrder: async () => { hooks.creates.count++; if (hooks.createError) throw hooks.createError; return { orderId: "cj-real-1" }; },
    complete: async ({ orderId, cjOrderId, receipt }) => { const value = await call("completeSandboxCjDispatchExecution", { actionId, orderId, cjOrderId, receipt }); if (hooks.afterComplete) await hooks.afterComplete(value); return value; },
    ambiguous: ({ orderId, reason, receipt }) => call("markSandboxCjDispatchAmbiguousExecution", { actionId, orderId, reason, receipt }),
    failBeforeProvider: ({ orderId, reason, receipt }) => call("failSandboxCjDispatchBeforeProvider", { actionId, orderId, reason, receipt }),
    rejectDefinitiveProviderRejection: ({ orderId, rejection, receipt }) => call("rejectSandboxCjDispatchAfterDefinitiveProviderRejection", { actionId, orderId, rejection, receipt }),
    definitiveProviderRejection: (error) => error === hooks.createError ? hooks.definitiveRejection ?? null : null,
  };
}

test("Convex handlers reject anonymous service calls and due index returns only oldest due rows", async () => {
  const t = convexTest({ schema, modules });
  await assert.rejects(() => t.query(api.orders.listDueCjStagingIntents, { limit: 25 }), /UNAUTHENTICATED/);
  const a = await seed(t, "pending", 1);
  const b = await seed(t, "pending", Date.now() + 60_000);
  await t.run(async (ctx) => {
    // Terminal state invariants clear the only runnable projection.
    await ctx.db.patch(b.intentId, { status: "needs_attention", runnableAt: undefined });
    await ctx.db.insert("cjStagingIntents", { siteId: a.siteId, orderId: a.orderId, deliveryId: "delivery-no-due", payloadHash: "hash-none", status: "pending", attempt: 0, shipping, shopifyLines: lines, createdAt: 1, updatedAt: 1 });
  });
  const due = await service(t).query(api.orders.listDueCjStagingIntents, { limit: 999 });
  assert.deepEqual(due.map((row) => row._id), [a.intentId]);
});

test("content approval has zero dispatch consequence; exact publication authorization fences one handoff", async () => {
  const t = convexTest({ schema, modules });
  const { siteId, creativeId } = await t.run(async (ctx) => {
    const siteId = await ctx.db.insert("sites", { name: "Content", niche: "test", status: "active", minKitPriceUsd: 40, minBlendedMarginPct: 70, distributionMode: "semi_manual", createdAt: 1 });
    const creativeId = await ctx.db.insert("creatives", { siteId, kind: "product_demo", r2Key: "creatives/content/final.mp4", aiGenerated: true, aiLabelRequired: true, labelBurned: true, status: "review", createdAt: 1 });
    return { siteId, creativeId };
  });
  const approved = await service(t).mutation(api.creatives.approve, { creativeId, approver: "test" });
  assert.equal(approved.publicationAuthorized, false);
  let dispatches = await t.run((ctx) => ctx.db.query("distributionDispatches").withIndex("by_creative", (q) => q.eq("creativeId", creativeId)).collect());
  assert.equal(dispatches.length, 0, "content approval must not enqueue or create distribution work");
  const authorization = await service(t).mutation(api.creatives.authorizePublication, {
    creativeId, expectedRevision: 1, caption: "Exact approved caption",
    destinations: [{ platform: "tiktok", targetAccount: "account-123" }], operator: "test",
  });
  dispatches = await t.run((ctx) => ctx.db.query("distributionDispatches").withIndex("by_creative", (q) => q.eq("creativeId", creativeId)).collect());
  assert.equal(dispatches.length, 1, "approval cannot lose or duplicate its durable distribution intent");
  assert.equal(dispatches[0].siteId, siteId);
  assert.equal(dispatches[0].caption, "Exact approved caption");
  await assert.rejects(() => service(t).mutation(api.creatives.authorizePublication, {
    creativeId, expectedRevision: 2, caption: "Exact approved caption",
    destinations: [{ platform: "tiktok", targetAccount: "account-123" }],
  }), /stale/);
  await assert.rejects(() => service(t).mutation(api.creatives.authorizePublication, {
    creativeId, expectedRevision: 1, caption: "Mismatched caption",
    destinations: [{ platform: "tiktok", targetAccount: "account-123" }],
  }), /different immutable input/);

  const [first, second] = await Promise.all([
    service(t).mutation(api.posts.beginDistributionDispatch, { creativeId, dispatchKey: authorization.dispatchKey }),
    service(t).mutation(api.posts.beginDistributionDispatch, { creativeId, dispatchKey: authorization.dispatchKey }),
  ]);
  assert.deepEqual([first.status, second.status].sort(), ["busy", "dispatching"], "only one concurrent caller may submit Trigger work");
});

test("Convex receipt handler links order and intent atomically, including repaired legacy duplicate receipts", async () => {
  const t = convexTest({ schema, modules });
  const args = { deliveryId: "delivery-a", topic: "orders/create", payloadHash: "hash-a", shopifyOrderId: "gid://shopify/Order/1", currencyCode: "USD", currentTotal: 50, financialStatus: "PAID", test: false, cancelled: false, creditAdjustmentState: "none", fulfillmentStatus: "received", createdAt: 1, stagingInput: { shipping, shopifyLines: lines } };
  const siteId = await t.run((ctx) => ctx.db.insert("sites", { name: "Test", niche: "test", status: "active", storeCurrency: "USD", minKitPriceUsd: 40, minBlendedMarginPct: 70, distributionMode: "semi_manual", createdAt: 1 }));
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

test("CJ staging transaction rejects a global webhook-route collision before any action is created", async () => {
  const t = convexTest({ schema, modules });
  const now = Date.now();
  const seeded = await t.run(async (ctx) => {
    const siteId = await ctx.db.insert("sites", { name: "Route", niche: "test", status: "active", storeCurrency: "USD", minKitPriceUsd: 40, minBlendedMarginPct: 70, distributionMode: "semi_manual", createdAt: now });
    const otherSiteId = await ctx.db.insert("sites", { name: "Collision", niche: "test", status: "active", storeCurrency: "USD", minKitPriceUsd: 40, minBlendedMarginPct: 70, distributionMode: "semi_manual", createdAt: now });
    const shopifyOrderId = "gid://shopify/Order/collision-test";
    const orderId = await ctx.db.insert("orders", { siteId, shopifyOrderId, currencyCode: "USD", currentTotal: 50, financialStatus: "PAID", test: false, cancelled: false, creditAdjustmentState: "none", fulfillmentStatus: "received", createdAt: now });
    const route = sandboxOrderNumber(String(siteId), shopifyOrderId);
    await ctx.db.insert("orders", { siteId: otherSiteId, shopifyOrderId: "gid://shopify/Order/other", cjOrderNumber: route, fulfillmentStatus: "received", createdAt: now });
    const evidenceId = await ctx.db.insert("cjEvidence", { siteId, cjProductId: "cj-product", cjVariantId: "cj-variant", title: "Verified", cogsUsd: 10, shippingUsd: 5, inventoryQty: 5, fromUsWarehouse: true, fromCountryCode: "US", inventoryVerified: true, sourceUrl: "https://cjdropshipping.com/product", traceId: "trace", readAt: now });
    await ctx.db.insert("products", { siteId, title: "Verified", shopifyProductId: lines[0].productId, shopifyVariantId: lines[0].variantId, shopifyDraftImportStatus: "created", cjProductId: "cj-product", cjVariantId: "cj-variant", cjFromCountryCode: "US", cjEvidenceId: evidenceId, cjFromUsWarehouse: true, cogsUsd: 10, shippingUsd: 5, priceUsd: 50, status: "draft", createdAt: now });
    const quoteInputDigest = cjFreightQuoteDigest({ siteId: String(siteId), shopifyOrderId, fromCountryCode: "US", destinationCountryCode: "US", shippingZip: shipping.shippingZip, products: [{ vid: "cj-variant", quantity: 1 }], providerEndpoint: "/logistic/freightCalculate", providerVersion: "CJ API v2" });
    const intentId = await ctx.db.insert("cjStagingIntents", { siteId, orderId, deliveryId: "route-collision", payloadHash: "hash", status: "quoted", attempt: 1, failureCount: 0, runnableAt: now, shipping, shopifyLines: lines, stagingInputDigest: cjStagingInputDigest({ shipping, shopifyLines: lines }), quoteInputDigest, quoteProvider: { endpoint: "/logistic/freightCalculate", version: "CJ API v2" }, quote: { logisticName: "USPS", logisticPriceUsd: 5, fromCountryCode: "US", quotedAt: now }, createdAt: now, updatedAt: now });
    return { orderId, intentId };
  });
  await assert.rejects(() => service(t).mutation(api.orders.stageQuotedCjStagingIntent, { intentId: seeded.intentId }), /identity collision/);
  assert.equal((await t.run((ctx) => ctx.db.get(seeded.orderId))).cjOrderNumber, undefined);
  assert.equal((await t.run((ctx) => ctx.db.query("actions").collect())).length, 0);
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

test("execution receipt requires service/run/token and rejects stale writers", async () => {
  const t = convexTest({ schema, modules });
  const { orderId, actionId } = await seedApprovedDispatch(t);
  await assert.rejects(() => t.mutation(api.orders.claimSandboxCjDispatch, { actionId, triggerRunId: "run-1", leaseToken: "t".repeat(64) }), /UNAUTHENTICATED/);
  const claim = await claimDispatch(t, actionId);
  assert.equal(claim.state, "prepared");
  assert.equal(claim.receipt.attempt, 1);
  await assert.rejects(() => t.mutation(api.orders.beginSandboxCjDispatchReconciliation, { actionId, orderId, receipt: claim.receipt }), /UNAUTHENTICATED/);
  await service(t).mutation(api.orders.beginSandboxCjProviderCall, { actionId, orderId, receipt: claim.receipt });
  await assert.rejects(
    () => service(t).mutation(api.orders.rejectSandboxCjDispatchAfterDefinitiveProviderRejection, { actionId, orderId, receipt: claim.receipt, rejection: "provider_timeout" }),
    /Validator error/,
  );
  const stale = { ...claim.receipt, leaseVersion: 2 };
  const complete = await service(t).mutation(api.orders.completeSandboxCjDispatchExecution, { actionId, orderId, cjOrderId: "cj-old", receipt: stale });
  const ambiguous = await service(t).mutation(api.orders.markSandboxCjDispatchAmbiguousExecution, { actionId, orderId, reason: "lost", receipt: stale });
  const reconcile = await service(t).mutation(api.orders.reconcileSandboxCjDispatchExecution, { actionId, orderId, receipt: stale });
  assert.equal(complete.ignored, true);
  assert.equal(ambiguous.ignored, true);
  assert.equal(reconcile.state, "ignored");
  const order = await t.run((ctx) => ctx.db.get(orderId));
  assert.equal(order.cjDispatchStatus, "reserved");
  assert.equal(order.cjOrderId, undefined);
});

test("CJ completion and replay atomically converge the exact outbox and trace", async () => {
  const t = convexTest({ schema, modules });
  const { orderId, actionId } = await seedApprovedDispatch(t);
  const claim = await claimDispatch(t, actionId);
  await service(t).mutation(api.orders.beginSandboxCjProviderCall, { actionId, orderId, receipt: claim.receipt });
  await service(t).mutation(api.orders.completeSandboxCjDispatchExecution, { actionId, orderId, cjOrderId: "cj-1", receipt: claim.receipt });
  let order = await t.run((ctx) => ctx.db.get(orderId));
  let action = await t.run((ctx) => ctx.db.get(actionId));
  const execution = await t.run((ctx) => ctx.db.get(claim.receipt.executionId));
  let outbox = await t.run((ctx) => ctx.db.get(execution.outboxId));
  let trace = await t.run((ctx) => ctx.db.query("traces").withIndex("by_trace_id", (q) => q.eq("traceId", outbox.traceId)).first());
  assert.equal(order.cjDispatchStatus, "sent");
  assert.equal(action.status, "executed");
  assert.equal(outbox.status, "delivered");
  assert.equal(trace.status, "succeeded");
  // A committed terminal response can be replayed with the same immutable receipt.
  assert.equal((await service(t).mutation(api.orders.completeSandboxCjDispatchExecution, { actionId, orderId, cjOrderId: "cj-1", receipt: claim.receipt })).reused, true);
});

test("lost prepare replay is exact; a pre-provider failure creates a newer execution", async () => {
  const t = convexTest({ schema, modules });
  const { orderId, actionId } = await seedApprovedDispatch(t);
  const claim = await claimDispatch(t, actionId);
  const replay = await claimDispatch(t, actionId);
  assert.equal(replay.receipt.executionId, claim.receipt.executionId);
  assert.equal(replay.receipt.leaseVersion, claim.receipt.leaseVersion);
  assert.deepEqual(await service(t).mutation(api.orders.failSandboxCjDispatchBeforeProvider, { actionId, orderId, reason: "outbox_processing_failed", receipt: claim.receipt }), { ignored: false });
  const order = await t.run((ctx) => ctx.db.get(orderId));
  const execution = await t.run((ctx) => ctx.db.get(claim.receipt.executionId));
  const outbox = await t.run((ctx) => ctx.db.get(execution.outboxId));
  assert.equal(order.cjDispatchStatus, "staged");
  assert.equal(outbox.status, "failed");
  const retry = await claimDispatch(t, actionId, "run-2", "u".repeat(64));
  assert.equal(retry.state, "prepared");
  assert.equal(retry.receipt.attempt, 2);
});

test("a typed provider rejection permits exactly one new fenced attempt; ambiguity never does", async () => {
  const t = convexTest({ schema, modules });
  const { orderId, actionId } = await seedApprovedDispatch(t);
  const creates = { count: 0 };
  const rejected = new Error("typed provider rejection");
  await assert.rejects(
    () => executeSandboxCjDispatch(convexExecutor(t, actionId, "run-1", "r".repeat(64), { creates, createError: rejected, definitiveRejection: "invalid_order" })),
    /typed provider rejection/,
  );
  const first = await t.run((ctx) => ctx.db.query("cjDispatchExecutions").withIndex("by_order", (q) => q.eq("orderId", orderId)).first());
  assert.equal(first.phase, "pre_provider_failed");
  assert.equal((await t.run((ctx) => ctx.db.get(orderId))).cjDispatchStatus, "staged");
  await executeSandboxCjDispatch(convexExecutor(t, actionId, "run-2", "s".repeat(64), { creates }));
  assert.equal(creates.count, 2, "the rejected write and only its new fenced attempt reached the adapter");
  const executions = await t.run((ctx) => ctx.db.query("cjDispatchExecutions").withIndex("by_order", (q) => q.eq("orderId", orderId)).collect());
  assert.equal(executions.length, 2);
  assert.equal(executions.filter((execution) => execution.phase === "sent").length, 1);

  const ambiguousTest = convexTest({ schema, modules });
  const ambiguousSeed = await seedApprovedDispatch(ambiguousTest);
  const ambiguousCreates = { count: 0 };
  const unknown = new Error("unknown provider outcome");
  await assert.rejects(
    () => executeSandboxCjDispatch(convexExecutor(ambiguousTest, ambiguousSeed.actionId, "run-a", "a".repeat(64), { creates: ambiguousCreates, createError: unknown })),
    /unknown provider outcome/,
  );
  const ambiguousExecution = await ambiguousTest.run((ctx) => ctx.db.query("cjDispatchExecutions").withIndex("by_order", (q) => q.eq("orderId", ambiguousSeed.orderId)).first());
  assert.equal(ambiguousExecution.phase, "reconciliation_required");
  await executeSandboxCjDispatch(convexExecutor(ambiguousTest, ambiguousSeed.actionId, "run-a", "a".repeat(64), { creates: ambiguousCreates }));
  await ambiguousTest.run((ctx) => ctx.db.patch(ambiguousExecution._id, { leaseExpiresAt: Date.now() - 1, nextReconcileAt: Date.now() - 1 }));
  await executeSandboxCjDispatch(convexExecutor(ambiguousTest, ambiguousSeed.actionId, "run-b", "b".repeat(64), { creates: ambiguousCreates }));
  assert.equal(ambiguousCreates.count, 1, "unknown provider outcomes remain read-only even after a lease transfer");
});

test("actual executor and Convex handlers survive commit-then-response-loss without a second provider create", async () => {
  const t = convexTest({ schema, modules });
  const { orderId, actionId } = await seedApprovedDispatch(t);
  const creates = { count: 0 };
  let lost = true;
  await assert.rejects(() => executeSandboxCjDispatch(convexExecutor(t, actionId, "trigger-run", "z".repeat(64), { creates, afterClaim: async () => { if (lost) { lost = false; throw new Error("claim response lost after commit"); } } })), /response lost/);
  assert.equal(creates.count, 0);
  await executeSandboxCjDispatch(convexExecutor(t, actionId, "trigger-run", "z".repeat(64), { creates }));
  assert.equal(creates.count, 1);
  const order = await t.run((ctx) => ctx.db.get(orderId));
  const execution = await t.run((ctx) => ctx.db.query("cjDispatchExecutions").withIndex("by_order", (q) => q.eq("orderId", orderId)).first());
  const outbox = await t.run((ctx) => ctx.db.get(execution.outboxId));
  const trace = await t.run((ctx) => ctx.db.query("traces").withIndex("by_trace_id", (q) => q.eq("traceId", execution.traceId)).first());
  assert.equal(order.cjOrderId, "cj-real-1");
  assert.equal(execution.phase, "sent");
  assert.equal(outbox.status, "delivered");
  assert.equal(trace.status, "succeeded");
});

test("actual executor response-loss matrix never crosses CJ twice and terminal attention cannot re-arm", async () => {
  for (const phase of ["begin", "complete", "ambiguous"]) {
    const t = convexTest({ schema, modules });
    const { orderId, actionId } = await seedApprovedDispatch(t);
    const creates = { count: 0 };
    let lost = true;
    const hooks = phase === "begin"
      ? { creates, afterBegin: async () => { if (lost) { lost = false; throw new Error("begin response lost after commit"); } } }
      : phase === "complete"
        ? { creates, afterComplete: async () => { if (lost) { lost = false; throw new Error("complete response lost after commit"); } } }
        : { creates, afterBegin: async () => { if (lost) { lost = false; throw new Error("provider timeout after begin"); } } };
    if (phase === "complete") {
      await executeSandboxCjDispatch(convexExecutor(t, actionId, "run-1", "q".repeat(64), hooks));
    } else {
      await assert.rejects(() => executeSandboxCjDispatch(convexExecutor(t, actionId, "run-1", "q".repeat(64), hooks)), /response lost|timeout/);
    }
    const execution = await t.run((ctx) => ctx.db.query("cjDispatchExecutions").withIndex("by_order", (q) => q.eq("orderId", orderId)).first());
    if (phase === "ambiguous") {
      await service(t).mutation(api.orders.markSandboxCjDispatchAmbiguousExecution, { actionId, orderId, reason: "response_lost", receipt: { executionId: execution._id, actionId, orderId, inputHash: execution.inputHash, generation: execution.generation, generationFingerprint: execution.generationFingerprint, attempt: execution.attempt, triggerRunId: execution.triggerRunId, leaseToken: execution.leaseToken, leaseVersion: execution.leaseVersion, providerMode: "sandbox", providerIdentity: execution.providerIdentity } });
    }
    await executeSandboxCjDispatch(convexExecutor(t, actionId, "run-1", "q".repeat(64), { creates }));
    assert.equal(creates.count, phase === "complete" ? 1 : 0, `${phase} response loss must not create twice`);
  }

  const t = convexTest({ schema, modules });
  const { actionId, orderId } = await seedApprovedDispatch(t);
  const claim = await claimDispatch(t, actionId);
  await service(t).mutation(api.orders.beginSandboxCjProviderCall, { actionId, orderId, receipt: claim.receipt });
  await service(t).mutation(api.orders.markSandboxCjDispatchAmbiguousExecution, { actionId, orderId, reason: "timeout", receipt: claim.receipt });
  await t.run((ctx) => ctx.db.patch(claim.receipt.executionId, { reconciliationCount: 5, reconciliationMax: 5, phase: "needs_attention", nextReconcileAt: undefined }));
  assert.equal((await claimDispatch(t, actionId, "new-run", "n".repeat(64))).state, "blocked");
  assert.equal((await t.run((ctx) => ctx.db.query("cjDispatchExecutions").withIndex("by_order", (q) => q.eq("orderId", orderId)).collect())).length, 1);
});

test("reconciliation due fence rejects provider lookup before a durable lease is ready", async () => {
  const t = convexTest({ schema, modules });
  const { orderId, actionId } = await seedApprovedDispatch(t);
  const claim = await claimDispatch(t, actionId);
  await service(t).mutation(api.orders.beginSandboxCjProviderCall, { actionId, orderId, receipt: claim.receipt });
  await service(t).mutation(api.orders.markSandboxCjDispatchAmbiguousExecution, { actionId, orderId, reason: "timeout", receipt: claim.receipt });
  await t.run((ctx) => ctx.db.patch(claim.receipt.executionId, { nextReconcileAt: Date.now() + 60_000 }));
  let lookups = 0;
  const result = await executeSandboxCjDispatch({
    ...convexExecutor(t, actionId, "run-1", "t".repeat(64), { creates: { count: 0 } }),
    findByOrderNumber: async () => { lookups++; return null; },
  });
  assert.equal(result.reason, "reconciliation_not_due");
  assert.equal(lookups, 0);
});

test("a live provider lease cannot be stolen; expiry transfers only a reconciliation receipt and fences the old run", async () => {
  const t = convexTest({ schema, modules });
  const { orderId, actionId } = await seedApprovedDispatch(t);
  const first = await claimDispatch(t, actionId, "old-run", "o".repeat(64));
  await service(t).mutation(api.orders.beginSandboxCjProviderCall, { actionId, orderId, receipt: first.receipt });
  assert.equal((await claimDispatch(t, actionId, "new-run", "n".repeat(64))).state, "blocked");
  await t.run((ctx) => ctx.db.patch(first.receipt.executionId, { leaseExpiresAt: Date.now() - 1 }));
  const transferred = await claimDispatch(t, actionId, "new-run", "n".repeat(64));
  assert.equal(transferred.state, "reconcile_required");
  assert.equal(transferred.receipt.leaseVersion, first.receipt.leaseVersion + 1);
  assert.equal((await service(t).mutation(api.orders.completeSandboxCjDispatchExecution, { actionId, orderId, cjOrderId: "stale-cj", receipt: first.receipt })).ignored, true);
});

test("read-only reconciliation backs off five times then reaches one terminal attention state", async () => {
  const t = convexTest({ schema, modules });
  const { orderId, actionId } = await seedApprovedDispatch(t);
  const claim = await claimDispatch(t, actionId);
  await service(t).mutation(api.orders.beginSandboxCjProviderCall, { actionId, orderId, receipt: claim.receipt });
  await service(t).mutation(api.orders.markSandboxCjDispatchAmbiguousExecution, { actionId, orderId, reason: "timeout", receipt: claim.receipt });
  let last;
  for (let count = 1; count <= 5; count++) {
    last = await service(t).mutation(api.orders.reconcileSandboxCjDispatchExecution, { actionId, orderId, receipt: claim.receipt });
    if (count < 5) {
      assert.equal(last.state, "scheduled");
      const execution = await t.run((ctx) => ctx.db.get(claim.receipt.executionId));
      assert.equal(execution.reconciliationCount, count);
      assert.equal(execution.nextReconcileAt > Date.now(), true);
      // Advance only durable due time; the handler rejects an early/manual hot-loop.
      assert.equal((await service(t).mutation(api.orders.reconcileSandboxCjDispatchExecution, { actionId, orderId, receipt: claim.receipt })).state, "ignored");
      await t.run((ctx) => ctx.db.patch(execution._id, { nextReconcileAt: Date.now() - 1 }));
    }
  }
  assert.equal(last.state, "needs_attention");
  const execution = await t.run((ctx) => ctx.db.get(claim.receipt.executionId));
  const order = await t.run((ctx) => ctx.db.get(orderId));
  assert.equal(execution.phase, "needs_attention");
  assert.equal(execution.nextReconcileAt, undefined);
  assert.equal(order.cjDispatchStatus, "ambiguous");
});

test("reconciliation keeps one active trace/outbox lineage, and a lost schedule handoff is durably reclaimable", async () => {
  const t = convexTest({ schema, modules });
  const { orderId, actionId } = await seedApprovedDispatch(t);
  const claim = await claimDispatch(t, actionId, "run-a", "a".repeat(64));
  await service(t).mutation(api.orders.beginSandboxCjProviderCall, { actionId, orderId, receipt: claim.receipt });
  await service(t).mutation(api.orders.markSandboxCjDispatchAmbiguousExecution, { actionId, orderId, reason: "timeout", receipt: claim.receipt });
  let execution = await t.run((ctx) => ctx.db.get(claim.receipt.executionId));
  let outbox = await t.run((ctx) => ctx.db.get(execution.outboxId));
  let trace = await t.run((ctx) => ctx.db.query("traces").withIndex("by_trace_id", (q) => q.eq("traceId", execution.traceId)).first());
  assert.equal(execution.phase, "reconciliation_required");
  assert.equal(outbox.status, "ambiguous");
  assert.equal(trace.status, "reconciling");
  assert.equal(trace.finishedAt, undefined);
  const due = await service(t).query(api.orders.listDueSandboxCjDispatchReconciliations, { limit: 25 });
  assert.deepEqual(due, [{ executionId: execution._id }]);
  assert.deepEqual(Object.keys(due[0]), ["executionId"]);
  const [first, second] = await Promise.all([
    service(t).mutation(api.orders.claimDueSandboxCjDispatchReconciliationSchedule, { executionId: execution._id }),
    service(t).mutation(api.orders.claimDueSandboxCjDispatchReconciliationSchedule, { executionId: execution._id }),
  ]);
  assert.deepEqual([first.state, second.state].sort(), ["busy", "scheduled"]);
  execution = await t.run((ctx) => ctx.db.get(execution._id));
  await t.run((ctx) => ctx.db.patch(execution._id, { reconciliationScheduleLeaseExpiresAt: Date.now() - 1 }));
  const recovered = await service(t).mutation(api.orders.claimDueSandboxCjDispatchReconciliationSchedule, { executionId: execution._id });
  assert.equal(recovered.state, "scheduled");
  assert.equal(recovered.generation, 2);
  // The recovered task must still be reconciliation-only; no create crosses the boundary.
  const creates = { count: 0 };
  await executeSandboxCjDispatch(convexExecutor(t, actionId, "run-b", "b".repeat(64), { creates }));
  assert.equal(creates.count, 0);
  execution = await t.run((ctx) => ctx.db.get(execution._id));
  outbox = await t.run((ctx) => ctx.db.get(execution.outboxId));
  trace = await t.run((ctx) => ctx.db.query("traces").withIndex("by_trace_id", (q) => q.eq("traceId", execution.traceId)).first());
  assert.equal(outbox._id, execution.outboxId);
  assert.equal(trace.finishedAt, undefined);
});

test("due reconciliation projection is bounded and cannot expose order, provider, or lease data", async () => {
  const t = convexTest({ schema, modules });
  const { orderId, actionId } = await seedApprovedDispatch(t);
  const claim = await claimDispatch(t, actionId);
  await service(t).mutation(api.orders.beginSandboxCjProviderCall, { actionId, orderId, receipt: claim.receipt });
  await service(t).mutation(api.orders.markSandboxCjDispatchAmbiguousExecution, { actionId, orderId, reason: "timeout", receipt: claim.receipt });
  const sentinel = "PII-CAPABILITY-ORDER-SENTINEL";
  await t.run(async (ctx) => {
    const execution = await ctx.db.get(claim.receipt.executionId);
    await ctx.db.patch(execution._id, { orderNumber: sentinel, providerIdentity: sentinel, leaseToken: sentinel, inputHash: sentinel });
    const { _id, _creationTime, ...base } = execution;
    for (let index = 0; index < 100; index++) {
      await ctx.db.insert("cjDispatchExecutions", {
        ...base,
        attempt: index + 2,
        triggerRunId: `due-projection-${index}`,
        leaseToken: `${sentinel}-${index}`,
        idempotencyKey: `${base.idempotencyKey}:${index}`,
        traceId: `${base.traceId}:${index}`,
        createdAt: Date.now() + index,
        updatedAt: Date.now() + index,
      });
    }
  });
  const due = await service(t).query(api.orders.listDueSandboxCjDispatchReconciliations, { limit: 999 });
  assert.equal(due.length, 100, "the indexed due scan stays bounded even when the caller asks for more");
  assert.equal(due.every((row) => Object.keys(row).length === 1 && typeof row.executionId === "string"), true);
  assert.equal(JSON.stringify(due).includes(sentinel), false);
});

test("the scheduling handoff returns its authoritative due time, not a stale reconciliation value", async () => {
  const t = convexTest({ schema, modules });
  const { orderId, actionId } = await seedApprovedDispatch(t);
  const claim = await claimDispatch(t, actionId);
  await service(t).mutation(api.orders.beginSandboxCjProviderCall, { actionId, orderId, receipt: claim.receipt });
  await service(t).mutation(api.orders.markSandboxCjDispatchAmbiguousExecution, { actionId, orderId, reason: "timeout", receipt: claim.receipt });
  const scheduled = await service(t).mutation(api.orders.reconcileSandboxCjDispatchExecution, { actionId, orderId, receipt: claim.receipt });
  assert.equal(scheduled.state, "scheduled");
  const changedDueAt = Date.now() - 1;
  await t.run((ctx) => ctx.db.patch(claim.receipt.executionId, { nextReconcileAt: changedDueAt }));
  const handoff = await service(t).mutation(api.orders.claimSandboxCjDispatchReconciliationSchedule, { actionId, orderId, receipt: claim.receipt });
  assert.equal(handoff.state, "scheduled");
  assert.equal(handoff.nextReconcileAt, changedDueAt);
  assert.notEqual(handoff.nextReconcileAt, scheduled.nextReconcileAt);
  const triggerSource = await fs.readFile(new URL("../src/trigger/fulfillment.ts", import.meta.url), "utf8");
  assert.match(triggerSource, /handoff\.nextReconcileAt - Date\.now\(\)/);
});

test("legacy CJ dispatch mutation shapes are absent and the order pointer controls a large historical set", async () => {
  const source = await fs.readFile(new URL("../convex/orders.ts", import.meta.url), "utf8");
  for (const name of ["markSandboxCjDispatched", "markSandboxCjAmbiguous", "abortSandboxCjDispatchBeforeProvider", "repairSandboxCjDispatchOutbox", "reconcileSandboxCjDispatch ="]) assert.equal(source.includes(name), false);
  const t = convexTest({ schema, modules });
  const { orderId, actionId } = await seedApprovedDispatch(t);
  const claim = await claimDispatch(t, actionId);
  const execution = await t.run((ctx) => ctx.db.get(claim.receipt.executionId));
  const { _id, _creationTime, ...historicalBase } = execution;
  await t.run(async (ctx) => {
    for (let n = 0; n < 40; n++) await ctx.db.insert("cjDispatchExecutions", { ...historicalBase, triggerRunId: `historical-${n}`, leaseToken: `h${n}`.padEnd(64, "x"), phase: "pre_provider_failed", attempt: n + 100, reconciliationScheduleGeneration: 0, createdAt: n, updatedAt: n });
  });
  const order = await t.run((ctx) => ctx.db.get(orderId));
  assert.equal(order.cjDispatchExecutionId, execution._id);
  assert.equal((await claimDispatch(t, actionId, "new-run", "n".repeat(64))).state, "blocked");
});

test("provider intake and tracking handlers require the service identity", async () => {
  const t = convexTest({ schema, modules });
  const { orderId } = await seedApprovedDispatch(t);
  const order = await t.run((ctx) => ctx.db.get(orderId));
  await assert.rejects(() => t.mutation(api.orders.applyTracking, { siteId: order.siteId, cjOrderNumber: order.cjOrderNumber, status: "shipped" }), /UNAUTHENTICATED/);
  await assert.rejects(() => t.mutation(api.webhooks.recordCjTracking, { deliveryId: "d", topic: "ORDER", payloadHash: "h", cjOrderNumber: order.cjOrderNumber }), /UNAUTHENTICATED/);
});

test("provider intake and runtime primitives reject anonymous and operator identities", async () => {
  const t = convexTest({ schema, modules });
  const { siteId, orderId, actionId } = await seedApprovedDispatch(t);
  const operator = t.withIdentity({ subject: "dropship-ai:operator" });
  const order = await t.run((ctx) => ctx.db.get(orderId));
  const claim = await claimDispatch(t, actionId);
  const calls = [
    () => operator.mutation(api.orders.upsertFromShopify, { siteId, orders: [] }),
    () => operator.mutation(api.products.upsertFromShopify, { siteId, products: [] }),
    () => operator.mutation(api.orders.record, { siteId, shopifyOrderId: "gid://shopify/Order/x", totalUsd: 1 }),
    () => operator.mutation(api.orders.applyTracking, { siteId, cjOrderNumber: order.cjOrderNumber, status: "shipped" }),
    () => operator.mutation(api.orders.claimSandboxCjDispatch, { actionId, triggerRunId: "run", leaseToken: "t".repeat(64) }),
    () => operator.mutation(api.orders.beginSandboxCjDispatchReconciliation, { actionId, orderId, receipt: claim.receipt }),
    () => operator.mutation(api.orders.rejectSandboxCjDispatchAfterDefinitiveProviderRejection, { actionId, orderId, receipt: claim.receipt, rejection: "invalid_order" }),
    () => operator.query(api.orders.listDueSandboxCjDispatchReconciliations, { limit: 1 }),
    () => operator.mutation(api.orders.claimDueSandboxCjDispatchReconciliationSchedule, { executionId: claim.receipt.executionId }),
    () => operator.mutation(api.orders.claimSandboxCjDispatchReconciliationSchedule, { actionId, orderId, receipt: claim.receipt }),
    () => operator.mutation(api.ops.enqueue, { siteId, kind: "test", target: "target", idempotencyKey: "key", traceId: "trace", payload: {} }),
    () => operator.mutation(api.ops.claimTarget, { target: "target", owner: "owner" }),
  ];
  for (const call of calls) await assert.rejects(call, /UNAUTHENTICATED/);
  const queued = await service(t).mutation(api.ops.enqueue, { siteId, kind: "test", target: "target", idempotencyKey: "key", traceId: "trace", payload: {} });
  await assert.rejects(() => service(t).mutation(api.ops.enqueue, { siteId, kind: "test", target: "different-target", idempotencyKey: "key", traceId: "trace", payload: {} }), /different immutable input/);
  await assert.rejects(() => operator.mutation(api.ops.markOutbox, { outboxId: queued.outboxId, status: "failed" }), /UNAUTHENTICATED/);
  await assert.rejects(() => operator.mutation(api.ops.releaseTarget, { target: "target", owner: "owner" }), /UNAUTHENTICATED/);
  assert.equal((await service(t).mutation(api.ops.claimTarget, { target: "target", owner: "owner" })).acquired, true);
});

test("atomic prepare fences competing Trigger runs before either can reach CJ", async () => {
  const t = convexTest({ schema, modules });
  const { actionId, orderId } = await seedApprovedDispatch(t);
  const [first, second] = await Promise.all([
    claimDispatch(t, actionId, "run-a", "a".repeat(64)),
    claimDispatch(t, actionId, "run-b", "b".repeat(64)),
  ]);
  assert.deepEqual([first.state, second.state].sort(), ["blocked", "prepared"]);
  const order = await t.run((ctx) => ctx.db.get(orderId));
  assert.equal(order.cjDispatchAttempt, 1);
  const executions = await t.run((ctx) => ctx.db.query("cjDispatchExecutions").withIndex("by_order", (q) => q.eq("orderId", orderId)).collect());
  assert.equal(executions.length, 1);
});

test("tracking and audit boundaries never copy sentinel customer or tracking values", async () => {
  const t = convexTest({ schema, modules });
  const { siteId, orderId } = await seedApprovedDispatch(t);
  const order = await t.run((ctx) => ctx.db.get(orderId));
  const sentinel = "PII-SENTINEL-DO-NOT-LEAK";
  await t.run((ctx) => ctx.db.patch(orderId, {
    cjOrderInput: { ...order.cjOrderInput, shippingAddress: sentinel, shippingCustomerName: sentinel, shippingPhone: sentinel, shippingZip: sentinel },
  }));
  await service(t).mutation(api.orders.applyTracking, { siteId, cjOrderNumber: order.cjOrderNumber, trackingNumber: sentinel, trackingUrl: `https://example.test/${sentinel}`, status: "shipped" });
  const privateOrder = await t.run((ctx) => ctx.db.get(orderId));
  assert.match(JSON.stringify(privateOrder.cjOrderInput), new RegExp(sentinel));
  const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
  const outbox = await t.run((ctx) => ctx.db.query("outbox").collect());
  const traces = await t.run((ctx) => ctx.db.query("traces").collect());
  assert.equal(JSON.stringify({ audit, outbox, traces }).includes(sentinel), false);
  assert.equal(JSON.stringify(await service(t).mutation(api.orders.applyTracking, { siteId, cjOrderNumber: order.cjOrderNumber, status: "shipped" })).includes(sentinel), false);
  assert.equal(siteId !== undefined, true);
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
