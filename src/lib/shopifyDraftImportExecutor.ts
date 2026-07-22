/**
 * The small execution state machine behind the route handler. Keeping the provider boundary
 * explicit makes it impossible for a configuration/reservation failure to be mislabeled as an
 * ambiguous Shopify write.
 */
export interface DraftImportPreflight<TProduct, TConfig> {
  product: TProduct;
  config: TConfig;
}

export async function executeApprovedShopifyDraftImport<TProduct extends { title: string }, TConfig>(
  dependencies: {
    preflight: () => Promise<DraftImportPreflight<TProduct, TConfig>>;
    reserve: () => Promise<{ status: "reserved" } | { status: "already_created"; shopifyProductId?: string }>;
    createDraft: (config: TConfig, product: TProduct) => Promise<{ id: string; title: string; variantId: string }>;
    complete: (shopifyProductId: string, shopifyVariantId: string) => Promise<void>;
    markAmbiguous: (error: string) => Promise<void>;
  },
): Promise<{ ok: true; reused?: boolean; shopifyProductId?: string; title?: string; status?: "DRAFT" } | { ok: false; error: string; reconcileRequired: boolean }> {
  let ready: DraftImportPreflight<TProduct, TConfig>;
  try {
    ready = await dependencies.preflight();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Shopify draft import preflight failed", reconcileRequired: false };
  }
  try {
    const reservation = await dependencies.reserve();
    if (reservation.status === "already_created") {
      return { ok: true, reused: true, shopifyProductId: reservation.shopifyProductId };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Shopify draft import reservation failed", reconcileRequired: false };
  }
  try {
    const created = await dependencies.createDraft(ready.config, ready.product);
    await dependencies.complete(created.id, created.variantId);
    return { ok: true, shopifyProductId: created.id, title: created.title, status: "DRAFT" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shopify draft import failed";
    try {
      await dependencies.markAmbiguous(message);
    } catch {
      // The request was already reserved; return the provider ambiguity even if recording fails.
    }
    return { ok: false, error: message, reconcileRequired: true };
  }
}
