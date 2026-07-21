/**
 * Runtime-neutral execution of the actual Trigger CJ sandbox path. Convex owns every state
 * transition; this module only orders those calls so behavior tests can prove that no provider
 * write is reached before a successful claim and that every uncertain write is reconciled first.
 */
export type ClaimedSandboxDispatch =
  | { state: "reused"; orderId: string; cjOrderId?: string; orderNumber: string }
  | { state: "blocked"; orderId: string; orderNumber: string }
  | { state: "reconcile_required"; siteId: string; orderId: string; orderNumber: string; receipt: SandboxCjDispatchReceipt }
  | { state: "reserved"; siteId: string; orderId: string; orderNumber: string; inputHash: string; attempt: number; receipt: SandboxCjDispatchReceipt; cjInput: unknown };

export type SandboxCjDispatchReceipt = { actionId: string; orderId: string; inputHash: string; generation: number; generationFingerprint: string; attempt: number };

export interface SandboxCjDispatchDependencies {
  claim(): Promise<ClaimedSandboxDispatch>;
  findByOrderNumber(orderNumber: string): Promise<{ orderId: string } | null>;
  reconcile(input: { orderId: string; cjOrderId?: string; receipt: SandboxCjDispatchReceipt }): Promise<{ state: "found" | "ignored" }>;
  enqueue(input: { siteId: string; target: string; idempotencyKey: string; orderId: string; orderNumber: string; inputHash: string; attempt: number }): Promise<{ outboxId: string }>;
  claimTarget(input: { target: string; owner: string }): Promise<{ acquired: boolean }>;
  markOutbox(input: { outboxId: string; status: "processing" | "delivered" | "failed"; error?: string; detail?: Record<string, unknown> }): Promise<void>;
  createSandboxOrder(input: unknown): Promise<{ orderId: string }>;
  markDispatched(input: { orderId: string; cjOrderId: string; receipt: SandboxCjDispatchReceipt }): Promise<{ ignored?: boolean } | void>;
  markAmbiguous(input: { orderId: string; reason: string; receipt: SandboxCjDispatchReceipt }): Promise<{ ignored?: boolean } | void>;
  releaseTarget(input: { target: string; owner: string }): Promise<void>;
  isAmbiguousWriteError(error: unknown): boolean;
}

export async function executeSandboxCjDispatch(deps: SandboxCjDispatchDependencies) {
  let claimed = await deps.claim();
  if (claimed.state === "reused") return { skipped: true as const, reason: "already_dispatched", orderId: claimed.orderId, cjOrderId: claimed.cjOrderId };
  if (claimed.state === "blocked") return { skipped: true as const, reason: "dispatch_blocked", orderId: claimed.orderId };

  if (claimed.state === "reconcile_required") {
    const target = `cj:sandbox:${claimed.orderId}`;
    const owner = `cj:sandbox:create:${claimed.orderId}:${claimed.receipt.inputHash}:${claimed.receipt.attempt}`;
    // Hold the same target fence across provider lookup and reconciliation. A concurrent
    // delivery cannot turn a still-active or eventually-consistent request into a new create.
    const lock = await deps.claimTarget({ target, owner });
    if (!lock.acquired) return { skipped: true as const, reason: "dispatch_locked", orderId: claimed.orderId };
    try {
      const existing = await deps.findByOrderNumber(claimed.orderNumber);
      const reconciled = await deps.reconcile({ orderId: claimed.orderId, cjOrderId: existing?.orderId, receipt: claimed.receipt });
      if (reconciled.state === "found") return { reconciled: "found" as const, orderId: claimed.orderId, orderNumber: claimed.orderNumber };
      return { skipped: true as const, reason: "reconciliation_required", orderId: claimed.orderId };
    } finally {
      await deps.releaseTarget({ target, owner });
    }
  }

  const target = `cj:sandbox:${claimed.orderId}`;
  const idempotencyKey = `cj:sandbox:create:${claimed.orderId}:${claimed.inputHash}:${claimed.attempt}`;
  const queued = await deps.enqueue({ siteId: claimed.siteId, target, idempotencyKey, orderId: claimed.orderId, orderNumber: claimed.orderNumber, inputHash: claimed.inputHash, attempt: claimed.attempt });
  const lock = await deps.claimTarget({ target, owner: idempotencyKey });
  if (!lock.acquired) throw new Error("CJ sandbox target is locked; reconciliation retry is required");

  let providerCompleted = false;
  try {
    await deps.markOutbox({ outboxId: queued.outboxId, status: "processing" });
    const result = await deps.createSandboxOrder(claimed.cjInput);
    const completed = await deps.markDispatched({ orderId: claimed.orderId, cjOrderId: result.orderId, receipt: claimed.receipt });
    if (completed && completed.ignored) throw new Error("CJ dispatch receipt is stale after provider completion; reconciliation is required");
    providerCompleted = true;
    await deps.markOutbox({ outboxId: queued.outboxId, status: "delivered", detail: { orderId: claimed.orderId, cjOrderId: result.orderId, isSandbox: 1, payType: 3, zeroCharge: true } });
    return { orderId: claimed.orderId, cjOrderId: result.orderId, orderNumber: claimed.orderNumber, isSandbox: 1 as const, payType: 3 as const, zeroCharge: true as const };
  } catch (error) {
    // Once Convex recorded provider success, an outbox write failure must never turn a completed
    // order back into ambiguity. A retry's claim is replay-safe and only repairs delivery state.
    if (!providerCompleted && deps.isAmbiguousWriteError(error)) {
      const marked = await deps.markAmbiguous({ orderId: claimed.orderId, reason: "provider_response_ambiguous", receipt: claimed.receipt });
      if (marked && marked.ignored) throw new Error("CJ dispatch receipt is stale after ambiguous provider response; reconciliation is required");
      await deps.markOutbox({ outboxId: queued.outboxId, status: "failed", error: "CJ response ambiguous; reconciliation required before retry" });
    } else if (!providerCompleted) {
      // Provider errors are untrusted and may contain customer data. Persist a stable code only.
      await deps.markOutbox({ outboxId: queued.outboxId, status: "failed", error: "provider_write_failed" });
    }
    throw error;
  } finally {
    await deps.releaseTarget({ target, owner: idempotencyKey });
  }
}
