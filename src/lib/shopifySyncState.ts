export const SHOPIFY_ECONOMICS_SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const SHOPIFY_ECONOMICS_CANONICAL_SINCE_DAYS = 60;
export const SHOPIFY_ECONOMICS_SNAPSHOT_PROTOCOL_VERSION = 1;
export const SHOPIFY_ECONOMICS_DAY_MS = 24 * 60 * 60 * 1000;

export type ShopifyEconomicsSyncStatus = "pending" | "current" | "failed" | "incomplete";
export type ShopifyEconomicsReadiness =
  | "not_connected"
  | "needs_reverification"
  | "pending"
  | "current"
  | "stale"
  | "failed"
  | "incomplete";

export type ShopifySiteSyncFacts = {
  shopifyDomain?: string;
  storeCurrency?: string;
  shopifyAccessVerifiedAt?: number;
  shopifyEconomicsSyncStatus?: ShopifyEconomicsSyncStatus;
  shopifyEconomicsSyncAttemptId?: string;
  shopifyEconomicsSyncAttemptedAt?: number;
  shopifyEconomicsSyncOrderCutoffAt?: number;
  shopifyEconomicsSyncSucceededAt?: number;
  shopifyEconomicsSyncExpiresAt?: number;
  shopifyEconomicsSyncExpiredAt?: number;
  shopifyEconomicsSyncExpiredAttemptId?: string;
  shopifyEconomicsSyncSinceDays?: number;
  shopifyEconomicsSyncProductCount?: number;
  shopifyEconomicsSyncOrderCount?: number;
  shopifyEconomicsSnapshotProtocolVersion?: number;
};

function hasAtomicSnapshotProof(site: ShopifySiteSyncFacts): boolean {
  const attemptId = site.shopifyEconomicsSyncAttemptId;
  const attemptedAt = site.shopifyEconomicsSyncAttemptedAt;
  const succeededAt = site.shopifyEconomicsSyncSucceededAt;
  const cutoffAt = site.shopifyEconomicsSyncOrderCutoffAt;
  const expiresAt = site.shopifyEconomicsSyncExpiresAt;
  return site.shopifyEconomicsSnapshotProtocolVersion === SHOPIFY_ECONOMICS_SNAPSHOT_PROTOCOL_VERSION
    && typeof attemptId === "string"
    && /^[A-Za-z0-9-]{1,100}$/.test(attemptId)
    && site.shopifyEconomicsSyncSinceDays === SHOPIFY_ECONOMICS_CANONICAL_SINCE_DAYS
    && Number.isFinite(attemptedAt)
    && Number.isFinite(succeededAt)
    && Number.isFinite(cutoffAt)
    && Number.isFinite(expiresAt)
    && cutoffAt === attemptedAt! - SHOPIFY_ECONOMICS_CANONICAL_SINCE_DAYS * SHOPIFY_ECONOMICS_DAY_MS
    && succeededAt! >= attemptedAt!
    && expiresAt === succeededAt! + SHOPIFY_ECONOMICS_SYNC_MAX_AGE_MS
    && Number.isInteger(site.shopifyEconomicsSyncProductCount)
    && site.shopifyEconomicsSyncProductCount! >= 0
    && Number.isInteger(site.shopifyEconomicsSyncOrderCount)
    && site.shopifyEconomicsSyncOrderCount! >= 0;
}

/** Fail-closed launch state: identity proof and complete, fresh economics proof are independent. */
export function shopifyEconomicsReadiness(
  site: ShopifySiteSyncFacts,
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
      if (!hasAtomicSnapshotProof(site)) return "incomplete";
      const hasExpiredAt = Number.isFinite(site.shopifyEconomicsSyncExpiredAt);
      const hasExpiredAttempt = typeof site.shopifyEconomicsSyncExpiredAttemptId === "string";
      if (!hasExpiredAt && !hasExpiredAttempt) return "current";
      if (hasExpiredAt
        && site.shopifyEconomicsSyncExpiredAt! >= site.shopifyEconomicsSyncExpiresAt!
        && site.shopifyEconomicsSyncExpiredAttemptId === site.shopifyEconomicsSyncAttemptId) {
        return "stale";
      }
      return "incomplete";
    }
    default:
      // Connected legacy rows have identity/configuration evidence, never complete sync evidence.
      return "pending";
  }
}
