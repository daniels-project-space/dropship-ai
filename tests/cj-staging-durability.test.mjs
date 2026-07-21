import assert from "node:assert/strict";
import test from "node:test";
import { executeCjStaging } from "../src/lib/cjStagingExecutor.ts";
import { cjFreightQuoteDigest } from "../src/lib/cjOrder.ts";
import { CJ_STAGING_MAX_ATTEMPTS, cjStagingFailureTransition, cjStagingRetryAt, stagingInputDuplicateDecision } from "../src/lib/cjStagingState.ts";

function worker(overrides = {}) {
  const calls = { quote: 0, recordQuote: 0, stage: 0, trigger: 0, recordApproval: 0 };
  const deps = {
    claimPreflight: async () => ({ state: "preflight", attempt: 1, quoteInputDigest: "digest", fromCountryCode: "US", destinationCountryCode: "US", shippingZip: "90210", products: [{ vid: "v1", quantity: 1 }] }),
    quote: async () => { calls.quote++; return { logisticName: "USPS", logisticPriceUsd: 5 }; },
    recordQuote: async () => { calls.recordQuote++; },
    stage: async () => { calls.stage++; return { state: "staged", actionId: "action-1" }; },
    claimApproval: async () => ({ state: "dispatch", actionId: "action-1", approvalDispatchKey: "approval-1" }),
    beginApproval: async () => ({ status: "dispatching" }),
    triggerApproval: async () => { calls.trigger++; },
    recordApproval: async () => { calls.recordApproval++; },
    now: () => 1,
    ...overrides,
  };
  return { calls, deps };
}

test("durable semantic duplicate intake has no CJ or Trigger surface", async () => {
  // This is the same reducer used to decide cross-delivery intent reuse, not a stubbed route.
  assert.equal(stagingInputDuplicateDecision("digest-a", "digest-a"), "reuse");
  assert.equal(stagingInputDuplicateDecision("digest-a", "digest-b"), "needs_attention");
  const { calls, deps } = worker();
  await executeCjStaging(deps);
  assert.deepEqual(calls, { quote: 1, recordQuote: 1, stage: 1, trigger: 1, recordApproval: 1 });
});

test("bounded retry transitions are due once, then terminal; permanent inputs need attention", () => {
  assert.equal(cjStagingRetryAt(1000, 1), 61_000);
  assert.deepEqual(cjStagingFailureTransition(1000, 1, "retryable"), { status: "pending", runnableAt: 61_000 });
  assert.deepEqual(cjStagingFailureTransition(1000, CJ_STAGING_MAX_ATTEMPTS, "retryable"), { status: "failed", runnableAt: undefined });
  assert.deepEqual(cjStagingFailureTransition(1000, 1, "permanent"), { status: "needs_attention", runnableAt: undefined });
});

test("failure after durable intake retries in the worker, and a persisted quote is reused", async () => {
  const failed = worker({ quote: async () => { throw new Error("temporary CJ failure"); } });
  await assert.rejects(() => executeCjStaging(failed.deps), /temporary CJ failure/);
  assert.equal(failed.calls.trigger, 0);
  const retried = worker({ claimPreflight: async () => ({ state: "quoted" }) });
  await executeCjStaging(retried.deps);
  assert.equal(retried.calls.quote, 0, "a quote already persisted by the first attempt is never re-quoted");
  assert.equal(retried.calls.trigger, 1);
});

test("concurrent fenced worker sees busy and cannot double stage or dispatch", async () => {
  const { calls, deps } = worker({ claimPreflight: async () => ({ state: "busy" }) });
  assert.deepEqual(await executeCjStaging(deps), { state: "busy" });
  assert.deepEqual(calls, { quote: 0, recordQuote: 0, stage: 0, trigger: 0, recordApproval: 0 });
});

test("a stale quote re-enters explicit preflight and cannot arm or execute approval", async () => {
  const { calls, deps } = worker({ claimPreflight: async () => ({ state: "quoted" }), stage: async () => ({ state: "preflight_required" }) });
  assert.deepEqual(await executeCjStaging(deps), { state: "preflight_required" });
  assert.equal(calls.quote, 0);
  assert.equal(calls.trigger, 0);
  assert.equal(calls.recordApproval, 0);
});

test("a resolved action is never armed or marked dispatched by a stale worker", async () => {
  const { calls, deps } = worker({ beginApproval: async () => ({ status: "resolved" }) });
  assert.deepEqual(await executeCjStaging(deps), { state: "resolved" });
  assert.equal(calls.trigger, 0);
  assert.equal(calls.recordApproval, 0);
});

test("an ambiguous Trigger response cannot mark the intent dispatched", async () => {
  const { calls, deps } = worker({ triggerApproval: async () => { calls.trigger++; throw new Error("response lost"); } });
  await assert.rejects(() => executeCjStaging(deps), /response lost/);
  assert.equal(calls.recordApproval, 0);
});

test("quote digest binds exact lineage/provider inputs while keeping zip out of durable metadata", () => {
  const base = { siteId: "site-1", shopifyOrderId: "order-1", fromCountryCode: "US", destinationCountryCode: "US", shippingZip: "90210", products: [{ vid: "v1", quantity: 1 }], providerEndpoint: "/logistic/freightCalculate", providerVersion: "CJ API v2" };
  const digest = cjFreightQuoteDigest(base);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.notEqual(digest, cjFreightQuoteDigest({ ...base, products: [{ vid: "v1", quantity: 2 }] }));
  assert.notEqual(digest, cjFreightQuoteDigest({ ...base, shippingZip: "10001" }));
  assert.ok(!digest.includes("90210"));
});
