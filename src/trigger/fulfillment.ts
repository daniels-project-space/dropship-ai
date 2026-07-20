// Order fulfillment loop.
//  fulfillOrder task: Shopify order in → cj.createOrder (create-only, payType:3) → record to Convex.
//  handleCjTrackingWebhook: called by the CJ ORDER webhook route → update Convex order tracking
//    + push tracking to Shopify via fulfillmentTrackingInfoUpdate.
import { task, logger } from "@trigger.dev/sdk/v3";
import { convexClient, api } from "../lib/convexClient";
import { createOrder, parseOrderWebhook, type CreateOrderInput } from "../lib/cj";
import { fulfillmentTrackingInfoUpdate, type ShopifyClientConfig } from "../lib/shopify";
import type { Id } from "../../convex/_generated/dataModel";

export interface FulfillOrderPayload {
  siteId: string;
  shopifyOrderId: string;
  totalUsd: number;
  cjInput: CreateOrderInput;
  cjAccessToken?: string; // optional override; else cj.ts resolves from vault/env
}

export const fulfillOrder = task({
  id: "fulfill-order",
  run: async (payload: FulfillOrderPayload) => {
    const convex = convexClient();
    const siteId = payload.siteId as Id<"sites">;
    const idempotencyKey = `cj:create:${payload.siteId}:${payload.shopifyOrderId}`;
    const target = `fulfillment:${payload.siteId}:${payload.shopifyOrderId}`;
    const traceId = idempotencyKey;

    // Persist intent before crossing the CJ boundary. This survives Trigger retries and leaves
    // an operator-visible trace even when the supplier is unavailable.
    const queued = await convex.mutation(api.ops.enqueue, {
      siteId, kind: "cj.create_order", target, idempotencyKey, traceId,
      payload: { shopifyOrderId: payload.shopifyOrderId },
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

      // 2. Create-only CJ order; payload.orderNumber is the stable supplier-side idempotency key.
      if (payload.cjInput.orderNumber !== payload.shopifyOrderId) throw new Error("CJ orderNumber must equal the Shopify order id");
      const cjResult = await createOrder(payload.cjInput, payload.cjAccessToken);
      logger.info("cj order created", { shopifyOrderId: payload.shopifyOrderId, cjOrderId: cjResult.orderId, traceId });

      // 3. Stamp the CJ order id + status onto the Convex order.
      await convex.mutation(api.orders.markSentToCj, { orderId, cjOrderId: cjResult.orderId });
      await convex.mutation(api.ops.markOutbox, { outboxId: queued.outboxId, status: "delivered", detail: { cjOrderId: cjResult.orderId } });
      return { orderId, cjOrderId: cjResult.orderId, shopifyOrderId: payload.shopifyOrderId, traceId };
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
    await fulfillmentTrackingInfoUpdate(args.shopify.cfg, args.shopify.fulfillmentId, {
      number: tracking.trackNumber,
      url: tracking.trackingUrl,
      company: tracking.logisticName,
    });
  }

  return { applied: true, orderNumber: tracking.orderNumber, trackNumber: tracking.trackNumber };
}
