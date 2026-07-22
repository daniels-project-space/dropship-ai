/** A provider ID is reusable only when this application recorded its completed DRAFT import. */
export function hasVerifiedInternalShopifyDraftLineage(input: {
  shopifyProductId?: string;
  shopifyDraftImportStatus?: string;
  trace?: { operation: string; status: string; detail: unknown } | null;
}): boolean {
  const detail = input.trace?.detail;
  return input.shopifyDraftImportStatus === "created"
    && !!input.shopifyProductId
    && input.trace?.operation === "shopify.product.create_draft"
    && input.trace.status === "succeeded"
    && typeof detail === "object"
    && detail !== null
    && (detail as Record<string, unknown>).shopifyProductId === input.shopifyProductId;
}
