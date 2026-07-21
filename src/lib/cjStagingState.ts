/** Pure, non-PII state rules shared by the Convex intake and Trigger worker. */
export const CJ_STAGING_MAX_ATTEMPTS = 5;

export type CjStagingFailure = "retryable" | "permanent";
export type CjStagingErrorCode = "invalid_or_unbound_input" | "transient_provider_or_runtime_failure";

/** Never persist or log a provider error verbatim: it can contain a customer address. */
export function classifyCjStagingFailure(error: unknown): { kind: CjStagingFailure; code: CjStagingErrorCode } {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/(lineage|mapping|binding|configuration|config|invalid|incomplete|missing|eligible|not ready|not found)/.test(message)) {
    return { kind: "permanent", code: "invalid_or_unbound_input" };
  }
  return { kind: "retryable", code: "transient_provider_or_runtime_failure" };
}

export function cjStagingRetryAt(now: number, attempt: number): number {
  // 1, 2, 4, 8, 16 minutes; bounded and deterministic so there is no hot loop.
  return now + Math.min(16 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
}

export function cjStagingFailureTransition(now: number, attempt: number, failure: CjStagingFailure) {
  if (failure === "permanent") return { status: "needs_attention" as const, runnableAt: undefined };
  if (attempt >= CJ_STAGING_MAX_ATTEMPTS) return { status: "failed" as const, runnableAt: undefined };
  return { status: "pending" as const, runnableAt: cjStagingRetryAt(now, attempt) };
}

/** A changed delivery may reuse an intent only when its customer/order semantics are exact. */
export function stagingInputDuplicateDecision(existingDigest: string | undefined, incomingDigest: string): "reuse" | "needs_attention" {
  return existingDigest === incomingDigest ? "reuse" : "needs_attention";
}
