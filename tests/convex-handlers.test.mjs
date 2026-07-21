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
  "../convex/ops.ts": () => import("../convex/ops.ts"),
  "../convex/products.ts": () => import("../convex/products.ts"),
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

async function claimDispatch(t, actionId, run = "run-1", token = "t".repeat(64)) {
  return service(t).mutation(api.orders.claimSandboxCjDispatch, { actionId, triggerRunId: run, leaseToken: token });
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

test("execution receipt requires service/run/token and rejects stale writers", async () => {
  const t = convexTest({ schema, modules });
  const { orderId, actionId } = await seedApprovedDispatch(t);
  await assert.rejects(() => t.mutation(api.orders.claimSandboxCjDispatch, { actionId, triggerRunId: "run-1", leaseToken: "t".repeat(64) }), /UNAUTHENTICATED/);
  const claim = await claimDispatch(t, actionId);
  assert.equal(claim.state, "prepared");
  assert.equal(claim.receipt.attempt, 1);
  await service(t).mutation(api.orders.beginSandboxCjProviderCall, { actionId, orderId, receipt: claim.receipt });
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

test("provider intake and tracking handlers require the service identity", async () => {
  const t = convexTest({ schema, modules });
  const { orderId } = await seedApprovedDispatch(t);
  const order = await t.run((ctx) => ctx.db.get(orderId));
  await assert.rejects(() => t.mutation(api.orders.applyTracking, { cjOrderNumber: order.cjOrderNumber, status: "shipped" }), /UNAUTHENTICATED/);
  await assert.rejects(() => t.mutation(api.webhooks.recordCjTracking, { siteId: order.siteId, deliveryId: "d", topic: "ORDER", payloadHash: "h", cjOrderNumber: order.cjOrderNumber }), /UNAUTHENTICATED/);
});

test("provider intake and runtime primitives reject anonymous and operator identities", async () => {
  const t = convexTest({ schema, modules });
  const { siteId, orderId, actionId } = await seedApprovedDispatch(t);
  const operator = t.withIdentity({ subject: "dropship-ai:operator" });
  const order = await t.run((ctx) => ctx.db.get(orderId));
  const calls = [
    () => operator.mutation(api.orders.upsertFromShopify, { siteId, orders: [] }),
    () => operator.mutation(api.products.upsertFromShopify, { siteId, products: [] }),
    () => operator.mutation(api.orders.record, { siteId, shopifyOrderId: "gid://shopify/Order/x", totalUsd: 1 }),
    () => operator.mutation(api.orders.applyTracking, { cjOrderNumber: order.cjOrderNumber, status: "shipped" }),
    () => operator.mutation(api.orders.claimSandboxCjDispatch, { actionId, triggerRunId: "run", leaseToken: "t".repeat(64) }),
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
  await service(t).mutation(api.orders.applyTracking, { cjOrderNumber: order.cjOrderNumber, trackingNumber: sentinel, trackingUrl: `https://example.test/${sentinel}`, status: "shipped" });
  const privateOrder = await t.run((ctx) => ctx.db.get(orderId));
  assert.match(JSON.stringify(privateOrder.cjOrderInput), new RegExp(sentinel));
  const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
  const outbox = await t.run((ctx) => ctx.db.query("outbox").collect());
  const traces = await t.run((ctx) => ctx.db.query("traces").collect());
  assert.equal(JSON.stringify({ audit, outbox, traces }).includes(sentinel), false);
  assert.equal(JSON.stringify(await service(t).mutation(api.orders.applyTracking, { cjOrderNumber: order.cjOrderNumber, status: "shipped" })).includes(sentinel), false);
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
