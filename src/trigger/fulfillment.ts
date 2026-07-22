// Sandbox-only CJ fulfillment loop. Supplier writes are impossible without an immutable order
// snapshot, its exact approved action, an atomic reservation, and a second adapter-level
// `isSandbox: 1` boundary.
import { task, tasks, schedules, logger } from "@trigger.dev/sdk/v3";
import { convexClient, api } from "../lib/convexClient";
import { createSandboxOrder, definitiveSandboxCjWriteRejection, getSandboxOrderByOrderNumber } from "../lib/cj";
import { executeSandboxCjDispatch } from "../lib/sandboxCjDispatchExecutor";
import { createHmac } from "node:crypto";
import type { Id } from "../../convex/_generated/dataModel";

export interface FulfillOrderPayload {
  /** The single human-gated action which is permanently bound to one input snapshot. */
  actionId: string;
}

/** A stable per-Trigger-run capability. The HMAC key never leaves the worker process. */
export function opaqueDispatchLeaseToken(triggerRunId: string, secret = process.env.TRIGGER_CJ_DISPATCH_LEASE_SECRET): string {
  if (!secret) throw new Error("CJ sandbox dispatch is blocked: TRIGGER_CJ_DISPATCH_LEASE_SECRET is not configured");
  return createHmac("sha256", secret).update(`dropship-ai:cj-sandbox-lease:${triggerRunId}`).digest("hex");
}

export const fulfillOrder = task({
  id: "fulfill-order",
  run: async ({ actionId }: FulfillOrderPayload, { ctx }) => {
    const convex = convexClient();
    const triggerRunId = ctx.run.id;
    // Stable across an automatic retry of this exact Trigger run without exposing a derivable
    // capability to callers that know only a Trigger run id.
    const leaseToken = opaqueDispatchLeaseToken(triggerRunId);
    const result = await executeSandboxCjDispatch({
      claim: () => convex.mutation(api.orders.claimSandboxCjDispatch, { actionId: actionId as Id<"actions">, triggerRunId, leaseToken }) as any,
      beginProviderCall: ({ orderId, receipt }) => convex.mutation(api.orders.beginSandboxCjProviderCall, { actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders">, receipt: { ...receipt, executionId: receipt.executionId as Id<"cjDispatchExecutions">, actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders"> } }) as any,
      beginReconciliation: ({ orderId, receipt }) => convex.mutation(api.orders.beginSandboxCjDispatchReconciliation, { actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders">, receipt: { ...receipt, executionId: receipt.executionId as Id<"cjDispatchExecutions">, actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders"> } }) as any,
      findByOrderNumber: async (orderNumber) => {
        const found = await getSandboxOrderByOrderNumber(orderNumber);
        if (!found) return null;
        if (found.orderNumber !== orderNumber || found.isSandbox !== 1) throw new Error("CJ reconciliation returned an invalid sandbox identity");
        return { orderId: found.orderId, orderNumber: found.orderNumber, isSandbox: found.isSandbox };
      },
      reconcile: async ({ orderId, receipt, lookup }) => convex.mutation(api.orders.reconcileSandboxCjDispatchExecution, { actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders">, receipt: { ...receipt, executionId: receipt.executionId as Id<"cjDispatchExecutions">, actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders"> }, ...(lookup ? { lookup } : {}) }) as any,
      createSandboxOrder: (input) => createSandboxOrder(input as Parameters<typeof createSandboxOrder>[0]),
      complete: async ({ orderId, cjOrderId, receipt }) => convex.mutation(api.orders.completeSandboxCjDispatchExecution, { actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders">, cjOrderId, receipt: { ...receipt, executionId: receipt.executionId as Id<"cjDispatchExecutions">, actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders"> } }) as any,
      ambiguous: async ({ orderId, reason, receipt }) => convex.mutation(api.orders.markSandboxCjDispatchAmbiguousExecution, { actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders">, reason, receipt: { ...receipt, executionId: receipt.executionId as Id<"cjDispatchExecutions">, actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders"> } }) as any,
      failBeforeProvider: async ({ orderId, reason, receipt }) => convex.mutation(api.orders.failSandboxCjDispatchBeforeProvider, { actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders">, reason, receipt: { ...receipt, executionId: receipt.executionId as Id<"cjDispatchExecutions">, actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders"> } }) as any,
      rejectDefinitiveProviderRejection: async ({ orderId, rejection, receipt }) => convex.mutation(api.orders.rejectSandboxCjDispatchAfterDefinitiveProviderRejection, { actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders">, rejection, receipt: { ...receipt, executionId: receipt.executionId as Id<"cjDispatchExecutions">, actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders"> } }) as any,
      scheduleReconciliation: async ({ actionId: scheduledActionId, receipt }) => {
        const handoff: any = await convex.mutation(api.orders.claimSandboxCjDispatchReconciliationSchedule, {
          actionId: scheduledActionId as Id<"actions">, orderId: receipt.orderId as Id<"orders">,
          receipt: { ...receipt, executionId: receipt.executionId as Id<"cjDispatchExecutions">, actionId: scheduledActionId as Id<"actions">, orderId: receipt.orderId as Id<"orders"> },
        });
        if (handoff.state !== "scheduled") return;
        await tasks.trigger<typeof fulfillOrder>("fulfill-order", { actionId: scheduledActionId }, {
          idempotencyKey: `cj-sandbox-reconcile:${handoff.executionId}:${handoff.generation}`,
          // Convex owns the due time. Do not reuse the executor's stale reconciliation result
          // if another durable handoff updated this execution before this response arrived.
          idempotencyKeyTTL: "24h", delay: `${Math.max(1, handoff.nextReconcileAt - Date.now())}ms`,
        });
      },
      definitiveProviderRejection: definitiveSandboxCjWriteRejection,
    });
    if (!result.skipped && !("reconciled" in result)) logger.info("CJ sandbox order created", { actionId });
    return result;
  },
});

// A Trigger response is only a projection of the durable due row. This short sweep reclaims a
// lost handoff after its lease, then emits the deterministic generation key; duplicate task
// deliveries can only enter the fenced read-only reconciliation branch above.
export const cjDispatchReconciliationSweep = schedules.task({
  id: "cj-dispatch-reconciliation-sweep",
  cron: "*/1 * * * *",
  run: async () => {
    const convex = convexClient();
    const due: Array<{ executionId: string }> = await convex.query(api.orders.listDueSandboxCjDispatchReconciliations, { limit: 25 }) as any;
    let scheduled = 0;
    for (const dueExecution of due) {
      const handoff: any = await convex.mutation(api.orders.claimDueSandboxCjDispatchReconciliationSchedule, { executionId: dueExecution.executionId as Id<"cjDispatchExecutions"> });
      if (handoff.state !== "scheduled") continue;
      await tasks.trigger<typeof fulfillOrder>("fulfill-order", { actionId: handoff.actionId }, {
        idempotencyKey: `cj-sandbox-reconcile:${handoff.executionId}:${handoff.generation}`,
        idempotencyKeyTTL: "24h",
      });
      scheduled++;
    }
    return { due: due.length, scheduled };
  },
});
