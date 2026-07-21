/**
 * Normalize the small, decision-relevant portion of CJ's read responses. Raw provider payloads
 * are intentionally not accepted at the catalog boundary: a product can only inherit the facts
 * this parser extracted from a server-side CJ read.
 */
export interface ParsedCjEvidence {
  cjProductId: string;
  cjVariantId: string;
  title: string;
  cogsUsd?: number;
  shippingUsd?: number;
  inventoryQty: number;
  fromUsWarehouse: boolean;
  inventoryVerified: boolean;
  sourceUrl: string;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    const parsed = record(item);
    return parsed ? [parsed] : [];
  }) : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function money(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function quantity(value: unknown): number {
  const parsed = money(value);
  return parsed === undefined ? 0 : Math.max(0, Math.floor(parsed));
}

function inventoryRows(...sources: unknown[]): UnknownRecord[] {
  return sources.flatMap((source) => {
    const sourceRecord = record(source);
    return records(source).concat(records(sourceRecord?.inventories));
  });
}

/**
 * Extract one exact US variant. CJ documents `variantSellPrice` as USD and exposes warehouse
 * country, verified status and total inventory on the variant/inventory read responses.
 * Shipping is known only when CJ explicitly marks the product free-shipping; every other case is
 * deliberately preserved as unknown so it cannot silently become a zero-cost assumption.
 */
export function parseCjEvidence(input: {
  productId: string;
  variantId: string;
  product: unknown;
  variants: unknown;
  inventory: unknown;
  variant: unknown;
  variantInventory: unknown;
}): ParsedCjEvidence {
  const product = record(input.product) ?? {};
  const variant = record(input.variant) ?? {};
  // `product/query?countryCode=US` returns the eligible variant records directly on product.
  // Keep the separately supplied list for the legacy read-only refresh path.
  const variants = records(input.variants).concat(records(product.variants));
  const listedVariant = variants.find((candidate) => string(candidate.vid) === input.variantId) ?? {};
  const title = string(product.productNameEn) ?? string(product.nameEn) ?? string(product.productName) ?? "CJ product";
  const cogsUsd = money(variant.variantSellPrice) ?? money(listedVariant.variantSellPrice) ?? money(product.sellPrice);
  // Product-level inventory queries can contain every variant. Only their rows explicitly tied
  // to the selected vid are safe to use; inventories nested under the selected variant are
  // already exact and do not carry a vid in CJ's documented Product Details shape.
  // queryByVid is exact even when a provider row omits vid; product-level inventory is not.
  const externalInventory = inventoryRows(input.variantInventory)
    .concat(inventoryRows(input.inventory).filter((row) => string(row.vid) === input.variantId));
  const usInventory = inventoryRows(variant, listedVariant).concat(externalInventory)
    .filter((row) => string(row.countryCode)?.toUpperCase() === "US");
  const inventoryQty = usInventory.reduce((total, row) => total + quantity(row.totalInventoryNum ?? row.totalInventory ?? row.storageNum), 0);
  const inventoryVerified = usInventory.some((row) => row.verifiedWarehouse === 1 || row.verifiedWarehouse === "1");
  const freeShipping = product.isFreeShipping === true || product.addMarkStatus === 1 || product.addMarkStatus === "1";
  return {
    cjProductId: input.productId,
    cjVariantId: input.variantId,
    title,
    ...(cogsUsd !== undefined && cogsUsd > 0 ? { cogsUsd } : {}),
    ...(freeShipping ? { shippingUsd: 0 } : {}),
    inventoryQty,
    fromUsWarehouse: usInventory.length > 0,
    inventoryVerified,
    sourceUrl: `https://developers.cjdropshipping.com/api2.0/v1/product/query?pid=${encodeURIComponent(input.productId)}`,
  };
}
