import { SHOPIFY_CONNECT_SITE_ID_MAX_LENGTH } from "./shopifyConnectRequest";
import { SHOPIFY_ECONOMICS_CANONICAL_SINCE_DAYS } from "./shopifySyncState";

export { SHOPIFY_ECONOMICS_CANONICAL_SINCE_DAYS };

export type ShopifySyncRequest = {
  siteId: string;
  sinceDays: number;
};

/** Bound untrusted sync JSON before Convex, vault, or Shopify activity. */
export function parseShopifySyncRequest(value: unknown): ShopifySyncRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.siteId !== "string"
    || body.siteId.length < 1
    || body.siteId.length > SHOPIFY_CONNECT_SITE_ID_MAX_LENGTH
    || body.siteId.trim() !== body.siteId
    || !/^[A-Za-z0-9]+$/.test(body.siteId)) return null;
  const sinceDays = body.sinceDays === undefined
    ? SHOPIFY_ECONOMICS_CANONICAL_SINCE_DAYS
    : body.sinceDays;
  if (!Number.isInteger(sinceDays) || (sinceDays as number) < 1 || (sinceDays as number) > SHOPIFY_ECONOMICS_CANONICAL_SINCE_DAYS) {
    return null;
  }
  return { siteId: body.siteId, sinceDays: sinceDays as number };
}
