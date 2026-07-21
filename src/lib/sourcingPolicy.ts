import { calculateLandedEconomics, evaluateSourcedDraftGate, type LandedEconomics, type SourcedDraftGateResult } from "./economics";

/** Server-owned commercial assumptions. Browser/API callers cannot substitute cost values. */
export const SOURCING_POLICY = {
  paymentFeeRate: 0.029,
  paymentFixedFeeUsd: 0.3,
  refundReserveRate: 0.1,
  contentCostUsd: 5,
} as const;

export interface VerifiedCjCostEvidence {
  cogsUsd?: number;
  shippingUsd?: number;
  fromUsWarehouse: boolean;
  inventoryVerified: boolean;
  mediaUrl?: string;
}

/** The immutable CJ read fields required whenever a candidate can move state. */
export interface PersistedCjEvidence extends VerifiedCjCostEvidence {
  inventoryQty: number;
  readAt: number;
}

export interface SourcedDraftPolicy {
  priceUsd: number;
  minimumPriceUsd: number;
  minimumMarginPct: number;
  now?: number;
}

export function deriveCjEconomics(evidence: VerifiedCjCostEvidence, priceUsd: number): LandedEconomics {
  if (!evidence.fromUsWarehouse || !evidence.inventoryVerified) {
    throw new Error("verified US-warehouse inventory is required");
  }
  if (evidence.cogsUsd === undefined || evidence.shippingUsd === undefined) {
    throw new Error("CJ evidence has unknown COGS or shipping cost");
  }
  return calculateLandedEconomics({
    priceUsd,
    cogsUsd: evidence.cogsUsd,
    shippingUsd: evidence.shippingUsd,
    dutyUsd: 0, // US-warehouse stock; any non-US / unknown duty path is denied above.
    paymentFeeUsd: (priceUsd * SOURCING_POLICY.paymentFeeRate) + SOURCING_POLICY.paymentFixedFeeUsd,
    refundReserveUsd: priceUsd * SOURCING_POLICY.refundReserveRate,
    contentCostUsd: SOURCING_POLICY.contentCostUsd,
  });
}

/**
 * Replay the exact source/economics decision from the persisted CJ read. This is deliberately
 * used at draft creation, activation, and Shopify import so an approval cannot outlive a stale
 * quote or use browser-supplied costs.
 */
export function evaluatePersistedCjEvidence(
  evidence: PersistedCjEvidence,
  policy: SourcedDraftPolicy,
): SourcedDraftGateResult {
  if (!evidence.mediaUrl) return { eligible: false, reason: "CJ evidence has no verified product media" };
  let economics: LandedEconomics;
  try {
    economics = deriveCjEconomics(evidence, policy.priceUsd);
  } catch (error) {
    return { eligible: false, reason: error instanceof Error ? error.message : "invalid CJ cost evidence" };
  }
  return evaluateSourcedDraftGate({
    priceUsd: policy.priceUsd,
    cogsUsd: economics.cogsUsd,
    shippingUsd: economics.shippingUsd,
    dutyUsd: economics.dutyUsd,
    paymentFeeUsd: economics.paymentFeeUsd,
    refundReserveUsd: economics.refundReserveUsd,
    contentCostUsd: economics.contentCostUsd,
    minimumPriceUsd: policy.minimumPriceUsd,
    minimumMarginPct: policy.minimumMarginPct,
    inventoryQty: evidence.inventoryQty,
    fromUsWarehouse: evidence.fromUsWarehouse && evidence.inventoryVerified,
    sourceVerifiedAt: evidence.readAt,
    now: policy.now,
  });
}
