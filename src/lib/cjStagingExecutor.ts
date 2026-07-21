/** Runtime-neutral orchestration for the durable CJ staging worker. */
export type CjPreflightClaim =
  | { state: "busy" | "complete" | "staged" | "needs_attention" }
  | { state: "quoted"; attempt: number; leaseGeneration: number }
  | { state: "preflight"; attempt: number; leaseGeneration: number; quoteInputDigest: string; fromCountryCode: string; destinationCountryCode: string; shippingZip: string; products: Array<{ vid: string; quantity: number }> };

export interface CjStagingDependencies {
  claimPreflight(): Promise<CjPreflightClaim>;
  quote(input: { fromCountryCode: string; destinationCountryCode: string; shippingZip: string; products: Array<{ vid: string; quantity: number }> }): Promise<{ logisticName: string; logisticPriceUsd: number }>;
  recordQuote(input: { attempt: number; leaseGeneration: number; quoteInputDigest: string; logisticName: string; logisticPriceUsd: number; fromCountryCode: string }): Promise<{ ignored?: boolean } | void>;
  stage(): Promise<{ state: "staged" | "reused" | "preflight_required" | "needs_attention"; actionId?: string }>;
  claimApproval(): Promise<{ state: "dispatch" | "busy" | "reused" | "resolved" | "needs_attention"; actionId?: string; approvalDispatchKey?: string; leaseGeneration?: number; attempt?: number }>;
  beginApproval(input: { actionId: string; approvalDispatchKey: string }): Promise<{ status: "dispatching" | "dispatched" | "resolved"; approvalRunId?: string }>;
  triggerApproval(input: { actionId: string; approvalDispatchKey: string }): Promise<string>;
  recordApproval(input: { actionId: string; approvalDispatchKey: string; approvalRunId: string; leaseGeneration: number }): Promise<{ ignored?: boolean; state?: "resolved" | "approval_dispatched" } | void>;
  resolveApproval(input: { actionId: string; approvalDispatchKey: string; leaseGeneration: number }): Promise<{ ignored?: boolean } | void>;
}

export async function executeCjStaging(deps: CjStagingDependencies) {
  const claimed = await deps.claimPreflight();
  if (claimed.state === "busy" || claimed.state === "complete" || claimed.state === "needs_attention") return { state: claimed.state };
  if (claimed.state === "preflight") {
    const quote = await deps.quote({ fromCountryCode: claimed.fromCountryCode, destinationCountryCode: claimed.destinationCountryCode, shippingZip: claimed.shippingZip, products: claimed.products });
    const recordedQuote = await deps.recordQuote({ attempt: claimed.attempt, leaseGeneration: claimed.leaseGeneration, quoteInputDigest: claimed.quoteInputDigest, logisticName: quote.logisticName, logisticPriceUsd: quote.logisticPriceUsd, fromCountryCode: claimed.fromCountryCode });
    if (recordedQuote && recordedQuote.ignored) return { state: "stale" as const };
  }
  // `staged` is a durable crash boundary.  Do not restage/rewrite its generation; resume its
  // exact approval-dispatch key instead.
  const staged = claimed.state === "staged" ? { state: "staged" as const, actionId: undefined } : await deps.stage();
  if (staged.state === "preflight_required") return { state: staged.state };
  const approval = await deps.claimApproval();
  if (approval.state !== "dispatch" || !approval.actionId || !approval.approvalDispatchKey || approval.leaseGeneration === undefined) return { state: approval.state };
  const began = await deps.beginApproval({ actionId: approval.actionId, approvalDispatchKey: approval.approvalDispatchKey });
  if (began.status === "resolved") {
    await deps.resolveApproval({ actionId: approval.actionId, approvalDispatchKey: approval.approvalDispatchKey, leaseGeneration: approval.leaseGeneration });
    return { state: "resolved" as const };
  }
  const approvalRunId = began.status === "dispatching"
    ? await deps.triggerApproval({ actionId: approval.actionId, approvalDispatchKey: approval.approvalDispatchKey })
    : began.approvalRunId;
  // A resolved/rejected action is never marked as dispatched or armed by a stale worker.
  if (!approvalRunId) throw new Error("approval dispatch lost its durable run lineage");
  const recordedApproval = await deps.recordApproval({ actionId: approval.actionId, approvalDispatchKey: approval.approvalDispatchKey, approvalRunId, leaseGeneration: approval.leaseGeneration });
  if (recordedApproval && recordedApproval.ignored) return { state: "stale" as const };
  return { state: recordedApproval && recordedApproval.state === "resolved" ? "resolved" as const : "approval_dispatched" as const, actionId: approval.actionId };
}
