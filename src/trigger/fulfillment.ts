// Sandbox-only CJ fulfillment loop. Supplier writes are impossible without an immutable order
// snapshot, its exact approved action, an atomic reservation, and a second adapter-level
// `isSandbox: 1` boundary.
import { task, tasks, logger } from "@trigger.dev/sdk/v3";
import { convexClient, api } from "../lib/convexClient";
import { createSandboxOrder, getSandboxOrderByOrderNumber, isAmbiguousCjWriteError, parseOrderWebhook } from "../lib/cj";
import { fulfillmentTrackingInfoUpdate, type ShopifyClientConfig } from "../lib/shopify";
import { assertLiveEffectsEnabled, type EffectMode } from "../lib/effects";
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
        if (found.orderNumber !== orderNumber || (found.isSandbox !== 1 && found.isSandbox !== true)) throw new Error("CJ reconciliation returned an invalid sandbox identity");
        return { orderId: found.orderId, orderNumber: found.orderNumber, isSandbox: found.isSandbox };
      },
      reconcile: async ({ orderId, receipt, lookup }) => convex.mutation(api.orders.reconcileSandboxCjDispatchExecution, { actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders">, receipt: { ...receipt, executionId: receipt.executionId as Id<"cjDispatchExecutions">, actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders"> }, ...(lookup ? { lookup } : {}) }) as any,
      createSandboxOrder: (input) => createSandboxOrder(input as Parameters<typeof createSandboxOrder>[0]),
      complete: async ({ orderId, cjOrderId, receipt }) => convex.mutation(api.orders.completeSandboxCjDispatchExecution, { actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders">, cjOrderId, receipt: { ...receipt, executionId: receipt.executionId as Id<"cjDispatchExecutions">, actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders"> } }) as any,
      ambiguous: async ({ orderId, reason, receipt }) => convex.mutation(api.orders.markSandboxCjDispatchAmbiguousExecution, { actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders">, reason, receipt: { ...receipt, executionId: receipt.executionId as Id<"cjDispatchExecutions">, actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders"> } }) as any,
      failBeforeProvider: async ({ orderId, reason, receipt }) => convex.mutation(api.orders.failSandboxCjDispatchBeforeProvider, { actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders">, reason, receipt: { ...receipt, executionId: receipt.executionId as Id<"cjDispatchExecutions">, actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders"> } }) as any,
      scheduleReconciliation: async ({ actionId: scheduledActionId, nextReconcileAt }) => { await tasks.trigger<typeof fulfillOrder>("fulfill-order", { actionId: scheduledActionId }, { idempotencyKey: `cj-sandbox-reconcile:${scheduledActionId}:${nextReconcileAt}`, idempotencyKeyTTL: "24h", delay: `${Math.max(1, nextReconcileAt - Date.now())}ms` }); },
      isAmbiguousWriteError: isAmbiguousCjWriteError,
    });
    if (!result.skipped && !("reconciled" in result)) logger.info("CJ sandbox order created", { actionId });
    return result;
  },
});

export interface CjWebhookHandlerArgs {
  payload: unknown;
  shopify?: { cfg: ShopifyClientConfig; fulfillmentId: string };
  mode?: EffectMode;
}

/** Local tracking is idempotent; forwarding remains separately live-effects-gated. */
export async function handleCjTrackingWebhook(args: CjWebhookHandlerArgs) {
  const convex = convexClient();
  const tracking = parseOrderWebhook(args.payload);
  if (!tracking.orderNumber) throw new Error("cj webhook: missing orderNumber — cannot map to a Shopify order");
  await convex.mutation(api.orders.applyTracking, {
    cjOrderNumber: tracking.orderNumber, trackingNumber: tracking.trackNumber, trackingUrl: tracking.trackingUrl,
    cjOrderId: tracking.cjOrderId, status: "shipped",
  });
  if (args.shopify && tracking.trackNumber) {
    assertLiveEffectsEnabled(args.mode ?? "sandbox");
    await fulfillmentTrackingInfoUpdate(args.shopify.cfg, args.shopify.fulfillmentId, { number: tracking.trackNumber, url: tracking.trackingUrl, company: tracking.logisticName }, false);
  }
  // Tracking values remain in private Convex order state; Trigger results are not a PII channel.
  return { applied: true, orderNumber: tracking.orderNumber };
}
