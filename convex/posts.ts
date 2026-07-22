// Distribution post lifecycle: schedule/awaiting_manual → provider-confirmed publish → observed metrics.
// Index-driven reads only (by_site_status / by_site_platform).
//
// The label gate is enforced in src/lib/distribute.ts BEFORE a post is published; `schedule`
// additionally refuses to schedule a post for a creative that still requires a label but whose
// asset isn't ready (defense in depth at the data layer).
import { query, mutation } from "./authz";
import { v } from "convex/values";
import { appendAudit } from "./audit";
import { dispatchTriggerDecision } from "../src/lib/distributionState";

async function requireServiceIdentity(ctx: { auth: { getUserIdentity: () => Promise<{ subject?: string } | null> } }): Promise<void> {
  if ((await ctx.auth.getUserIdentity())?.subject !== "dropship-ai:service") {
    throw new Error("UNAUTHENTICATED: distribution dispatch requires the service runtime");
  }
}

const platform = v.union(
  v.literal("tiktok"),
  v.literal("instagram"),
  v.literal("youtube"),
  v.literal("facebook"),
);
const postStatus = v.union(
  v.literal("draft"),
  v.literal("scheduled"),
  v.literal("awaiting_manual_publish"),
  v.literal("published"),
  v.literal("failed"),
);

export const schedule = mutation({
  args: {
    siteId: v.id("sites"),
    creativeId: v.id("creatives"),
    platform,
    targetAccount: v.string(),
    caption: v.string(),
    dispatchKey: v.string(),
    status: v.optional(v.union(v.literal("scheduled"), v.literal("awaiting_manual_publish"))),
    scheduledFor: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const creative = await ctx.db.get(args.creativeId);
    if (!creative) throw new Error(`creative ${args.creativeId} not found`);
    if (creative.siteId !== args.siteId) throw new Error("creative does not belong to this site");
    if (creative.status !== "approved") {
      throw new Error(`creative ${args.creativeId} is ${creative.status}, only approved creatives can post`);
    }
    const dispatch = await ctx.db.query("distributionDispatches").withIndex("by_creative", (q) => q.eq("creativeId", args.creativeId)).first();
    const destinations = dispatch?.destinations;
    if (!dispatch || !destinations || dispatch.dispatchKey !== args.dispatchKey || dispatch.creativeRevision !== (creative.revision ?? 1)
      || dispatch.caption !== args.caption || !destinations.some((d) => d.platform === args.platform && d.targetAccount === args.targetAccount)) {
      throw new Error("post input is not covered by the exact publication authorization");
    }
    // Data-layer label gate: AI creative must have an asset (label is burned into that asset).
    if (creative.aiLabelRequired && (creative.labelBurned !== true || !creative.r2Key)) {
      throw new Error(`creative ${args.creativeId} requires verified AI-labeled asset before scheduling`);
    }
    const status = args.status ?? ("scheduled" as const);
    const duplicate = await ctx.db
      .query("posts")
      .withIndex("by_creative_platform", (q) => q.eq("creativeId", args.creativeId).eq("platform", args.platform))
      .first();
    if (duplicate) {
      if (duplicate.distributionDispatchId !== dispatch._id || duplicate.targetAccount !== args.targetAccount || duplicate.caption !== args.caption) {
        throw new Error("existing post is bound to different publication authorization input");
      }
      return { postId: duplicate._id, status: duplicate.status, duplicate: true };
    }
    const postId = await ctx.db.insert("posts", {
      siteId: args.siteId,
      creativeId: args.creativeId,
      platform: args.platform,
      targetAccount: args.targetAccount,
      caption: args.caption,
      distributionDispatchId: dispatch._id,
      status,
      scheduledFor: args.scheduledFor,
      views: 0,
      engagement: 0,
    });
    await appendAudit(ctx, {
      siteId: args.siteId,
      event: "post_scheduled",
      detail: { postId, platform: args.platform, status, creativeId: args.creativeId },
    });
    return { postId, status, duplicate: false };
  },
});

export const markPublished = mutation({
  args: { postId: v.id("posts"), externalPostId: v.string() },
  handler: async (ctx, { postId, externalPostId }) => {
    await requireServiceIdentity(ctx);
    const p = await ctx.db.get(postId);
    if (!p) throw new Error(`post ${postId} not found`);
    if (p.status !== "scheduled" && p.status !== "awaiting_manual_publish") {
      throw new Error(`post ${postId} is ${p.status}, not awaiting provider publication`);
    }
    if (!externalPostId.trim()) throw new Error("provider post id is required before marking published");
    await ctx.db.patch(postId, { status: "published", publishedAt: Date.now(), externalPostId });
    await appendAudit(ctx, { siteId: p.siteId, event: "post_published", detail: { postId, externalPostId } });
    return postId;
  },
});

/** Semi-manual is a durable directive, not a provider publication. */
export const markAwaitingManualPublish = mutation({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => {
    await requireServiceIdentity(ctx);
    const post = await ctx.db.get(postId);
    if (!post) throw new Error(`post ${postId} not found`);
    if (post.status === "awaiting_manual_publish") return postId;
    if (post.status !== "scheduled") throw new Error(`post ${postId} is ${post.status}, not schedulable for manual publication`);
    await ctx.db.patch(postId, { status: "awaiting_manual_publish" });
    return postId;
  },
});

export const recordEngagement = mutation({
  args: { postId: v.id("posts"), views: v.number(), engagement: v.number(), observedAt: v.number(), provider: v.literal("ayrshare") },
  handler: async (ctx, { postId, views, engagement, observedAt, provider }) => {
    await requireServiceIdentity(ctx);
    const p = await ctx.db.get(postId);
    if (!p) throw new Error(`post ${postId} not found`);
    if (p.status !== "published" || !p.externalPostId) {
      throw new Error(`post ${postId} has no provider-confirmed publication`);
    }
    if (!Number.isFinite(views) || !Number.isFinite(engagement) || views < 0 || engagement < 0 || !Number.isFinite(observedAt)) {
      throw new Error("provider metrics must be finite non-negative observations");
    }
    await ctx.db.patch(postId, { views, engagement, metricsObservedAt: observedAt, metricsProvider: provider });
    return postId;
  },
});

/** Atomically claim the Trigger dispatch created alongside creative approval. */
export const beginDistributionDispatch = mutation({
  args: { creativeId: v.id("creatives"), dispatchKey: v.string() },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const row = await ctx.db.query("distributionDispatches").withIndex("by_creative", (q) => q.eq("creativeId", args.creativeId)).first();
    if (!row || row.creativeRevision === undefined || row.caption === undefined || !row.destinations?.length) throw new Error("approved creative has no exact publication authorization");
    if (row.dispatchKey !== args.dispatchKey) throw new Error("distribution dispatch key does not match creative");
    const creative = await ctx.db.get(args.creativeId);
    if (!creative || creative.status !== "approved" || (creative.revision ?? 1) !== row.creativeRevision) {
      throw new Error("publication authorization is stale for the current creative revision");
    }
    const now = Date.now();
    if (row.status === "dispatching") {
      if ((row.triggerLeaseExpiresAt ?? 0) > now) return { status: "busy" as const, triggerRunId: row.triggerRunId };
      await ctx.db.patch(row._id, { triggerLeaseExpiresAt: now + 5 * 60_000, updatedAt: now });
      return { status: "dispatching" as const };
    }
    const decision = dispatchTriggerDecision(row.status);
    if (decision === "reconcile_required") return { status: "reconcile_required" as const, triggerRunId: row.triggerRunId };
    if (decision === "already_dispatched") return { status: row.status, triggerRunId: row.triggerRunId, reused: true as const };
    await ctx.db.patch(row._id, { status: "dispatching", triggerLeaseExpiresAt: now + 5 * 60_000, updatedAt: now });
    return { status: "dispatching" as const };
  },
});

export const getDistributionAuthorization = query({
  args: { creativeId: v.id("creatives"), dispatchKey: v.string() },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const row = await ctx.db.query("distributionDispatches").withIndex("by_creative", (q) => q.eq("creativeId", args.creativeId)).first();
    if (!row || row.dispatchKey !== args.dispatchKey || row.creativeRevision === undefined || row.caption === undefined || !row.destinations?.length) return null;
    const creative = await ctx.db.get(args.creativeId);
    if (!creative || creative.status !== "approved" || (creative.revision ?? 1) !== row.creativeRevision) return null;
    return { ...row, creativeRevision: row.creativeRevision, caption: row.caption, destinations: row.destinations };
  },
});

export const recordDistributionDispatch = mutation({
  args: { creativeId: v.id("creatives"), dispatchKey: v.string(), triggerRunId: v.string() },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const row = await ctx.db.query("distributionDispatches").withIndex("by_creative", (q) => q.eq("creativeId", args.creativeId)).first();
    if (!row || row.dispatchKey !== args.dispatchKey) throw new Error("distribution dispatch no longer matches creative");
    if (row.triggerRunId && row.triggerRunId !== args.triggerRunId) throw new Error("distribution dispatch already has a different Trigger run");
    if (row.status === "reconcile_required") return { status: "reconcile_required" as const, triggerRunId: row.triggerRunId };
    await ctx.db.patch(row._id, { status: "dispatched", triggerRunId: args.triggerRunId, triggerLeaseExpiresAt: undefined, updatedAt: Date.now() });
    return { status: "dispatched" as const, triggerRunId: args.triggerRunId };
  },
});

export const completeDistributionDispatch = mutation({
  args: { creativeId: v.id("creatives"), dispatchKey: v.string(), reconciliationRequired: v.optional(v.boolean()), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const row = await ctx.db.query("distributionDispatches").withIndex("by_creative", (q) => q.eq("creativeId", args.creativeId)).first();
    if (!row || row.dispatchKey !== args.dispatchKey) throw new Error("distribution dispatch no longer matches creative");
    const status = args.reconciliationRequired ? "reconcile_required" as const : "delivered" as const;
    await ctx.db.patch(row._id, { status, lastError: args.error, triggerLeaseExpiresAt: undefined, updatedAt: Date.now() });
    return { status };
  },
});

export const listDispatchesNeedingTrigger = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const pending = (await ctx.db.query("distributionDispatches").withIndex("by_status", (q) => q.eq("status", "pending")).take(limit ?? 100))
      .filter((row) => row.creativeRevision !== undefined && row.caption !== undefined && !!row.destinations?.length);
    const remaining = Math.max(0, (limit ?? 100) - pending.length);
    const dispatching = remaining
      ? (await ctx.db.query("distributionDispatches").withIndex("by_status", (q) => q.eq("status", "dispatching")).take(remaining))
        .filter((row) => row.creativeRevision !== undefined && row.caption !== undefined && !!row.destinations?.length)
      : [];
    return [...pending, ...dispatching];
  },
});

export const listBySite = query({
  args: {
    siteId: v.id("sites"),
    status: v.optional(postStatus),
    platform: v.optional(platform),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { siteId, status, platform: plat, limit }) => {
    if (plat) {
      return ctx.db
        .query("posts")
        .withIndex("by_site_platform", (q) => q.eq("siteId", siteId).eq("platform", plat))
        .order("desc")
        .take(limit ?? 100);
    }
    if (status) {
      return ctx.db
        .query("posts")
        .withIndex("by_site_status", (q) => q.eq("siteId", siteId).eq("status", status))
        .order("desc")
        .take(limit ?? 100);
    }
    return ctx.db
      .query("posts")
      .withIndex("by_site_status", (q) => q.eq("siteId", siteId))
      .order("desc")
      .take(limit ?? 100);
  },
});

// Cross-site distribution board feed: all posts across sites, newest first, with site + creative.
export const listForBoard = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const sites = (await ctx.db.query("sites").take(200)).filter((site) => site.sample !== true);
    const out = [];
    for (const s of sites) {
      const rows = await ctx.db
        .query("posts")
        .withIndex("by_site_status", (q) => q.eq("siteId", s._id))
        .order("desc")
        .take(limit ?? 60);
      for (const r of rows) {
        const creative = await ctx.db.get(r.creativeId);
        out.push({
          ...r,
          siteName: s.name,
          creativeKind: creative?.kind ?? null,
          aiGenerated: creative?.aiGenerated ?? false,
          r2Key: creative?.r2Key ?? null,
        });
      }
    }
    out.sort((a, b) => (b._creationTime ?? 0) - (a._creationTime ?? 0));
    return out.slice(0, limit ?? 120);
  },
});
