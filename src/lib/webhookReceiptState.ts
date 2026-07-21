/** Shared Convex webhook decisions: a delivery ID is never applied twice and CJ IDs never remap an order. */
export function webhookDeliveryDecision(prior: unknown): "duplicate" | "apply" {
  return prior ? "duplicate" : "apply";
}

/** Shopify delivery IDs are immutable; a changed digest is not a retry and must fail closed. */
export function shopifyReceiptDecision(prior: { payloadHash: string; topic: string } | null | undefined, incoming: { payloadHash: string; topic: string }): "apply" | "duplicate" | "reject_changed" {
  if (!prior) return "apply";
  return prior.payloadHash === incoming.payloadHash && prior.topic === incoming.topic ? "duplicate" : "reject_changed";
}

export function cjTrackingMappingDecision(input: { order?: { siteId: unknown; cjOrderId?: string } | null; siteId: unknown; incomingCjOrderId?: string }): "apply" | "ignore" {
  if (!input.order || input.order.siteId !== input.siteId) return "ignore";
  if (input.incomingCjOrderId && input.order.cjOrderId && input.incomingCjOrderId !== input.order.cjOrderId) return "ignore";
  return "apply";
}
