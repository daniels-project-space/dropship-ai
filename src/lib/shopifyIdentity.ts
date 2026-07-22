export const SHOPIFY_TOKEN_KEY = "SHOPIFY_ADMIN_TOKEN";
export const SHOPIFY_VAULT_SERVICE = "shopify";

export function normalizeShopifyDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

export function isMyshopifyDomain(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(value);
}

/** Derive the vault key name for a store domain: calm-collar.myshopify.com -> CALM_COLLAR. */
export function vaultKeyForDomain(shopifyDomain: string): string {
  return shopifyDomain
    .replace(/\.myshopify\.com$/i, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function vaultRefForDomain(shopifyDomain: string): string {
  return `${SHOPIFY_VAULT_SERVICE}/${vaultKeyForDomain(shopifyDomain)}`;
}

export function assertShopifyIdentity(expectedDomain: string, actualDomain: string, currencyCode: string): void {
  if (normalizeShopifyDomain(actualDomain) !== normalizeShopifyDomain(expectedDomain)) {
    throw new Error("validated Shopify store identity does not match the connected myshopify domain");
  }
  if (currencyCode !== "USD") {
    throw new Error(`Shopify store currency ${currencyCode} is unsupported; this launch requires USD until currency conversion is implemented`);
  }
}
