/** Exact immutable facts that bind a human approval to one local CJ-derived draft. */
export function actionMatchesApprovedDraftImport(
  action: { siteId: unknown; type: string; riskTier: string; status: string; params: unknown },
  product: { siteId: unknown; _id: unknown; cjEvidenceId?: unknown; cjProductId?: unknown; cjVariantId?: unknown; priceUsd: number; cogsUsd: number; shippingUsd: number; landedCostUsd?: number; contributionMarginPct?: number; sourceVerifiedAt?: number },
): boolean {
  if (action.siteId !== product.siteId || action.type !== "import_sourced_product" || action.riskTier !== "human_gated" || action.status !== "approved") return false;
  const params = action.params;
  return typeof params === "object" && params !== null
    && (params as Record<string, unknown>).productId === product._id
    && (params as Record<string, unknown>).evidenceId === product.cjEvidenceId
    && (params as Record<string, unknown>).cjProductId === product.cjProductId
    && (params as Record<string, unknown>).cjVariantId === product.cjVariantId
    && (params as Record<string, unknown>).priceUsd === product.priceUsd
    && (params as Record<string, unknown>).cogsUsd === product.cogsUsd
    && (params as Record<string, unknown>).shippingUsd === product.shippingUsd
    && (params as Record<string, unknown>).landedCostUsd === product.landedCostUsd
    && (params as Record<string, unknown>).contributionMarginPct === product.contributionMarginPct
    // Approval cards label this immutable CJ read timestamp evidenceReadAt. Product storage
    // calls the same timestamp sourceVerifiedAt; they intentionally must match exactly.
    && (params as Record<string, unknown>).evidenceReadAt === product.sourceVerifiedAt;
}

/** Trace identity is reserved before Shopify is contacted and survives either terminal result. */
export function shopifyDraftTraceDetail(input: {
  actionId: unknown;
  evidenceId: unknown;
  requestId?: unknown;
  cjProductId: unknown;
  cjVariantId: unknown;
  productId: unknown;
}): Record<string, unknown> {
  return { ...input, published: false };
}
