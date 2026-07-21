/**
 * Runtime-neutral ordering for the real Trigger/Convex dispatch protocol. Convex owns the
 * receipt and every transition; this module never manufactures an outbox, lock, or retry key.
 */
export type SandboxCjDispatchReceipt = {
  executionId: string; actionId: string; orderId: string; inputHash: string; generation: number;
  generationFingerprint: string; attempt: number; triggerRunId: string; leaseToken: string;
  leaseVersion: number; providerMode: "sandbox"; providerIdentity: string;
};
export type DefinitiveSandboxCjProviderRejection = "invalid_request" | "invalid_credentials" | "sandbox_not_permitted" | "provider_resource_missing" | "invalid_order";
export type ClaimedSandboxDispatch =
  | { state: "reused"; orderId: string; orderNumber: string; cjOrderId?: string }
  | { state: "blocked"; orderId: string; orderNumber: string }
  | { state: "reconcile_required"; siteId: string; orderId: string; orderNumber: string; receipt: SandboxCjDispatchReceipt }
  | { state: "prepared"; siteId: string; orderId: string; orderNumber: string; receipt: SandboxCjDispatchReceipt; cjInput: unknown };

export interface SandboxCjDispatchDependencies {
  claim(): Promise<ClaimedSandboxDispatch>;
  beginProviderCall(input: { orderId: string; receipt: SandboxCjDispatchReceipt }): Promise<{ ignored?: boolean }>;
  beginReconciliation(input: { orderId: string; receipt: SandboxCjDispatchReceipt }): Promise<{ ready: boolean; nextReconcileAt?: number }>;
  findByOrderNumber(orderNumber: string): Promise<{ orderId: string; orderNumber: string; isSandbox: 1 } | null>;
  reconcile(input: { orderId: string; receipt: SandboxCjDispatchReceipt; lookup?: { orderId: string; orderNumber: string; isSandbox: 1 } }): Promise<{ state: "found" | "scheduled" | "needs_attention" | "ignored"; nextReconcileAt?: number }>;
  createSandboxOrder(input: unknown): Promise<{ orderId: string }>;
  complete(input: { orderId: string; cjOrderId: string; receipt: SandboxCjDispatchReceipt }): Promise<{ ignored?: boolean }>;
  ambiguous(input: { orderId: string; reason: string; receipt: SandboxCjDispatchReceipt }): Promise<{ ignored?: boolean }>;
  /** Only local failures that occurred before beginProviderCall may use this path. */
  failBeforeProvider(input: { orderId: string; reason: string; receipt: SandboxCjDispatchReceipt }): Promise<{ ignored?: boolean }>;
  /** A closed, typed provider rejection may safely close a provider_calling execution. */
  rejectDefinitiveProviderRejection(input: { orderId: string; rejection: DefinitiveSandboxCjProviderRejection; receipt: SandboxCjDispatchReceipt }): Promise<{ ignored?: boolean }>;
  scheduleReconciliation?(input: { actionId: string; receipt: SandboxCjDispatchReceipt }): Promise<void>;
  definitiveProviderRejection(error: unknown): DefinitiveSandboxCjProviderRejection | null;
}

export async function executeSandboxCjDispatch(deps: SandboxCjDispatchDependencies) {
  const claimed = await deps.claim();
  if (claimed.state === "reused") return { skipped: true as const, reason: "already_dispatched", orderId: claimed.orderId, cjOrderId: claimed.cjOrderId };
  if (claimed.state === "blocked") return { skipped: true as const, reason: "dispatch_blocked", orderId: claimed.orderId };
  if (claimed.state === "reconcile_required") {
    // Convex must grant this exact, due read lease before the provider lookup. This keeps a
    // delayed task and a stale run entirely inside Convex rather than touching CJ.
    const reconciliation = await deps.beginReconciliation({ orderId: claimed.orderId, receipt: claimed.receipt });
    if (!reconciliation.ready) return { skipped: true as const, reason: "reconciliation_not_due", orderId: claimed.orderId };
    const lookup = await deps.findByOrderNumber(claimed.orderNumber);
    const result = await deps.reconcile({ orderId: claimed.orderId, receipt: claimed.receipt, ...(lookup ? { lookup } : {}) });
    if (result.state === "scheduled") await deps.scheduleReconciliation?.({ actionId: claimed.receipt.actionId, receipt: claimed.receipt });
    return result.state === "found"
      ? { reconciled: "found" as const, orderId: claimed.orderId, orderNumber: claimed.orderNumber }
      : { skipped: true as const, reason: result.state, orderId: claimed.orderId };
  }
  // If this mutation commits but its response is lost, a same-run retry sees provider_calling
  // and is forced into the read-only branch above. It must never abort or issue another create.
  let began: { ignored?: boolean };
  try { began = await deps.beginProviderCall({ orderId: claimed.orderId, receipt: claimed.receipt }); }
  catch (error) { throw error; }
  if (began.ignored) return { skipped: true as const, reason: "provider_fence_rejected", orderId: claimed.orderId };
  let result: { orderId: string } | undefined;
  try {
    result = await deps.createSandboxOrder(claimed.cjInput);
    const terminal = await deps.complete({ orderId: claimed.orderId, cjOrderId: result.orderId, receipt: claimed.receipt });
    if (terminal.ignored) throw new Error("CJ dispatch receipt is stale after provider completion; reconciliation is required");
    return { orderId: claimed.orderId, cjOrderId: result.orderId, orderNumber: claimed.orderNumber, isSandbox: 1 as const, payType: 3 as const, zeroCharge: true as const };
  } catch (error) {
    if (result) {
      const terminal = await deps.complete({ orderId: claimed.orderId, cjOrderId: result.orderId, receipt: claimed.receipt });
      if (!terminal.ignored) return { orderId: claimed.orderId, cjOrderId: result.orderId, orderNumber: claimed.orderNumber, isSandbox: 1 as const, payType: 3 as const, zeroCharge: true as const };
    } else {
      const rejection = deps.definitiveProviderRejection(error);
      if (rejection) {
        // This is a closed adapter classification, not a caller-provided escape hatch. The
        // Convex handler accepts it only while this exact receipt is provider_calling.
        await deps.rejectDefinitiveProviderRejection({ orderId: claimed.orderId, rejection, receipt: claimed.receipt });
      } else {
        // Timeouts, 409/429, 5xx, response loss, and unknown errors stay on the same read-only
        // reconciliation lineage. They can never re-enter the create branch.
        await deps.ambiguous({ orderId: claimed.orderId, reason: "provider_response_ambiguous", receipt: claimed.receipt });
      }
    }
    throw error;
  }
}
