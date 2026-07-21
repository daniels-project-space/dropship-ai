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

function products(value: unknown): Row[] {
  const root = row(value);
  return rows(value).concat(rows(root?.content), rows(root?.list), rows(root?.records), rows(root?.data));
}

function inventoryFor(variantId: string, sources: unknown[]): number | null {
  const inventory = sources.flatMap((source) => {
    const root = row(source);
    return rows(source).concat(rows(root?.inventories), rows(root?.list), rows(root?.content));
  }).filter((entry) => text(entry.vid) === variantId && text(entry.countryCode)?.toUpperCase() === "US");
  if (!inventory.length) return null;
  return inventory.reduce((total, entry) => total + Math.floor(amount(entry.totalInventoryNum ?? entry.totalInventory ?? entry.storageNum) ?? 0), 0);
}

/** Do not infer shipping: CJ must explicitly identify it as free before zero is displayed. */
export function normalizeCjCatalogueSearch(search: unknown, details: Array<{ productId: string; variants: unknown; inventory: unknown }>): CjCatalogueResult[] {
  const byId = new Map(details.map((detail) => [detail.productId, detail]));
  return products(search).flatMap((product) => {
    const cjProductId = text(product.pid) ?? text(product.productId) ?? text(product.id);
    if (!cjProductId) return [];
    const detail = byId.get(cjProductId);
    const variants = rows(detail?.variants).filter((variant) => text(variant.countryCode)?.toUpperCase() === "US" || text(variant.warehouseCountryCode)?.toUpperCase() === "US").flatMap((variant) => {
      const cjVariantId = text(variant.vid) ?? text(variant.variantId);
      if (!cjVariantId) return [];
      const cogsUsd = amount(variant.variantSellPrice ?? variant.sellPrice);
      const freeShipping = product.isFreeShipping === true || product.addMarkStatus === 1 || product.addMarkStatus === "1";
      return [{ cjVariantId, label: text(variant.variantNameEn) ?? text(variant.variantName) ?? cjVariantId, inventoryQty: inventoryFor(cjVariantId, [detail?.inventory, detail?.variants]), cogsUsd: cogsUsd && cogsUsd > 0 ? cogsUsd : null, shippingUsd: freeShipping ? 0 : null }];
    });
    return [{ cjProductId, title: text(product.productNameEn) ?? text(product.productName) ?? text(product.nameEn) ?? "CJ product", variants }];
  });
}
