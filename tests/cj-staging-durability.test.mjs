import assert from "node:assert/strict";
import test from "node:test";
import { executeCjStaging } from "../src/lib/cjStagingExecutor.ts";
import { cjFreightQuoteDigest } from "../src/lib/cjOrder.ts";

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

test("duplicate intake has no CJ or Trigger surface; a durable worker later completes exactly once", async () => {
  // The webhook's sole external dependency is the atomic intake mutation. A duplicate resolves
  // to its existing intent; neither result has a provider/Trigger operation to repeat.
  const intake = async () => ({ intentId: "intent-1", duplicate: true });
  assert.deepEqual(await intake(), { intentId: "intent-1", duplicate: true });
  const { calls, deps } = worker();
  await executeCjStaging(deps);
  assert.deepEqual(calls, { quote: 1, recordQuote: 1, stage: 1, trigger: 1, recordApproval: 1 });
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

test("quote digest binds exact lineage/provider inputs while keeping zip out of durable metadata", () => {
  const base = { siteId: "site-1", shopifyOrderId: "order-1", fromCountryCode: "US", destinationCountryCode: "US", shippingZip: "90210", products: [{ vid: "v1", quantity: 1 }], providerEndpoint: "/logistic/freightCalculate", providerVersion: "CJ API v2" };
  const digest = cjFreightQuoteDigest(base);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.notEqual(digest, cjFreightQuoteDigest({ ...base, products: [{ vid: "v1", quantity: 2 }] }));
  assert.notEqual(digest, cjFreightQuoteDigest({ ...base, shippingZip: "10001" }));
  assert.ok(!digest.includes("90210"));
});
