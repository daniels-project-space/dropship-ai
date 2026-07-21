/** Pure validation shared by Convex's Shopify-order mapping path and its behavior tests. */
export function hasVerifiedShopifyCjLineage(input: {
  siteId: unknown;
  line: { productId: string; variantId: string };
  product?: { siteId: unknown; shopifyProductId?: string; shopifyVariantId?: string; shopifyDraftImportStatus?: string; cjEvidenceId?: unknown; cjProductId?: string; cjVariantId?: string; cjFromCountryCode?: string } | null;
  evidence?: { siteId: unknown; cjProductId: string; cjVariantId: string; fromCountryCode?: string } | null;
}): boolean {
  const { product, evidence, line, siteId } = input;
  return !!product && !!evidence
    && product.siteId === siteId
    && product.shopifyProductId === line.productId
    && product.shopifyVariantId === line.variantId
    && product.shopifyDraftImportStatus === "created"
    && !!product.cjEvidenceId
    && !!product.cjProductId
    && !!product.cjVariantId
    && !!product.cjFromCountryCode
    && evidence.siteId === siteId
    && evidence.cjProductId === product.cjProductId
    && evidence.cjVariantId === product.cjVariantId
    && evidence.fromCountryCode === product.cjFromCountryCode;
}
