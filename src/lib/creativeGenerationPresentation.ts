export type CreativeGenerationSuccessState = "queued" | "in_flight" | "deferred";

/** Keep successful intake messaging truthful even when the handoff state is unfamiliar. */
export function presentCreativeGenerationSuccess(intentId: unknown, state: unknown): string {
  const batch = typeof intentId === "string" && intentId ? intentId.slice(0, 12) : "unknown";
  const detail = state === "queued"
    ? "queued"
    : state === "in_flight"
      ? "saved · handoff in flight"
      : state === "deferred"
        ? "saved · handoff deferred"
        : "saved · handoff status unavailable";
  return `Batch ${batch} ${detail}`;
}
