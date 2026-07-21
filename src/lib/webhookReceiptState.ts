/** Shared Convex webhook decisions: a delivery ID is never applied twice and CJ IDs never remap an order. */
export function webhookDeliveryDecision(prior: unknown): "duplicate" | "apply" {
  return prior ? "duplicate" : "apply";
}

export function cjTrackingMappingDecision(input: { order?: { siteId: unknown; cjOrderId?: string } | null; siteId: unknown; incomingCjOrderId?: string }): "apply" | "ignore" {
  if (!input.order || input.order.siteId !== input.siteId) return "ignore";
  if (input.incomingCjOrderId && input.order.cjOrderId && input.incomingCjOrderId !== input.order.cjOrderId) return "ignore";
  return "apply";
}
