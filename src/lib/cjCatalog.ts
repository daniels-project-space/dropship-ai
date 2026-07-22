/** Read-only, deliberately small normalization layer for CJ catalogue search responses. */
export type CjCatalogueVariant = {
  cjVariantId: string;
  label: string;
  inventoryQty: number | null;
  cogsUsd: number | null;
  shippingUsd: number | null;
};

export type CjCatalogueResult = { cjProductId: string; title: string; variants: CjCatalogueVariant[] };

type Row = Record<string, unknown>;
const row = (value: unknown): Row | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : undefined;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.flatMap((item) => row(item) ? [row(item)!] : []) : [];
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const amount = (value: unknown): number | undefined => {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
};

/** CJ listV2 returns `content` grouping records, each with a `productList`. */
export function cjCatalogueSearchProducts(value: unknown): Row[] {
  const root = row(value);
  const data = row(root?.data);
  const containers = [root, data].filter((candidate): candidate is Row => !!candidate);
  const groups = containers.flatMap((container) => rows(container.content).concat(rows(container.list), rows(container.records)));
  return groups.flatMap((group) => {
    const nested = rows(group.productList);
    if (nested.length) return nested;
    // Retain the older list shape for a safe read-only fallback, but never mistake a listV2
    // grouping object for a product.
    return text(group.pid) || text(group.productId) || text(group.id) ? [group] : [];
  });
}

function inventoryFor(variantId: string, sources: unknown[]): number | null {
  const inventory = sources.flatMap((source) => {
    const root = row(source);
    return rows(source).concat(rows(root?.inventories), rows(root?.list), rows(root?.content));
  }).filter((entry) => (text(entry.vid) === variantId || !text(entry.vid)) && text(entry.countryCode)?.toUpperCase() === "US");
  if (!inventory.length) return null;
  return inventory.reduce((total, entry) => total + Math.floor(amount(entry.totalInventoryNum ?? entry.totalInventory ?? entry.storageNum) ?? 0), 0);
}

/** Do not infer shipping: CJ must explicitly identify it as free before zero is displayed. */
export function normalizeCjCatalogueSearch(search: unknown, details: Array<{ productId: string; product: unknown }>): CjCatalogueResult[] {
  const byId = new Map(details.map((detail) => [detail.productId, detail]));
  return cjCatalogueSearchProducts(search).flatMap((product) => {
    const cjProductId = text(product.pid) ?? text(product.productId) ?? text(product.id);
    if (!cjProductId) return [];
    const detail = byId.get(cjProductId);
    const detailProduct = row(detail?.product);
    // Product Details with countryCode=US returns only US-stocked variants.  Variant records
    // themselves do not carry a country field, so eligibility is derived from their documented
    // inventory rows instead of an invented variant.countryCode property.
    const variants = rows(detailProduct?.variants).flatMap((variant) => {
      const cjVariantId = text(variant.vid) ?? text(variant.variantId);
      if (!cjVariantId) return [];
      const cogsUsd = amount(variant.variantSellPrice ?? variant.sellPrice);
      const freeShipping = product.isFreeShipping === true || product.addMarkStatus === 1 || product.addMarkStatus === "1";
      const inventoryQty = inventoryFor(cjVariantId, [variant]);
      return inventoryQty === null ? [] : [{ cjVariantId, label: text(variant.variantNameEn) ?? text(variant.variantName) ?? cjVariantId, inventoryQty, cogsUsd: cogsUsd && cogsUsd > 0 ? cogsUsd : null, shippingUsd: freeShipping ? 0 : null }];
    });
    return [{ cjProductId, title: text(product.productNameEn) ?? text(product.productName) ?? text(product.nameEn) ?? "CJ product", variants }];
  });
}
