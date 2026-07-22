export const SHOPIFY_ECONOMICS_SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const SHOPIFY_ECONOMICS_CANONICAL_SINCE_DAYS = 60;

export type ShopifyEconomicsSyncStatus = "pending" | "current" | "failed" | "incomplete";
export type ShopifyEconomicsReadiness =
  | "not_connected"
  | "needs_reverification"
  | "pending"
  | "current"
  | "stale"
  | "failed"
  | "incomplete";

type ShopifySiteSyncFacts = {
  shopifyDomain?: string;
  storeCurrency?: string;
  shopifyAccessVerifiedAt?: number;
  shopifyEconomicsSyncStatus?: ShopifyEconomicsSyncStatus;
  shopifyEconomicsSyncAttemptId?: string;
  shopifyEconomicsSyncSucceededAt?: number;
  shopifyEconomicsSyncSinceDays?: number;
  shopifyEconomicsSyncProductCount?: number;
  shopifyEconomicsSyncOrderCount?: number;
};

/** Fail-closed launch state: identity proof and complete, fresh economics proof are independent. */
export function shopifyEconomicsReadiness(
  site: ShopifySiteSyncFacts,
  now = Date.now(),
): ShopifyEconomicsReadiness {
  if (!site.shopifyDomain) return "not_connected";
  if (site.storeCurrency !== "USD" || !Number.isFinite(site.shopifyAccessVerifiedAt)) {
    return "needs_reverification";
  }
  switch (site.shopifyEconomicsSyncStatus) {
    case "failed": return "failed";
    case "incomplete": return "incomplete";
    case "pending": return "pending";
    case "current": {
      if (site.shopifyEconomicsSyncSinceDays !== SHOPIFY_ECONOMICS_CANONICAL_SINCE_DAYS
        || !site.shopifyEconomicsSyncAttemptId
        || !Number.isInteger(site.shopifyEconomicsSyncProductCount)
        || site.shopifyEconomicsSyncProductCount! < 0
        || !Number.isInteger(site.shopifyEconomicsSyncOrderCount)
        || site.shopifyEconomicsSyncOrderCount! < 0) return "incomplete";
      const succeededAt = site.shopifyEconomicsSyncSucceededAt;
      if (!Number.isFinite(succeededAt)) return "stale";
      const age = now - succeededAt!;
      return age >= 0 && age <= SHOPIFY_ECONOMICS_SYNC_MAX_AGE_MS ? "current" : "stale";
    }
    default:
      // Connected legacy rows have identity/configuration evidence, never complete sync evidence.
      return "pending";
  }
}
