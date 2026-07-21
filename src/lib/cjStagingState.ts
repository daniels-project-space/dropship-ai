/** Pure, non-PII state rules shared by the Convex intake and Trigger worker. */
import { stableSha256 } from "./cjOrder";
export const CJ_STAGING_MAX_ATTEMPTS = 5;

export type CjStagingFailure = "retryable" | "permanent";
export type CjStagingErrorCode = "invalid_or_unbound_input" | "provider_unavailable" | "unexpected_runtime_failure";
export type CjStagingPhase = "pending" | "preflighting" | "quoted" | "preflight_required" | "staged" | "approval_dispatching";

/** Typed, redacted worker failure. Provider text is never a state-machine input. */
export class CjStagingFailureError extends Error {
  constructor(readonly kind: CjStagingFailure, readonly code: CjStagingErrorCode) {
    super(code);
    this.name = "CjStagingFailureError";
  }
}

/** Never persist or log a provider error verbatim: it can contain a customer address. */
export function classifyCjStagingFailure(error: unknown): { kind: CjStagingFailure; code: CjStagingErrorCode } {
  if (error instanceof CjStagingFailureError) return { kind: error.kind, code: error.code };
  return { kind: "retryable", code: "unexpected_runtime_failure" };
}

export function cjStagingRetryAt(now: number, attempt: number): number {
  // 1, 2, 4, 8, 16 minutes; bounded and deterministic so there is no hot loop.
  return now + Math.min(16 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
}

/** Preserve an armed approval phase on retry; it must never silently re-quote. */
export function cjStagingRetryPhase(phase: CjStagingPhase): CjStagingPhase {
  return phase === "preflighting" ? "pending" : phase;
}

export function cjStagingFailureTransition(now: number, workerAttempt: number, failure: CjStagingFailure, phase: CjStagingPhase = "pending") {
  if (failure === "permanent") return { status: "needs_attention" as const, runnableAt: undefined };
  if (workerAttempt >= CJ_STAGING_MAX_ATTEMPTS) return { status: "needs_attention" as const, runnableAt: undefined };
  return { status: cjStagingRetryPhase(phase), runnableAt: cjStagingRetryAt(now, workerAttempt) };
}

/** Complete, PII-free binding for a quote/approval generation. Hash this before persistence. */
export function cjStagingGenerationFingerprint(input: {
  generation: number;
  inputHash: string;
  quoteInputDigest: string;
  logisticName: string;
  fromCountryCode: string;
  quotedPriceUsd: number;
  quotedAt: number;
}): string {
  return stableSha256(JSON.stringify({
    generation: input.generation,
    inputHash: input.inputHash,
    quoteInputDigest: input.quoteInputDigest,
    logisticName: input.logisticName,
    fromCountryCode: input.fromCountryCode,
    quotedPriceUsd: input.quotedPriceUsd,
    quotedAt: input.quotedAt,
  }));
}

/** The action, order snapshot, and current provider quote must all name one exact generation. */
export function hasExactCjStagingGeneration(input: {
  actionStatus?: string;
  actionParams?: Record<string, unknown>;
  order?: { cjOrderInputHash?: string; cjDispatchGeneration?: number; cjDispatchGenerationFingerprint?: string; cjQuoteInputDigest?: string };
  quote: { quoteInputDigest: string; logisticName: string; fromCountryCode: string; quotedPriceUsd: number; quotedAt: number };
}): boolean {
  const { actionStatus, actionParams, order, quote } = input;
  if (!order?.cjOrderInputHash || !order.cjDispatchGeneration || !order.cjDispatchGenerationFingerprint || !order.cjQuoteInputDigest || !actionParams || (actionStatus !== "pending_approval" && actionStatus !== "approved")) return false;
  const fingerprint = cjStagingGenerationFingerprint({
    generation: order.cjDispatchGeneration, inputHash: order.cjOrderInputHash,
    quoteInputDigest: quote.quoteInputDigest, logisticName: quote.logisticName,
    fromCountryCode: quote.fromCountryCode, quotedPriceUsd: quote.quotedPriceUsd, quotedAt: quote.quotedAt,
  });
  return actionParams.generation === order.cjDispatchGeneration
    && actionParams.generationFingerprint === order.cjDispatchGenerationFingerprint
    && actionParams.generationFingerprint === fingerprint
    && actionParams.quoteInputDigest === quote.quoteInputDigest
    && actionParams.logisticName === quote.logisticName
    && actionParams.fromCountryCode === quote.fromCountryCode
    && actionParams.logisticsQuotedAt === quote.quotedAt
    && actionParams.logisticsQuotedPriceUsd === quote.quotedPriceUsd
    && order.cjQuoteInputDigest === quote.quoteInputDigest;
}

/** The legacy repair is bounded and only normalizes missing scheduler values. */
export function legacyCjStagingRunnableAt(status: CjStagingPhase, leaseExpiresAt: number | undefined, now: number): number {
  return status === "preflighting" || status === "approval_dispatching" ? (leaseExpiresAt ?? now) : now;
}

/** A changed delivery may reuse an intent only when its customer/order semantics are exact. */
export function stagingInputDuplicateDecision(existingDigest: string | undefined, incomingDigest: string): "reuse" | "needs_attention" {
  return existingDigest === incomingDigest ? "reuse" : "needs_attention";
}
