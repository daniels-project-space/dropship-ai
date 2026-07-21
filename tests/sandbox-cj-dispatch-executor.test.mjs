import assert from "node:assert/strict";
import test from "node:test";
import { executeSandboxCjDispatch } from "../src/lib/sandboxCjDispatchExecutor.ts";

const receipt = { executionId: "execution-1", actionId: "action-1", orderId: "order-1", inputHash: "hash-1", generation: 1, generationFingerprint: "f".repeat(64), attempt: 1, triggerRunId: "run-1", leaseToken: "t".repeat(64), leaseVersion: 1, providerMode: "sandbox", providerIdentity: "dsa-sb-1" };
const prepared = { state: "prepared", siteId: "site-1", orderId: "order-1", orderNumber: "dsa-sb-1", receipt, cjInput: { logisticName: "Quoted Route", fromCountryCode: "US" } };

function harness(claims = [prepared], overrides = {}) {
  const calls = [];
  return { calls, deps: {
    claim: async () => { calls.push("claim"); return claims.shift() ?? prepared; },
    beginProviderCall: async (input) => { calls.push(["begin", input]); return {}; },
    beginReconciliation: async (input) => { calls.push(["begin-reconciliation", input]); return { ready: true }; },
    findByOrderNumber: async (orderNumber) => { calls.push(["find", orderNumber]); return null; },
    reconcile: async (input) => { calls.push(["reconcile", input]); return { state: "scheduled", nextReconcileAt: 123 }; },
    createSandboxOrder: async (input) => { calls.push(["create", input]); return { orderId: "cj-1" }; },
    complete: async (input) => { calls.push(["complete", input]); return {}; },
    ambiguous: async (input) => { calls.push(["ambiguous", input]); return {}; },
    failBeforeProvider: async (input) => { calls.push(["failed", input]); return {}; },
    scheduleReconciliation: async (input) => { calls.push(["schedule", input]); },
    isAmbiguousWriteError: () => true,
    ...overrides,
  }};
}

test("executor enters the fenced provider phase before its one CJ create", async () => {
  const run = harness();
  await executeSandboxCjDispatch(run.deps);
  assert.deepEqual(run.calls.map((x) => Array.isArray(x) ? x[0] : x), ["claim", "begin", "create", "complete"]);
  assert.equal(run.calls.filter((x) => Array.isArray(x) && x[0] === "create").length, 1);
});

test("lost claim and begin responses replay read-only rather than create", async () => {
  const replay = harness([{ state: "reconcile_required", siteId: "site-1", orderId: "order-1", orderNumber: "dsa-sb-1", receipt }], {
    findByOrderNumber: async () => ({ orderId: "cj-1", orderNumber: "dsa-sb-1", isSandbox: 1 }),
    reconcile: async (input) => { replay.calls.push(["reconcile", input]); return { state: "found" }; },
  });
  const result = await executeSandboxCjDispatch(replay.deps);
  assert.deepEqual(result, { reconciled: "found", orderId: "order-1", orderNumber: "dsa-sb-1" });
  assert.equal(replay.calls.some((x) => Array.isArray(x) && x[0] === "create"), false);
  assert.equal(replay.calls.find((x) => Array.isArray(x) && x[0] === "begin-reconciliation") !== undefined, true);
  assert.deepEqual(replay.calls.find((x) => Array.isArray(x) && x[0] === "reconcile")[1].lookup, { orderId: "cj-1", orderNumber: "dsa-sb-1", isSandbox: 1 });
});

test("absent reconciliation is bounded by Convex and schedules no provider create", async () => {
  const run = harness([{ state: "reconcile_required", siteId: "site-1", orderId: "order-1", orderNumber: "dsa-sb-1", receipt }]);
  const result = await executeSandboxCjDispatch(run.deps);
  assert.equal(result.reason, "scheduled");
  assert.equal(run.calls.some((x) => Array.isArray(x) && x[0] === "create"), false);
  assert.deepEqual(run.calls.find((x) => Array.isArray(x) && x[0] === "schedule")[1], { actionId: "action-1", nextReconcileAt: 123 });
});

test("a committed terminal response is retried locally without another provider create", async () => {
  let completed = 0;
  const run = harness([prepared], { complete: async (input) => { completed++; run.calls.push(["complete", input]); if (completed === 1) throw new Error("response lost"); return {}; } });
  const result = await executeSandboxCjDispatch(run.deps);
  assert.equal(result.cjOrderId, "cj-1");
  assert.equal(completed, 2);
  assert.equal(run.calls.filter((x) => Array.isArray(x) && x[0] === "create").length, 1);
});

test("a pre-boundary fence rejection never calls CJ", async () => {
  const run = harness([prepared], { beginProviderCall: async () => ({ ignored: true }) });
  const result = await executeSandboxCjDispatch(run.deps);
  assert.equal(result.reason, "provider_fence_rejected");
  assert.equal(run.calls.some((x) => Array.isArray(x) && x[0] === "create"), false);
});

test("a reconciliation lookup is impossible until Convex grants its due lease", async () => {
  const run = harness([{ state: "reconcile_required", siteId: "site-1", orderId: "order-1", orderNumber: "dsa-sb-1", receipt }], {
    beginReconciliation: async () => ({ ready: false, nextReconcileAt: 999 }),
  });
  const result = await executeSandboxCjDispatch(run.deps);
  assert.equal(result.reason, "reconciliation_not_due");
  assert.equal(run.calls.some((x) => Array.isArray(x) && (x[0] === "find" || x[0] === "reconcile" || x[0] === "create")), false);
});
