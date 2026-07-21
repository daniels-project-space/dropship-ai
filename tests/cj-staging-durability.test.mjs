import assert from "node:assert/strict";
import test from "node:test";
import { executeCjStaging } from "../src/lib/cjStagingExecutor.ts";
import { cjFreightQuoteDigest } from "../src/lib/cjOrder.ts";
import { CJ_STAGING_MAX_ATTEMPTS, CjStagingFailureError, classifyCjStagingFailure, cjStagingFailureTransition, cjStagingGenerationFingerprint, cjStagingRetryAt, hasExactCjStagingGeneration, legacyCjStagingRunnableAt, stagingInputDuplicateDecision } from "../src/lib/cjStagingState.ts";

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
  assert.deepEqual(cjStagingFailureTransition(1000, CJ_STAGING_MAX_ATTEMPTS, "retryable", "approval_dispatching"), { status: "needs_attention", runnableAt: undefined });
  assert.deepEqual(cjStagingFailureTransition(1000, 1, "permanent"), { status: "needs_attention", runnableAt: undefined });
  assert.deepEqual(cjStagingFailureTransition(1000, 2, "retryable", "approval_dispatching"), { status: "approval_dispatching", runnableAt: 121_000 });
});

test("only typed errors can be permanent; free-form provider text is bounded retryable", () => {
  assert.deepEqual(classifyCjStagingFailure(new CjStagingFailureError("permanent", "invalid_or_unbound_input")), { kind: "permanent", code: "invalid_or_unbound_input" });
  assert.deepEqual(classifyCjStagingFailure(new Error("not found: customer address should never classify state")), { kind: "retryable", code: "unexpected_runtime_failure" });
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

test("crash boundaries resume the persisted stage/action rather than re-quoting or replacing it", async () => {
  const afterStage = worker({ claimPreflight: async () => ({ state: "staged" }) });
  await executeCjStaging(afterStage.deps);
  assert.equal(afterStage.calls.quote, 0);
  assert.equal(afterStage.calls.stage, 0);
  assert.equal(afterStage.calls.trigger, 1);

  const afterApprovalClaim = worker({ claimPreflight: async () => ({ state: "staged" }), claimApproval: async () => ({ state: "busy" }) });
  assert.deepEqual(await executeCjStaging(afterApprovalClaim.deps), { state: "busy" });
  assert.equal(afterApprovalClaim.calls.trigger, 0);

  const triggerAcceptedResponseLost = worker({ claimPreflight: async () => ({ state: "staged" }), triggerApproval: async () => { triggerAcceptedResponseLost.calls.trigger++; throw new Error("lost response"); } });
  await assert.rejects(() => executeCjStaging(triggerAcceptedResponseLost.deps), /lost response/);
  assert.equal(triggerAcceptedResponseLost.calls.recordApproval, 0);

  const afterDispatchRecorded = worker({ claimPreflight: async () => ({ state: "staged" }), beginApproval: async () => ({ status: "dispatched" }) });
  await executeCjStaging(afterDispatchRecorded.deps);
  assert.equal(afterDispatchRecorded.calls.trigger, 0);
  assert.equal(afterDispatchRecorded.calls.recordApproval, 1);
});

test("generation fingerprint changes for a new quote time even when route and price match", () => {
  const base = { generation: 4, inputHash: "input", quoteInputDigest: "quote", logisticName: "USPS", fromCountryCode: "US", quotedPriceUsd: 5 };
  assert.notEqual(cjStagingGenerationFingerprint({ ...base, quotedAt: 1 }), cjStagingGenerationFingerprint({ ...base, quotedAt: 2 }));
  assert.notEqual(cjStagingGenerationFingerprint({ ...base, quotedAt: 1 }), cjStagingGenerationFingerprint({ ...base, quotedAt: 1, quotedPriceUsd: 6 }));
});

test("staging only reuses a fully current pending/approved action generation", () => {
  const quote = { quoteInputDigest: "quote", logisticName: "USPS", fromCountryCode: "US", quotedPriceUsd: 5, quotedAt: 10 };
  const fingerprint = cjStagingGenerationFingerprint({ generation: 3, inputHash: "input", ...quote });
  const order = { cjOrderInputHash: "input", cjDispatchGeneration: 3, cjDispatchGenerationFingerprint: fingerprint, cjQuoteInputDigest: "quote" };
  const params = { generation: 3, generationFingerprint: fingerprint, quoteInputDigest: "quote", logisticName: "USPS", fromCountryCode: "US", logisticsQuotedPriceUsd: 5, logisticsQuotedAt: 10 };
  assert.equal(hasExactCjStagingGeneration({ actionStatus: "pending_approval", actionParams: params, order, quote }), true);
  assert.equal(hasExactCjStagingGeneration({ actionStatus: "approved", actionParams: params, order, quote: { ...quote, quotedAt: 11 } }), false, "same route/price with a new quote time requires approval");
  assert.equal(hasExactCjStagingGeneration({ actionStatus: "pending_approval", actionParams: params, order, quote: { ...quote, quotedPriceUsd: 6 } }), false);
  assert.equal(hasExactCjStagingGeneration({ actionStatus: "superseded", actionParams: params, order, quote }), false);
});

test("legacy scheduler repair is phase-aware and never revives terminal rows", () => {
  assert.equal(legacyCjStagingRunnableAt("pending", undefined, 100), 100);
  assert.equal(legacyCjStagingRunnableAt("quoted", undefined, 100), 100);
  assert.equal(legacyCjStagingRunnableAt("staged", undefined, 100), 100);
  assert.equal(legacyCjStagingRunnableAt("preflighting", 200, 100), 200);
  assert.equal(legacyCjStagingRunnableAt("approval_dispatching", undefined, 100), 100);
});

test("quote digest binds exact lineage/provider inputs while keeping zip out of durable metadata", () => {
  const base = { siteId: "site-1", shopifyOrderId: "order-1", fromCountryCode: "US", destinationCountryCode: "US", shippingZip: "90210", products: [{ vid: "v1", quantity: 1 }], providerEndpoint: "/logistic/freightCalculate", providerVersion: "CJ API v2" };
  const digest = cjFreightQuoteDigest(base);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.notEqual(digest, cjFreightQuoteDigest({ ...base, products: [{ vid: "v1", quantity: 2 }] }));
  assert.notEqual(digest, cjFreightQuoteDigest({ ...base, shippingZip: "10001" }));
  assert.ok(!digest.includes("90210"));
});
