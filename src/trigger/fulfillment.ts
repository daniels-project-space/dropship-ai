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

    // 1. Record the received order first (idempotent) so we never lose it on a CJ failure.
    const orderId = await convex.mutation(api.orders.record, {
      siteId,
      shopifyOrderId: payload.shopifyOrderId,
      totalUsd: payload.totalUsd,
    });

    // 2. Create the order in CJ (no payment — payType:3).
    const cjResult = await createOrder(payload.cjInput, payload.cjAccessToken);
    logger.info("cj order created", { shopifyOrderId: payload.shopifyOrderId, cjOrderId: cjResult.orderId });

    // 3. Stamp the CJ order id + status onto the Convex order.
    await convex.mutation(api.orders.markSentToCj, { orderId, cjOrderId: cjResult.orderId });

    // Tracking is NOT in the create response — it arrives later via the CJ ORDER webhook.
    return { orderId, cjOrderId: cjResult.orderId, shopifyOrderId: payload.shopifyOrderId };
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
