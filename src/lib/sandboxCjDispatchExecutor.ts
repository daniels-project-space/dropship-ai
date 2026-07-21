/**
 * Runtime-neutral ordering for the real Trigger/Convex dispatch protocol. Convex owns the
 * receipt and every transition; this module never manufactures an outbox, lock, or retry key.
 */
export type SandboxCjDispatchReceipt = {
  executionId: string; actionId: string; orderId: string; inputHash: string; generation: number;
  generationFingerprint: string; attempt: number; triggerRunId: string; leaseToken: string;
  leaseVersion: number; providerMode: "sandbox"; providerIdentity: string;
};
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
  failBeforeProvider(input: { orderId: string; reason: string; receipt: SandboxCjDispatchReceipt }): Promise<{ ignored?: boolean }>;
  scheduleReconciliation?(input: { actionId: string; receipt: SandboxCjDispatchReceipt; nextReconcileAt: number }): Promise<void>;
  isAmbiguousWriteError(error: unknown): boolean;
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
    if (result.state === "scheduled" && result.nextReconcileAt) await deps.scheduleReconciliation?.({ actionId: claimed.receipt.actionId, receipt: claimed.receipt, nextReconcileAt: result.nextReconcileAt });
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
    } else if (deps.isAmbiguousWriteError(error)) {
      await deps.ambiguous({ orderId: claimed.orderId, reason: "provider_response_ambiguous", receipt: claimed.receipt });
    } else {
      // The adapter has classified this as a definitive pre-write rejection. Unknown errors
      // stay reconciliation-only; no caller can turn them back into a create.
      await deps.failBeforeProvider({ orderId: claimed.orderId, reason: "provider_write_rejected", receipt: claimed.receipt });
    }
    throw error;
  }
}
