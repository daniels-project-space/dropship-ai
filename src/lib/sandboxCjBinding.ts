/** Exact approval/order binding checked in Convex immediately before a CJ create can be claimed. */
import { cjOrderInputHash } from "./cjOrder";
import { cjStagingGenerationFingerprint } from "./cjStagingState";

/**
 * Opaque, PII-free proof returned by the atomic reservation.  It deliberately contains every
 * immutable generation fact that a later provider acknowledgement must still match.
 */
export type SandboxCjDispatchReceipt = {
  actionId: unknown;
  orderId: unknown;
  inputHash: string;
  generation: number;
  generationFingerprint: string;
  attempt: number;
};

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
    && params.fromCountryCode === order.cjOrderInput.fromCountryCode
    && params.logisticsQuotedAt === order.cjLogisticsPreflight.quotedAt
    && params.logisticsQuotedPriceUsd === order.cjLogisticsPreflight.quotedPriceUsd;
}

/** Recompute a reservation receipt against the current order/action generation. */
export function hasCurrentSandboxCjDispatchReceipt(input: {
  receipt: SandboxCjDispatchReceipt;
  actionId: unknown;
  orderId: unknown;
  action?: { _id: unknown; siteId: unknown; type: string; status: string; params: unknown } | null;
  // This is a private Convex document at every caller. `any` here avoids widening a receipt
  // validator into a lossy RPC DTO; hasValidSandboxCjApprovalBinding verifies its full shape.
  order?: any | null;
}): boolean {
  const { receipt, actionId, orderId, action, order } = input;
  return !!order && !!action && hasValidSandboxCjApprovalBinding({ actionId, action, order }) && receipt.actionId === actionId && receipt.orderId === orderId
    && order._id === orderId && action._id === actionId
    // Recompute these values from private persisted input/quote; stored copies alone are not a
    // provider fence because a corrupted copy could otherwise bless the wrong receipt.
    && receipt.inputHash === cjOrderInputHash(order.cjOrderInput)
    && receipt.generation === order.cjDispatchGeneration
    && receipt.generationFingerprint === cjStagingGenerationFingerprint({ generation: order.cjDispatchGeneration as number, inputHash: cjOrderInputHash(order.cjOrderInput), quoteInputDigest: order.cjQuoteInputDigest as string, logisticName: order.cjLogisticsPreflight.logisticName, fromCountryCode: order.cjLogisticsPreflight.fromCountryCode, quotedPriceUsd: order.cjLogisticsPreflight.quotedPriceUsd, quotedAt: order.cjLogisticsPreflight.quotedAt })
    && receipt.attempt === order.cjDispatchAttempt
    && receipt.generationFingerprint === order.cjDispatchGenerationFingerprint;
}
