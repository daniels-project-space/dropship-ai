// Order fulfillment loop.
//  fulfillOrder task: Shopify order in → cj.createOrder (create-only, payType:3) → record to Convex.
//  handleCjTrackingWebhook: called by the CJ ORDER webhook route → update Convex order tracking
//    + push tracking to Shopify via fulfillmentTrackingInfoUpdate.
import { task, logger } from "@trigger.dev/sdk/v3";
import { convexClient, api } from "../lib/convexClient";
import { createOrder, parseOrderWebhook, type CreateOrderInput } from "../lib/cj";
import { fulfillmentTrackingInfoUpdate, type ShopifyClientConfig } from "../lib/shopify";
import { assertLiveEffectsEnabled, type EffectMode } from "../lib/effects";
import type { Id } from "../../convex/_generated/dataModel";

export interface FulfillOrderPayload {
  siteId: string;
  shopifyOrderId: string;
  totalUsd: number;
  cjInput: CreateOrderInput;
  cjAccessToken?: string; // optional override; else cj.ts resolves from vault/env
  /** Defaults to sandbox. Live supplier creation requires the deployment-time effects gate. */
  mode?: EffectMode;
}

export const fulfillOrder = task({
  id: "fulfill-order",
  run: async (payload: FulfillOrderPayload) => {
    const convex = convexClient();
    const siteId = payload.siteId as Id<"sites">;
    const mode = payload.mode ?? "sandbox";
    const idempotencyKey = `cj:${mode}:create:${payload.siteId}:${payload.shopifyOrderId}`;
    const target = `fulfillment:${payload.siteId}:${payload.shopifyOrderId}`;
    const traceId = idempotencyKey;

    // Persist intent before crossing the CJ boundary. This survives Trigger retries and leaves
    // an operator-visible trace even when the supplier is unavailable.
    const queued = await convex.mutation(api.ops.enqueue, {
      siteId, kind: `cj.${mode}.create_order`, target, idempotencyKey, traceId,
      payload: { shopifyOrderId: payload.shopifyOrderId, mode },
    });
    if (queued.duplicate && queued.status === "delivered") {
      return { skipped: true, reason: "already delivered", shopifyOrderId: payload.shopifyOrderId };
    }
    const lock = await convex.mutation(api.ops.claimTarget, { target, owner: idempotencyKey, leaseMs: 10 * 60_000 });
    if (!lock.acquired) return { skipped: true, reason: "target locked", shopifyOrderId: payload.shopifyOrderId };

    try {
      await convex.mutation(api.ops.markOutbox, { outboxId: queued.outboxId, status: "processing" });
      // 1. Record the received order first (idempotent) so we never lose it on a CJ failure.
      const orderId = await convex.mutation(api.orders.record, { siteId, shopifyOrderId: payload.shopifyOrderId, totalUsd: payload.totalUsd });
      const existing = await convex.query(api.orders.getByShopifyOrder, { shopifyOrderId: payload.shopifyOrderId });
      if (existing?.cjOrderId) {
        await convex.mutation(api.ops.markOutbox, { outboxId: queued.outboxId, status: "delivered", detail: { cjOrderId: existing.cjOrderId, reused: true } });
        return { orderId, cjOrderId: existing.cjOrderId, shopifyOrderId: payload.shopifyOrderId, reused: true };
      }

      // 2. The source order number is the stable supplier-side idempotency key. Sandbox mode
      // never performs a CJ request: it produces a deterministic local supplier reference.
      if (payload.cjInput.orderNumber !== payload.shopifyOrderId) throw new Error("CJ orderNumber must equal the Shopify order id");
      const cjResult = mode === "sandbox"
        ? { orderId: `sandbox-cj:${payload.siteId}:${payload.shopifyOrderId}`, orderNumber: payload.shopifyOrderId }
        : await (async () => {
          assertLiveEffectsEnabled(mode);
          return createOrder(payload.cjInput, payload.cjAccessToken);
        })();
      logger.info("cj order created", { mode, shopifyOrderId: payload.shopifyOrderId, cjOrderId: cjResult.orderId, traceId });

      // 3. Stamp the CJ order id + status onto the Convex order.
      await convex.mutation(api.orders.markSentToCj, { orderId, cjOrderId: cjResult.orderId });
      await convex.mutation(api.ops.markOutbox, { outboxId: queued.outboxId, status: "delivered", detail: { cjOrderId: cjResult.orderId, mode, zeroCharge: mode === "sandbox" } });
      return { orderId, cjOrderId: cjResult.orderId, shopifyOrderId: payload.shopifyOrderId, traceId, mode, zeroCharge: mode === "sandbox" };
    } catch (error) {
      await convex.mutation(api.ops.markOutbox, { outboxId: queued.outboxId, status: "failed", error: String(error).slice(0, 500) });
      throw error;
    } finally {
      await convex.mutation(api.ops.releaseTarget, { target, owner: idempotencyKey });
    }
  },
});

export interface CjWebhookHandlerArgs {
  payload: unknown;
  // Shopify creds + fulfillmentId required to push tracking back to the storefront.
  shopify?: { cfg: ShopifyClientConfig; fulfillmentId: string };
  mode?: EffectMode;
}

/**
 * Handle an inbound CJ ORDER webhook. Parses tracking, writes it to Convex, and (if Shopify
 * creds/fulfillmentId are provided) pushes tracking to Shopify. Call this from the webhook route.
 */
export async function handleCjTrackingWebhook(args: CjWebhookHandlerArgs) {
  const convex = convexClient();
  const tracking = parseOrderWebhook(args.payload);
  if (!tracking.orderNumber) {
    throw new Error("cj webhook: missing orderNumber — cannot map to a Shopify order");
  }

  await convex.mutation(api.orders.applyTracking, {
    shopifyOrderId: tracking.orderNumber,
    trackingNumber: tracking.trackNumber,
    trackingUrl: tracking.trackingUrl,
    cjOrderId: tracking.cjOrderId,
    status: "shipped",
  });

  if (args.shopify && tracking.trackNumber) {
    assertLiveEffectsEnabled(args.mode ?? "sandbox");
    await fulfillmentTrackingInfoUpdate(args.shopify.cfg, args.shopify.fulfillmentId, {
      number: tracking.trackNumber,
      url: tracking.trackingUrl,
      company: tracking.logisticName,
    }, false);
  }

  return { applied: true, orderNumber: tracking.orderNumber, trackNumber: tracking.trackNumber };
}
