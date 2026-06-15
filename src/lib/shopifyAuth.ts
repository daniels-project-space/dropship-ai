// Resolve a usable Shopify Admin config { shop, accessToken } for a site.
//
//  shop        = the site's `shopifyDomain` (read from Convex).
//  accessToken = `overrideToken` when supplied (first-connect flow, token comes from the request),
//                ELSE the site's siteSecrets row for key "SHOPIFY_ADMIN_TOKEN" → its `vaultRef`
//                ("shopify/<KEY>") → vault.getKey("shopify", "<KEY>").
//
// Throws a clear, UI-friendly error whenever no token is resolvable so the operator is prompted to
// (re)connect the store. Server-only (imports the vault) — never bundle into a client component.
import { convexClient, api } from "./convexClient";
import { getKey } from "./vault";
import type { ShopifyClientConfig } from "./shopify";
import type { Id } from "../../convex/_generated/dataModel";

export const SHOPIFY_TOKEN_KEY = "SHOPIFY_ADMIN_TOKEN";
export const SHOPIFY_VAULT_SERVICE = "shopify";

/** Derive the vault key name for a store domain: "calm-collar.myshopify.com" → "CALM_COLLAR". */
export function vaultKeyForDomain(shopifyDomain: string): string {
  return shopifyDomain
    .replace(/\.myshopify\.com$/i, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** The vaultRef string we persist in siteSecrets for a domain, e.g. "shopify/CALM_COLLAR". */
export function vaultRefForDomain(shopifyDomain: string): string {
  return `${SHOPIFY_VAULT_SERVICE}/${vaultKeyForDomain(shopifyDomain)}`;
}

export async function resolveShopifyConfig(
  siteId: string,
  overrideToken?: string,
): Promise<ShopifyClientConfig> {
  const convex = convexClient();
  const site = await convex.query(api.sites.get, { siteId: siteId as Id<"sites"> });
  if (!site) throw new Error(`resolveShopifyConfig: site ${siteId} not found`);
  if (!site.shopifyDomain) {
    throw new Error("Shopify store is not connected for this site — connect a store first.");
  }
  const shop = site.shopifyDomain;

  if (overrideToken) {
    return { shop, accessToken: overrideToken };
  }

  // Follow the siteSecrets pointer → vault.
  const vaultRef = await convex.query(api.siteSecrets.getRef, {
    siteId: siteId as Id<"sites">,
    key: SHOPIFY_TOKEN_KEY,
  });
  if (!vaultRef) {
    throw new Error(
      "No Shopify token registered for this site. Reconnect the store (the token is stored in the vault for recurring sync).",
    );
  }
  const [service, keyName] = vaultRef.split("/");
  if (!service || !keyName) {
    throw new Error(`Malformed Shopify vaultRef "${vaultRef}" (expected "shopify/<KEY>").`);
  }
  const token = await getKey(service, keyName);
  if (!token) {
    throw new Error(
      `Shopify token missing from vault (${vaultRef}). Add it to vault service "${service}" key "${keyName}".`,
    );
  }
  return { shop, accessToken: token };
}
