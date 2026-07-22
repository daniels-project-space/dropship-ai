import { isMyshopifyDomain } from "./shopifyIdentity";

export const SHOPIFY_CONNECT_SITE_ID_MAX_LENGTH = 128;
export const SHOPIFY_CONNECT_TOKEN_MIN_LENGTH = 8;
export const SHOPIFY_CONNECT_TOKEN_MAX_LENGTH = 512;

export type ShopifyConnectRequest = {
  siteId: string;
  shopifyDomain: string;
  accessToken: string;
};

/** Validate untrusted JSON before domain normalization, token hashing, or any external work. */
export function parseShopifyConnectRequest(value: unknown): ShopifyConnectRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.siteId !== "string"
    || body.siteId.length < 1
    || body.siteId.length > SHOPIFY_CONNECT_SITE_ID_MAX_LENGTH
    || body.siteId.trim() !== body.siteId
    || !/^[A-Za-z0-9]+$/.test(body.siteId)) return null;
  if (typeof body.shopifyDomain !== "string"
    || !isMyshopifyDomain(body.shopifyDomain)) return null;
  if (typeof body.accessToken !== "string"
    || body.accessToken.length < SHOPIFY_CONNECT_TOKEN_MIN_LENGTH
    || body.accessToken.length > SHOPIFY_CONNECT_TOKEN_MAX_LENGTH
    || /\s/.test(body.accessToken)) return null;
  return {
    siteId: body.siteId,
    shopifyDomain: body.shopifyDomain,
    accessToken: body.accessToken,
  };
}
