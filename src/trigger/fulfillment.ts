// Sandbox-only CJ fulfillment loop. Supplier writes are impossible without an immutable order
// snapshot, its exact approved action, an atomic reservation, and a second adapter-level
// `isSandbox: 1` boundary.
import { task, logger } from "@trigger.dev/sdk/v3";
import { convexClient, api } from "../lib/convexClient";
import { createSandboxOrder, getSandboxOrderByOrderNumber, isAmbiguousCjWriteError, parseOrderWebhook } from "../lib/cj";
import { fulfillmentTrackingInfoUpdate, type ShopifyClientConfig } from "../lib/shopify";
import { assertLiveEffectsEnabled, type EffectMode } from "../lib/effects";
import { executeSandboxCjDispatch } from "../lib/sandboxCjDispatchExecutor";
import type { Id } from "../../convex/_generated/dataModel";

export interface FulfillOrderPayload {
  /** The single human-gated action which is permanently bound to one input snapshot. */
  actionId: string;
}

export const fulfillOrder = task({
  id: "fulfill-order",
  run: async ({ actionId }: FulfillOrderPayload) => {
    const convex = convexClient();
    const result = await executeSandboxCjDispatch({
      claim: () => convex.mutation(api.orders.claimSandboxCjDispatch, { actionId: actionId as Id<"actions"> }) as any,
      findByOrderNumber: getSandboxOrderByOrderNumber,
      reconcile: async ({ orderId, cjOrderId, receipt }) => convex.mutation(api.orders.reconcileSandboxCjDispatch, { actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders">, cjOrderId, receipt: { ...receipt, actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders"> } }),
      enqueue: async ({ siteId, target, idempotencyKey, orderId, orderNumber, inputHash }) => convex.mutation(api.ops.enqueue, { siteId: siteId as Id<"sites">, kind: "cj.sandbox.create_order", target, idempotencyKey, traceId: idempotencyKey, payload: { actionId, orderId, orderNumber, inputHash, isSandbox: 1, payType: 3 } }),
      claimTarget: ({ target, owner }) => convex.mutation(api.ops.claimTarget, { target, owner, leaseMs: 10 * 60_000 }),
      markOutbox: async ({ outboxId, status, error, detail }) => { await convex.mutation(api.ops.markOutbox, { outboxId: outboxId as Id<"outbox">, status, ...(error ? { error } : {}), ...(detail ? { detail } : {}) }); },
      createSandboxOrder: (input) => createSandboxOrder(input as Parameters<typeof createSandboxOrder>[0]),
      markDispatched: async ({ orderId, outboxId, cjOrderId, receipt }) => convex.mutation(api.orders.markSandboxCjDispatched, { actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders">, outboxId: outboxId as Id<"outbox">, cjOrderId, receipt: { ...receipt, actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders"> } }) as any,
      markAmbiguous: async ({ orderId, outboxId, reason, receipt }) => convex.mutation(api.orders.markSandboxCjAmbiguous, { actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders">, outboxId: outboxId as Id<"outbox">, reason, receipt: { ...receipt, actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders"> } }) as any,
      abortBeforeProvider: async ({ orderId, outboxId, reason, receipt }) => convex.mutation(api.orders.abortSandboxCjDispatchBeforeProvider, { actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders">, ...(outboxId ? { outboxId: outboxId as Id<"outbox"> } : {}), reason, receipt: { ...receipt, actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders"> } }) as any,
      repairDispatched: async ({ orderId }) => convex.mutation(api.orders.repairSandboxCjDispatchOutbox, { actionId: actionId as Id<"actions">, orderId: orderId as Id<"orders"> }) as any,
      releaseTarget: async ({ target, owner }) => { await convex.mutation(api.ops.releaseTarget, { target, owner }); },
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
