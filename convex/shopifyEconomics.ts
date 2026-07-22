import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { appendAudit } from "./audit";

export type ShopifyEconomicsInvalidationReason =
  | "shopify_webhook_order_observation"
  | "shopify_order_observation"
  | "shopify_draft_import_observation";

/**
 * Every independent Shopify observation and the snapshot reducer serialize through the site
 * row. If this transition wins first, the reducer observes `incomplete` and writes no snapshot;
 * if the reducer wins first, this transition demotes its newly-current generation.
 */
export async function invalidateShopifyEconomicsForObservation(
  ctx: MutationCtx,
  siteId: Id<"sites">,
  reason: ShopifyEconomicsInvalidationReason,
) {
  const site = await ctx.db.get(siteId);
  const activePending = site?.shopifyEconomicsSyncStatus === "pending"
    && !!site.shopifyEconomicsSyncAttemptId;
  if (!site || (!activePending && site.shopifyEconomicsSyncStatus !== "current")) {
    return { invalidated: false as const };
  }
  const invalidatedAt = Date.now();
  await ctx.db.patch(siteId, {
    shopifyEconomicsSyncStatus: "incomplete",
    shopifyEconomicsSyncInvalidatedAt: invalidatedAt,
    shopifyEconomicsSyncInvalidationReason: reason,
  });
  await appendAudit(ctx, {
    siteId,
    event: "shopify_economics_sync_incomplete",
    detail: {
      attemptId: site.shopifyEconomicsSyncAttemptId,
      reason,
      priorStatus: site.shopifyEconomicsSyncStatus,
    },
  });
  return {
    invalidated: true as const,
    attemptId: site.shopifyEconomicsSyncAttemptId,
    invalidatedAt,
  };
}
