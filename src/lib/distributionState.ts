// Pure distribution state decisions.  Keeping these independent of Convex and Trigger lets us
// exercise the crash boundaries without pretending a provider receipt exists.
export type DistributionDispatchStatus = "pending" | "dispatching" | "dispatched" | "delivered" | "reconcile_required";
export type DistributionOutboxStatus = "pending" | "processing" | "delivered" | "failed" | "ambiguous";

export function dispatchTriggerDecision(status: DistributionDispatchStatus): "trigger" | "already_dispatched" | "reconcile_required" {
  if (status === "pending") return "trigger";
  if (status === "reconcile_required") return "reconcile_required";
  return "already_dispatched";
}

/** A provider call is allowed only before its durable attempt fence is raised. */
export function providerDeliveryDecision(status: DistributionOutboxStatus): "deliver" | "already_delivered" | "reconcile_required" {
  if (status === "pending") return "deliver";
  if (status === "delivered") return "already_delivered";
  // `processing` means a worker may have crossed the provider boundary before crashing.
  // Reposting would be unsafe; an ambiguous response is handled the same way.
  return "reconcile_required";
}

export function missingReceiptPlatforms(requested: readonly string[], postIds: Record<string, string>): string[] {
  return requested.filter((platform) => !postIds[platform]);
}
