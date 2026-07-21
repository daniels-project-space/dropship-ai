/** Shared Convex webhook decisions: a delivery ID is never applied twice and CJ IDs never remap an order. */
export function webhookDeliveryDecision(prior: unknown): "duplicate" | "apply" {
  return prior ? "duplicate" : "apply";
}

/** Shopify delivery IDs are immutable; a changed digest is not a retry and must fail closed. */
export function shopifyReceiptDecision(prior: { payloadHash: string; topic: string } | null | undefined, incoming: { payloadHash: string; topic: string }): "apply" | "duplicate" | "reject_changed" {
  if (!prior) return "apply";
  return prior.payloadHash === incoming.payloadHash && prior.topic === incoming.topic ? "duplicate" : "reject_changed";
}

/** Intake's second fence: different delivery IDs must still have identical staging semantics. */
export function shopifyStagingIntakeDecision(input: { priorDelivery?: { payloadHash: string; topic: string } | null; incoming: { payloadHash: string; topic: string }; existingStagingDigest?: string; incomingStagingDigest?: string }): "apply" | "duplicate" | "reject_changed" | "reuse_intent" | "needs_attention" {
  const receipt = shopifyReceiptDecision(input.priorDelivery, input.incoming);
  if (receipt !== "apply") return receipt;
  if (!input.incomingStagingDigest) return "apply";
  if (!input.existingStagingDigest) return "needs_attention";
  return input.existingStagingDigest === input.incomingStagingDigest ? "reuse_intent" : "needs_attention";
}

export function cjTrackingMappingDecision(input: { order?: { siteId: unknown; cjOrderId?: string } | null; siteId: unknown; incomingCjOrderId?: string }): "apply" | "ignore" {
  if (!input.order || input.order.siteId !== input.siteId) return "ignore";
  if (input.incomingCjOrderId && input.order.cjOrderId && input.incomingCjOrderId !== input.order.cjOrderId) return "ignore";
  return "apply";
}
