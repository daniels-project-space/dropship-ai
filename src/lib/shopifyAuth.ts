// Resolve a usable Shopify Admin config { shop, accessToken } for a site.
//
//  shop        = the site's `shopifyDomain` (read from Convex).
//  accessToken = the site's siteSecrets row for key "SHOPIFY_ADMIN_TOKEN" → its `vaultRef`
//                ("shopify/<KEY>") → vault.getKey("shopify", "<KEY>").
//
// Throws a clear, UI-friendly error whenever no token is resolvable so the operator is prompted to
// (re)connect the store. Server-only (imports the vault) — never bundle into a client component.
import { convexClient, api } from "./convexClient";
import { getKey } from "./vault";
import type { ShopifyClientConfig } from "./shopify";
import type { Id } from "../../convex/_generated/dataModel";
import { createHash, timingSafeEqual } from "node:crypto";
import { SHOPIFY_TOKEN_KEY, SHOPIFY_VAULT_SERVICE, vaultKeyForDomain, vaultRefForDomain } from "./shopifyIdentity";

export { SHOPIFY_TOKEN_KEY, SHOPIFY_VAULT_SERVICE, vaultKeyForDomain, vaultRefForDomain };

/** Prove the deterministic recurring-access reference already resolves to the supplied token. */
export async function verifyShopifyVaultToken(shopifyDomain: string, operatorToken: string): Promise<string | null> {
  const durable = await getKey(SHOPIFY_VAULT_SERVICE, vaultKeyForDomain(shopifyDomain)).catch(() => null);
  if (!durable) return null;
  // Hashing first gives timingSafeEqual fixed-size inputs even when token lengths differ.
  const expected = createHash("sha256").update(durable).digest();
  const supplied = createHash("sha256").update(operatorToken).digest();
  return timingSafeEqual(expected, supplied) ? durable : null;
}

export async function resolveShopifyConfig(
  siteId: string,
): Promise<ShopifyClientConfig> {
  const convex = convexClient();
  const site = await convex.query(api.sites.get, { siteId: siteId as Id<"sites"> });
  if (!site) throw new Error(`resolveShopifyConfig: site ${siteId} not found`);
  if (!site.shopifyDomain) {
    throw new Error("Shopify store is not connected for this site — connect a store first.");
  }
  const shop = site.shopifyDomain;

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
