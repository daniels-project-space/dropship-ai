/** Exact approval/order binding checked in Convex immediately before a CJ create can be claimed. */
import { cjOrderInputHash } from "./cjOrder";
import { cjStagingGenerationFingerprint } from "./cjStagingState";

export function hasValidSandboxCjApprovalBinding(input: {
  actionId: unknown;
  action?: { _id: unknown; siteId: unknown; type: string; status: string; params: unknown } | null;
  order?: { _id: unknown; siteId: unknown; cjApprovalActionId?: unknown; cjDispatchGeneration?: unknown; cjDispatchGenerationFingerprint?: unknown; cjQuoteInputDigest?: unknown; cjOrderInput?: { orderNumber: string; shippingZip: string; shippingCountryCode: string; shippingCountry: string; shippingProvince: string; shippingCity: string; shippingAddress: string; shippingCustomerName: string; shippingPhone: string; logisticName: string; fromCountryCode: string; products: Array<{ vid: string; quantity: number }> }; cjOrderInputHash?: string; cjLogisticsPreflight?: { logisticName: string; fromCountryCode: string; quotedAt: number; quotedPriceUsd: number } } | null;
}): boolean {
  const { action, order, actionId } = input;
  if (!action || !order || action._id !== actionId || action.type !== "dispatch_cj_sandbox_order" || action.siteId !== order.siteId || order.cjApprovalActionId !== actionId || !order.cjOrderInput || !order.cjOrderInputHash || !order.cjLogisticsPreflight) return false;
  const params = typeof action.params === "object" && action.params !== null ? action.params as Record<string, unknown> : null;
  if (!params || typeof order.cjDispatchGeneration !== "number" || typeof order.cjDispatchGenerationFingerprint !== "string" || typeof order.cjQuoteInputDigest !== "string") return false;
  const inputHash = cjOrderInputHash(order.cjOrderInput);
  const fingerprint = cjStagingGenerationFingerprint({
    generation: order.cjDispatchGeneration,
    inputHash,
    quoteInputDigest: order.cjQuoteInputDigest,
    logisticName: order.cjLogisticsPreflight.logisticName,
    fromCountryCode: order.cjLogisticsPreflight.fromCountryCode,
    quotedPriceUsd: order.cjLogisticsPreflight.quotedPriceUsd,
    quotedAt: order.cjLogisticsPreflight.quotedAt,
  });
  return inputHash === order.cjOrderInputHash
    && order.cjLogisticsPreflight.logisticName === order.cjOrderInput.logisticName
    && order.cjLogisticsPreflight.fromCountryCode === order.cjOrderInput.fromCountryCode
    && params.orderId === order._id
    && params.orderNumber === order.cjOrderInput.orderNumber
    && params.inputHash === order.cjOrderInputHash
    && params.generation === order.cjDispatchGeneration
    && params.generationFingerprint === order.cjDispatchGenerationFingerprint
    && typeof params.generationFingerprint === "string" && params.generationFingerprint.length === 64
    && params.quoteInputDigest === order.cjQuoteInputDigest
    && params.generationFingerprint === fingerprint
    && params.isSandbox === 1
    && params.payType === 3
    && params.logisticName === order.cjOrderInput.logisticName
    && params.fromCountryCode === order.cjOrderInput.fromCountryCode;
}
