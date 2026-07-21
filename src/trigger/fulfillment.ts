// Sandbox-only CJ fulfillment loop. Supplier writes are impossible without an immutable order
// snapshot, its exact approved action, an atomic reservation, and a second adapter-level
// `isSandbox: 1` boundary.
import { task, logger } from "@trigger.dev/sdk/v3";
import { convexClient, api } from "../lib/convexClient";
import { createSandboxOrder, getSandboxOrderByOrderNumber, isAmbiguousCjWriteError, parseOrderWebhook } from "../lib/cj";
import { fulfillmentTrackingInfoUpdate, type ShopifyClientConfig } from "../lib/shopify";
import { assertLiveEffectsEnabled, type EffectMode } from "../lib/effects";
import type { Id } from "../../convex/_generated/dataModel";

export interface FulfillOrderPayload {
  /** The single human-gated action which is permanently bound to one input snapshot. */
  actionId: string;
}

export const fulfillOrder = task({
  id: "fulfill-order",
  run: async ({ actionId }: FulfillOrderPayload) => {
    const convex = convexClient();
    // This transaction is the reservation point. It is intentionally before both the outbox
    // record and every CJ network request, and returns no input unless the reservation succeeds.
    const claimed = await convex.mutation(api.orders.claimSandboxCjDispatch, { actionId: actionId as Id<"actions"> });
    if (claimed.state === "reused") return { skipped: true, reason: "already_dispatched", orderId: claimed.orderId, cjOrderId: claimed.cjOrderId };
    if (claimed.state === "blocked") return { skipped: true, reason: "dispatch_blocked", orderId: claimed.orderId };

    if (claimed.state === "reconcile_required") {
      // A response loss, timeout, 5xx, or abandoned reservation must be read-reconciled using
      // the stable custom order number. A negative result only reopens a *later* run.
      const existing = await getSandboxOrderByOrderNumber(claimed.orderNumber);
      const reconciled = await convex.mutation(api.orders.reconcileSandboxCjDispatch, {
        actionId: actionId as Id<"actions">, orderId: claimed.orderId as Id<"orders">,
        cjOrderId: existing?.orderId,
      });
      return { reconciled: reconciled.state, orderId: claimed.orderId, orderNumber: claimed.orderNumber, retryRequired: reconciled.state === "absent" };
    }

    const target = `cj:sandbox:${claimed.orderId}`;
    const idempotencyKey = `cj:sandbox:create:${claimed.orderId}:${claimed.inputHash}`;
    const queued = await convex.mutation(api.ops.enqueue, {
      siteId: claimed.siteId,
      kind: "cj.sandbox.create_order",
      target,
      idempotencyKey,
      traceId: idempotencyKey,
      // Never put customer-address input into durable job payloads or traces.
      payload: { actionId, orderId: claimed.orderId, orderNumber: claimed.orderNumber, inputHash: claimed.inputHash, isSandbox: 1, payType: 3 },
    });
    const lock = await convex.mutation(api.ops.claimTarget, { target, owner: idempotencyKey, leaseMs: 10 * 60_000 });
    if (!lock.acquired) return { skipped: true, reason: "target_locked", orderId: claimed.orderId };

    try {
      await convex.mutation(api.ops.markOutbox, { outboxId: queued.outboxId, status: "processing" });
      // createSandboxOrder itself hard-codes `isSandbox: 1` and payType:3.
      const result = await createSandboxOrder(claimed.cjInput);
      await convex.mutation(api.orders.markSandboxCjDispatched, {
        actionId: actionId as Id<"actions">, orderId: claimed.orderId as Id<"orders">, cjOrderId: result.orderId,
      });
      await convex.mutation(api.ops.markOutbox, { outboxId: queued.outboxId, status: "delivered", detail: { orderId: claimed.orderId, cjOrderId: result.orderId, isSandbox: 1, payType: 3, zeroCharge: true } });
      logger.info("CJ sandbox order created", { actionId, orderId: claimed.orderId, cjOrderId: result.orderId, orderNumber: claimed.orderNumber });
      return { orderId: claimed.orderId, cjOrderId: result.orderId, orderNumber: claimed.orderNumber, isSandbox: 1, payType: 3, zeroCharge: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "CJ sandbox write failed";
      if (isAmbiguousCjWriteError(error)) {
        await convex.mutation(api.orders.markSandboxCjAmbiguous, { actionId: actionId as Id<"actions">, orderId: claimed.orderId as Id<"orders">, reason: message });
        await convex.mutation(api.ops.markOutbox, { outboxId: queued.outboxId, status: "failed", error: "CJ response ambiguous; reconciliation required before retry" });
      } else {
        await convex.mutation(api.ops.markOutbox, { outboxId: queued.outboxId, status: "failed", error: message.slice(0, 500) });
      }
      throw error;
    } finally {
      await convex.mutation(api.ops.releaseTarget, { target, owner: idempotencyKey });
    }
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
    shopifyOrderId: tracking.orderNumber, trackingNumber: tracking.trackNumber, trackingUrl: tracking.trackingUrl,
    cjOrderId: tracking.cjOrderId, status: "shipped",
  });
  if (args.shopify && tracking.trackNumber) {
    assertLiveEffectsEnabled(args.mode ?? "sandbox");
    await fulfillmentTrackingInfoUpdate(args.shopify.cfg, args.shopify.fulfillmentId, { number: tracking.trackNumber, url: tracking.trackingUrl, company: tracking.logisticName }, false);
  }
  return { applied: true, orderNumber: tracking.orderNumber, trackNumber: tracking.trackNumber };
}
