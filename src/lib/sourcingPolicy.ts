import { calculateLandedEconomics, type LandedEconomics } from "./economics";

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
