import assert from "node:assert/strict";
import test from "node:test";
import { executeSandboxCjDispatch } from "../src/lib/sandboxCjDispatchExecutor.ts";

const receipt = { actionId: "action-1", orderId: "order-1", inputHash: "hash-1", generation: 1, generationFingerprint: "f".repeat(64), attempt: 1 };
const reserved = { state: "reserved", siteId: "site-1", orderId: "order-1", orderNumber: "dsa-sb-1", inputHash: "hash-1", attempt: 1, receipt, cjInput: { logisticName: "Quoted Route", fromCountryCode: "US" } };

function harness(claims = [reserved], overrides = {}) {
  const calls = [];
  const nextClaim = () => Promise.resolve(claims.shift() ?? reserved);
  return {
    calls,
    deps: {
      claim: async () => { calls.push("claim"); return nextClaim(); },
      findByOrderNumber: async (orderNumber) => { calls.push(["find", orderNumber]); return null; },
      reconcile: async (input) => { calls.push(["reconcile", input]); return { state: "absent" }; },
      enqueue: async (input) => { calls.push(["enqueue", input]); return { outboxId: "outbox-1" }; },
      claimTarget: async (input) => { calls.push(["lock", input]); return { acquired: true }; },
      markOutbox: async (input) => { calls.push(["outbox", input]); },
      createSandboxOrder: async (input) => { calls.push(["create", input]); return { orderId: "cj-1" }; },
      markDispatched: async (input) => { calls.push(["complete", input]); },
      markAmbiguous: async (input) => { calls.push(["ambiguous", input]); },
      abortBeforeProvider: async (input) => { calls.push(["abort", input]); },
      repairDispatched: async (input) => { calls.push(["repair", input]); },
      releaseTarget: async (input) => { calls.push(["release", input]); },
      isAmbiguousWriteError: () => true,
      ...overrides,
    },
  };
}

test("actual Trigger executor claims once before its only CJ create call and duplicate replay has no provider effect", async () => {
  const first = harness();
  await executeSandboxCjDispatch(first.deps);
  assert.deepEqual(first.calls.map((entry) => Array.isArray(entry) ? entry[0] : entry), ["claim", "enqueue", "lock", "outbox", "create", "complete", "release"]);
  const duplicate = harness([{ state: "reused", orderId: "order-1", orderNumber: "dsa-sb-1", cjOrderId: "cj-1" }]);
  const result = await executeSandboxCjDispatch(duplicate.deps);
  assert.equal(result.skipped, true);
  assert.deepEqual(duplicate.calls, ["claim", ["repair", { orderId: "order-1" }]]);
});

test("ambiguous CJ response requires a read reconciliation; found completes without another create", async () => {
  const run = harness([{ state: "reconcile_required", siteId: "site-1", orderId: "order-1", orderNumber: "dsa-sb-1", receipt }], {
    findByOrderNumber: async () => ({ orderId: "cj-1" }),
    reconcile: async (input) => { run.calls.push(["reconcile", input]); return { state: "found" }; },
  });
  const result = await executeSandboxCjDispatch(run.deps);
  assert.deepEqual(result, { reconciled: "found", orderId: "order-1", orderNumber: "dsa-sb-1" });
  assert.equal(run.calls.some((entry) => Array.isArray(entry) && entry[0] === "create"), false);
  assert.deepEqual(run.calls.filter((entry) => Array.isArray(entry) && entry[0] === "reconcile")[0][1], { orderId: "order-1", cjOrderId: "cj-1", receipt });
});

test("an absent reconciliation never creates again while provider reads can be eventually consistent", async () => {
  const run = harness([{ state: "reconcile_required", siteId: "site-1", orderId: "order-1", orderNumber: "dsa-sb-1", receipt }]);
  const result = await executeSandboxCjDispatch(run.deps);
  assert.equal(result.reason, "reconciliation_required");
  assert.equal(run.calls.filter((entry) => entry === "claim").length, 1);
  assert.equal(run.calls.filter((entry) => Array.isArray(entry) && entry[0] === "create").length, 0);
  assert.equal(run.calls.filter((entry) => Array.isArray(entry) && entry[0] === "lock").length, 1);
  assert.equal(run.calls.filter((entry) => Array.isArray(entry) && entry[0] === "release").length, 1);
});

test("a lost terminal mutation response is repaired from the provider result without another CJ call", async () => {
  let completes = 0;
  const run = harness([reserved], {
    markDispatched: async () => {
      completes++;
      run.calls.push("complete");
      if (completes === 1) throw new Error("terminal response lost");
    },
  });
  const result = await executeSandboxCjDispatch(run.deps);
  assert.equal(result.cjOrderId, "cj-1");
  assert.equal(completes, 2);
  assert.equal(run.calls.some((entry) => Array.isArray(entry) && entry[0] === "ambiguous"), false);
  assert.equal(run.calls.filter((entry) => Array.isArray(entry) && entry[0] === "create").length, 1);
});

test("enqueue and processing failures release the reservation before any CJ call", async () => {
  const enqueueFailed = harness([reserved], { enqueue: async () => { throw new Error("outbox unavailable"); } });
  await assert.rejects(() => executeSandboxCjDispatch(enqueueFailed.deps), /outbox unavailable/);
  assert.equal(enqueueFailed.calls.some((entry) => Array.isArray(entry) && entry[0] === "abort"), true);
  assert.equal(enqueueFailed.calls.some((entry) => Array.isArray(entry) && entry[0] === "create"), false);
  const processingFailed = harness([reserved], { markOutbox: async () => { throw new Error("processing unavailable"); } });
  await assert.rejects(() => executeSandboxCjDispatch(processingFailed.deps), /processing unavailable/);
  assert.equal(processingFailed.calls.some((entry) => Array.isArray(entry) && entry[0] === "abort"), true);
  assert.equal(processingFailed.calls.some((entry) => Array.isArray(entry) && entry[0] === "create"), false);
});

test("a claim or lock failure makes no real-effects call", async () => {
  const rejected = harness([], { claim: async () => { throw new Error("wrong action/order/site/product binding"); } });
  await assert.rejects(() => executeSandboxCjDispatch(rejected.deps), /binding/);
  assert.equal(rejected.calls.some((entry) => Array.isArray(entry) && entry[0] === "create"), false);
  const locked = harness([reserved], { claimTarget: async () => ({ acquired: false }) });
  await assert.rejects(() => executeSandboxCjDispatch(locked.deps), /locked/);
  assert.equal(locked.calls.some((entry) => Array.isArray(entry) && entry[0] === "create"), false);
  assert.equal(locked.calls.some((entry) => Array.isArray(entry) && entry[0] === "abort"), true);
});
