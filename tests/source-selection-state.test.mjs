import assert from "node:assert/strict";
import test from "node:test";
import { approvalDispatchDecision, approvalWaitpointKey, reuseSourceSelectionLineage, sourceSelectionDecision } from "../src/lib/sourceSelectionState.ts";

test("an exact source-selection retry and a concurrent duplicate reuse one evidence/action/waitpoint lineage", () => {
  assert.equal(sourceSelectionDecision({ sameRequestExists: true }), "reuse");
  assert.equal(sourceSelectionDecision({ sameRequestExists: true, shopifyDraftImportStatus: "creating", existingApprovalStatus: "approved" }), "reuse");
  const persisted = { cjProductId: "p1", cjVariantId: "v1", priceUsd: 40, evidenceId: "evidence_1", actionId: "action_1", approvalDispatchKey: "approval-gate:site:request", approvalRunId: "run_1", waitpointToken: "wait_1" };
  assert.equal(reuseSourceSelectionLineage(persisted, { cjProductId: "p1", cjVariantId: "v1", priceUsd: 40 }), persisted);
  assert.throws(() => reuseSourceSelectionLineage(persisted, { cjProductId: "p1", cjVariantId: "v1", priceUsd: 41 }), /already used/);
});

test("a fresh selection cannot refresh a reserved, ambiguous, or approval-protected draft", () => {
  for (const shopifyDraftImportStatus of ["creating", "created", "ambiguous"]) assert.equal(sourceSelectionDecision({ sameRequestExists: false, shopifyDraftImportStatus }), "block_import");
  for (const existingApprovalStatus of ["pending_approval", "approved", "executing"]) assert.equal(sourceSelectionDecision({ sameRequestExists: false, existingApprovalStatus }), "block_approval");
  assert.equal(sourceSelectionDecision({ sameRequestExists: false, existingApprovalStatus: "rejected" }), "stage");
});

test("Trigger delivery ambiguity retries its deterministic dispatch instead of failing the action", () => {
  assert.equal(approvalDispatchDecision({ actionStatus: "pending_approval", dispatchStatus: "pending" }), "trigger");
  assert.equal(approvalDispatchDecision({ actionStatus: "pending_approval", dispatchStatus: "dispatching" }), "trigger");
  assert.equal(approvalDispatchDecision({ actionStatus: "pending_approval", dispatchStatus: "ambiguous" }), "trigger");
  assert.equal(approvalDispatchDecision({ actionStatus: "pending_approval", dispatchStatus: "dispatched", approvalRunId: "run_1" }), "already_dispatched");
  assert.equal(approvalDispatchDecision({ actionStatus: "approved" }), "reject");
});

test("waitpoint retries reuse a cycle token, re-arms deterministically, and reject stale actions", () => {
  assert.equal(approvalWaitpointKey("action_1", 0), approvalWaitpointKey("action_1", 0));
  assert.notEqual(approvalWaitpointKey("action_1", 0), approvalWaitpointKey("action_1", 1));
  assert.equal(approvalDispatchDecision({ actionStatus: "executed", dispatchStatus: "dispatching" }), "reject");
});
