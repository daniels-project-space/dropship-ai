/**
 * Contribution economics for a single sale in USD. Every cost is explicit so a product cannot
 * pass the margin gate by silently omitting duties, processor fees, refund reserve, or content.
 */
export interface LandedEconomicsInput {
  priceUsd: number;
  cogsUsd: number;
  shippingUsd: number;
  dutyUsd: number;
  paymentFeeUsd: number;
  refundReserveUsd: number;
  contentCostUsd: number;
}

export interface LandedEconomics extends LandedEconomicsInput {
  landedCostUsd: number;
  totalCostUsd: number;
  contributionUsd: number;
  contributionMarginPct: number;
}

function validMoney(value: number, name: string, positive = false): void {
  if (!Number.isFinite(value) || (positive ? value <= 0 : value < 0)) {
    throw new Error(`economics: ${name} must be a finite ${positive ? "positive" : "non-negative"} USD amount`);
  }
}

export function calculateLandedEconomics(input: LandedEconomicsInput): LandedEconomics {
  validMoney(input.priceUsd, "priceUsd", true);
  validMoney(input.cogsUsd, "cogsUsd", true);
  validMoney(input.shippingUsd, "shippingUsd");
  validMoney(input.dutyUsd, "dutyUsd");
  validMoney(input.paymentFeeUsd, "paymentFeeUsd");
  validMoney(input.refundReserveUsd, "refundReserveUsd");
  validMoney(input.contentCostUsd, "contentCostUsd");
  const landedCostUsd = input.cogsUsd + input.shippingUsd + input.dutyUsd;
  const totalCostUsd = landedCostUsd + input.paymentFeeUsd + input.refundReserveUsd + input.contentCostUsd;
  const contributionUsd = input.priceUsd - totalCostUsd;
  return {
    ...input,
    landedCostUsd,
    totalCostUsd,
    contributionUsd,
    contributionMarginPct: (contributionUsd / input.priceUsd) * 100,
  };
}

export function clearsMarginFloor(input: LandedEconomicsInput, floorPct: number): boolean {
  if (!Number.isFinite(floorPct) || floorPct < 0 || floorPct > 100) throw new Error("economics: margin floor must be between 0 and 100");
  return calculateLandedEconomics(input).contributionMarginPct >= floorPct;
}

export interface SourcedDraftGateInput extends LandedEconomicsInput {
  minimumPriceUsd: number;
  minimumMarginPct: number;
  inventoryQty: number;
  fromUsWarehouse: boolean;
  sourceVerifiedAt: number;
  now?: number;
}

export type SourcedDraftGateResult =
  | { eligible: true; economics: LandedEconomics }
  | { eligible: false; reason: string; economics?: LandedEconomics };

/** Pure, deterministic policy used at the catalog write boundary and in regression tests. */
export function evaluateSourcedDraftGate(input: SourcedDraftGateInput): SourcedDraftGateResult {
  const now = input.now ?? Date.now();
  if (!input.fromUsWarehouse) return { eligible: false, reason: "US warehouse inventory is required" };
  if (!Number.isFinite(input.inventoryQty) || input.inventoryQty <= 0) return { eligible: false, reason: "positive verified inventory is required" };
  if (!Number.isFinite(input.sourceVerifiedAt) || input.sourceVerifiedAt > now + 5 * 60_000 || now - input.sourceVerifiedAt > 24 * 60 * 60 * 1000) {
    return { eligible: false, reason: "CJ source evidence must be less than 24 hours old" };
  }
  if (!Number.isFinite(input.minimumPriceUsd) || input.minimumPriceUsd < 0) return { eligible: false, reason: "invalid minimum price policy" };
  if (!Number.isFinite(input.minimumMarginPct) || input.minimumMarginPct < 0 || input.minimumMarginPct > 100) return { eligible: false, reason: "invalid minimum margin policy" };
  if (!Number.isFinite(input.priceUsd) || input.priceUsd < input.minimumPriceUsd) return { eligible: false, reason: "price is below the site's minimum kit price" };
  let economics: LandedEconomics;
  try {
    economics = calculateLandedEconomics(input);
  } catch (error) {
    return { eligible: false, reason: error instanceof Error ? error.message : "invalid landed economics" };
  }
  if (economics.contributionMarginPct < input.minimumMarginPct) {
    return { eligible: false, reason: "contribution margin is below the site's floor", economics };
  }
  return { eligible: true, economics };
}
