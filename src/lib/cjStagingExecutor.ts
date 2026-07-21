/** Runtime-neutral orchestration for the durable CJ staging worker. */
export type CjPreflightClaim =
  | { state: "busy" | "complete" }
  | { state: "quoted" }
  | { state: "preflight"; attempt: number; quoteInputDigest: string; fromCountryCode: string; destinationCountryCode: string; shippingZip: string; products: Array<{ vid: string; quantity: number }> };

export interface CjStagingDependencies {
  claimPreflight(): Promise<CjPreflightClaim>;
  quote(input: { fromCountryCode: string; destinationCountryCode: string; shippingZip: string; products: Array<{ vid: string; quantity: number }> }): Promise<{ logisticName: string; logisticPriceUsd: number }>;
  recordQuote(input: { attempt: number; quoteInputDigest: string; logisticName: string; logisticPriceUsd: number; fromCountryCode: string }): Promise<void>;
  stage(): Promise<{ state: "staged" | "reused" | "preflight_required" | "needs_attention"; actionId?: string }>;
  claimApproval(): Promise<{ state: "dispatch" | "busy" | "reused"; actionId?: string; approvalDispatchKey?: string }>;
  beginApproval(input: { actionId: string; approvalDispatchKey: string }): Promise<{ status: "dispatching" | "dispatched" | "resolved" }>;
  triggerApproval(input: { actionId: string; approvalDispatchKey: string }): Promise<void>;
  recordApproval(input: { actionId: string }): Promise<void>;
}

export async function executeCjStaging(deps: CjStagingDependencies) {
  const claimed = await deps.claimPreflight();
  if (claimed.state === "busy" || claimed.state === "complete") return { state: claimed.state };
  if (claimed.state === "preflight") {
    const quote = await deps.quote({ fromCountryCode: claimed.fromCountryCode, destinationCountryCode: claimed.destinationCountryCode, shippingZip: claimed.shippingZip, products: claimed.products });
    await deps.recordQuote({ attempt: claimed.attempt, quoteInputDigest: claimed.quoteInputDigest, logisticName: quote.logisticName, logisticPriceUsd: quote.logisticPriceUsd, fromCountryCode: claimed.fromCountryCode });
  }
  const staged = await deps.stage();
  if (staged.state === "preflight_required" || !staged.actionId) return { state: staged.state };
  const approval = await deps.claimApproval();
  if (approval.state !== "dispatch" || !approval.actionId || !approval.approvalDispatchKey) return { state: approval.state };
  const began = await deps.beginApproval({ actionId: approval.actionId, approvalDispatchKey: approval.approvalDispatchKey });
  if (began.status === "resolved") return { state: "resolved" as const };
  if (began.status === "dispatching") await deps.triggerApproval({ actionId: approval.actionId, approvalDispatchKey: approval.approvalDispatchKey });
  // A resolved/rejected action is never marked as dispatched or armed by a stale worker.
  await deps.recordApproval({ actionId: approval.actionId });
  return { state: "approval_dispatched" as const, actionId: approval.actionId };
}
