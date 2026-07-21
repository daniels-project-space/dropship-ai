/**
 * Runtime-neutral execution of the actual Trigger CJ sandbox path. Convex owns every state
 * transition; this module only orders those calls so behavior tests can prove that no provider
 * write is reached before a successful claim and that every uncertain write is reconciled first.
 */
export type ClaimedSandboxDispatch =
  | { state: "reused"; orderId: string; cjOrderId?: string; orderNumber: string }
  | { state: "blocked"; orderId: string; orderNumber: string }
  | { state: "reconcile_required"; siteId: string; orderId: string; orderNumber: string }
  | { state: "reserved"; siteId: string; orderId: string; orderNumber: string; inputHash: string; attempt: number; cjInput: unknown };

export interface SandboxCjDispatchDependencies {
  claim(): Promise<ClaimedSandboxDispatch>;
  findByOrderNumber(orderNumber: string): Promise<{ orderId: string } | null>;
  reconcile(input: { orderId: string; cjOrderId?: string }): Promise<{ state: "found" | "absent" }>;
  enqueue(input: { siteId: string; target: string; idempotencyKey: string; orderId: string; orderNumber: string; inputHash: string; attempt: number }): Promise<{ outboxId: string }>;
  claimTarget(input: { target: string; owner: string }): Promise<{ acquired: boolean }>;
  markOutbox(input: { outboxId: string; status: "processing" | "delivered" | "failed"; error?: string; detail?: Record<string, unknown> }): Promise<void>;
  createSandboxOrder(input: unknown): Promise<{ orderId: string }>;
  markDispatched(input: { orderId: string; cjOrderId: string }): Promise<void>;
  markAmbiguous(input: { orderId: string; reason: string }): Promise<void>;
  releaseTarget(input: { target: string; owner: string }): Promise<void>;
  isAmbiguousWriteError(error: unknown): boolean;
}

export async function executeSandboxCjDispatch(deps: SandboxCjDispatchDependencies) {
  let claimed = await deps.claim();
  if (claimed.state === "reused") return { skipped: true as const, reason: "already_dispatched", orderId: claimed.orderId, cjOrderId: claimed.cjOrderId };
  if (claimed.state === "blocked") return { skipped: true as const, reason: "dispatch_blocked", orderId: claimed.orderId };

  if (claimed.state === "reconcile_required") {
    const existing = await deps.findByOrderNumber(claimed.orderNumber);
    const reconciled = await deps.reconcile({ orderId: claimed.orderId, cjOrderId: existing?.orderId });
    if (reconciled.state === "found") return { reconciled: "found" as const, orderId: claimed.orderId, orderNumber: claimed.orderNumber };
    claimed = await deps.claim();
    if (claimed.state !== "reserved") throw new Error("CJ reconciliation continuation could not reserve the next generation");
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
    await deps.markDispatched({ orderId: claimed.orderId, cjOrderId: result.orderId });
    providerCompleted = true;
    await deps.markOutbox({ outboxId: queued.outboxId, status: "delivered", detail: { orderId: claimed.orderId, cjOrderId: result.orderId, isSandbox: 1, payType: 3, zeroCharge: true } });
    return { orderId: claimed.orderId, cjOrderId: result.orderId, orderNumber: claimed.orderNumber, isSandbox: 1 as const, payType: 3 as const, zeroCharge: true as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : "CJ sandbox write failed";
    // Once Convex recorded provider success, an outbox write failure must never turn a completed
    // order back into ambiguity. A retry's claim is replay-safe and only repairs delivery state.
    if (!providerCompleted && deps.isAmbiguousWriteError(error)) {
      await deps.markAmbiguous({ orderId: claimed.orderId, reason: message });
      await deps.markOutbox({ outboxId: queued.outboxId, status: "failed", error: "CJ response ambiguous; reconciliation required before retry" });
    } else if (!providerCompleted) {
      await deps.markOutbox({ outboxId: queued.outboxId, status: "failed", error: message.slice(0, 500) });
    }
    throw error;
  } finally {
    await deps.releaseTarget({ target, owner: idempotencyKey });
  }
}
