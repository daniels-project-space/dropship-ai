import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { appendAudit } from "./audit";
import { SHOPIFY_ECONOMICS_SNAPSHOT_PROTOCOL_VERSION } from "../src/lib/shopifySyncState";
import { projectSite } from "./dashboardProjections";

type ExpiryResult = {
  expired: boolean;
  reason: "expired" | "superseded" | "not_current" | "already_expired" | "not_due";
};

/**
 * Durable, generation-bound freshness transition. Scheduled mutations execute exactly once, but
 * the comparisons also make direct retries harmless and prevent old generations from demoting a
 * newer, pending, failed, incomplete, or observation-invalidated snapshot.
 */
export const expireEconomicsSnapshot = internalMutation({
  args: {
    siteId: v.id("sites"),
    attemptId: v.string(),
    protocolVersion: v.number(),
    succeededAt: v.number(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args): Promise<ExpiryResult> => {
    const site = await ctx.db.get(args.siteId);
    if (!site
      || site.shopifyEconomicsSyncAttemptId !== args.attemptId
      || site.shopifyEconomicsSnapshotProtocolVersion !== args.protocolVersion
      || site.shopifyEconomicsSyncSucceededAt !== args.succeededAt
      || site.shopifyEconomicsSyncExpiresAt !== args.expiresAt
      || args.protocolVersion !== SHOPIFY_ECONOMICS_SNAPSHOT_PROTOCOL_VERSION) {
      return { expired: false, reason: "superseded" };
    }
    if (site.shopifyEconomicsSyncStatus !== "current") {
      return { expired: false, reason: "not_current" };
    }
    if (site.shopifyEconomicsSyncExpiredAttemptId === args.attemptId
      && Number.isFinite(site.shopifyEconomicsSyncExpiredAt)) {
      return { expired: false, reason: "already_expired" };
    }
    const expiredAt = Date.now();
    if (expiredAt < args.expiresAt) return { expired: false, reason: "not_due" };

    await ctx.db.patch(args.siteId, {
      shopifyEconomicsSyncExpiredAt: expiredAt,
      shopifyEconomicsSyncExpiredAttemptId: args.attemptId,
    });
    await projectSite(ctx, (await ctx.db.get(args.siteId))!);
    await appendAudit(ctx, {
      siteId: args.siteId,
      event: "shopify_economics_sync_expired",
      detail: {
        attemptId: args.attemptId,
        protocolVersion: args.protocolVersion,
        succeededAt: args.succeededAt,
        expiresAt: args.expiresAt,
      },
    });
    return { expired: true, reason: "expired" };
  },
});
