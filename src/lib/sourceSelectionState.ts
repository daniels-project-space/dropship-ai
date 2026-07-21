export type SourceSelectionDecision = "reuse" | "block_import" | "block_approval" | "stage";

/** Shared fail-closed decision used before a selection can replace local sourcing facts. */
export function sourceSelectionDecision(input: {
  sameRequestExists: boolean;
  shopifyDraftImportStatus?: "creating" | "created" | "ambiguous";
  existingApprovalStatus?: string;
}): SourceSelectionDecision {
  if (input.sameRequestExists) return "reuse";
  if (input.shopifyDraftImportStatus) return "block_import";
  if (input.existingApprovalStatus === "pending_approval" || input.existingApprovalStatus === "approved" || input.existingApprovalStatus === "executing") return "block_approval";
  return "stage";
}

/**
 * The persisted row is the authority for an HTTP retry. Returning it intact prevents a retry
 * from minting another CJ evidence row, approval action, or Trigger dispatch/waitpoint lineage.
 */
export function reuseSourceSelectionLineage<T extends {
  cjProductId: string;
  cjVariantId: string;
  priceUsd: number;
}>(prior: T, incoming: { cjProductId: string; cjVariantId: string; priceUsd: number }): T {
  if (prior.cjProductId !== incoming.cjProductId || prior.cjVariantId !== incoming.cjVariantId || prior.priceUsd !== incoming.priceUsd) {
    throw new Error("source selection requestId was already used for different candidate facts");
  }
  return prior;
}

export function approvalDispatchDecision(input: { actionStatus: string; dispatchStatus?: string; approvalRunId?: string }): "already_dispatched" | "trigger" | "reject" {
  if (input.actionStatus !== "pending_approval") return "reject";
  if (input.dispatchStatus === "dispatched" && input.approvalRunId) return "already_dispatched";
  // `dispatching` and `ambiguous` intentionally retry Trigger with the same deterministic key.
  return "trigger";
}

/** Stable per-cycle key: a duplicate task resumes the same waitpoint, a timeout gets one new token. */
export function approvalWaitpointKey(actionId: string, cycle: number): string {
  if (!actionId || !Number.isInteger(cycle) || cycle < 0) throw new Error("invalid approval waitpoint key");
  return `approval-gate:${actionId}:wait:${cycle}`;
}
