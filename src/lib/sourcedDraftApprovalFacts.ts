export type SourcedDraftApprovalFacts = {
  title: string;
  cjProductId: string;
  cjVariantId: string;
  evidenceReadAt: number;
  inventoryQty: number;
  cogsUsd: number;
  shippingUsd: number;
  landedCostUsd: number;
  priceUsd: number;
  contributionMarginPct: number;
};

/** Only render approval facts when every decision-critical server-derived field is present. */
export function sourcedDraftApprovalFacts(type: string, params: unknown): SourcedDraftApprovalFacts | null {
  if (type !== "import_sourced_product" || typeof params !== "object" || params === null) return null;
  const value = params as Record<string, unknown>;
  const string = (key: string) => typeof value[key] === "string" && value[key].trim() ? value[key] : null;
  const number = (key: string) => typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : null;
  const title = string("title"); const cjProductId = string("cjProductId"); const cjVariantId = string("cjVariantId");
  const evidenceReadAt = number("evidenceReadAt"); const inventoryQty = number("inventoryQty"); const cogsUsd = number("cogsUsd"); const shippingUsd = number("shippingUsd"); const landedCostUsd = number("landedCostUsd"); const priceUsd = number("priceUsd"); const contributionMarginPct = number("contributionMarginPct");
  return title !== null && cjProductId !== null && cjVariantId !== null && evidenceReadAt !== null && inventoryQty !== null && cogsUsd !== null && shippingUsd !== null && landedCostUsd !== null && priceUsd !== null && contributionMarginPct !== null
    ? { title, cjProductId, cjVariantId, evidenceReadAt, inventoryQty, cogsUsd, shippingUsd, landedCostUsd, priceUsd, contributionMarginPct }
    : null;
}
