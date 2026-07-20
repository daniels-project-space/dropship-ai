// Distribution post lifecycle: schedule → (publish/awaiting_manual) → recordEngagement.
// Index-driven reads only (by_site_status / by_site_platform).
//
// The label gate is enforced in src/lib/distribute.ts BEFORE a post is published; `schedule`
// additionally refuses to schedule a post for a creative that still requires a label but whose
// asset isn't ready (defense in depth at the data layer).
import { query, mutation } from "./authz";
import { v } from "convex/values";
import { appendAudit } from "./audit";

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
    status: v.optional(postStatus),     // distributor passes awaiting_manual_publish or published
    scheduledFor: v.optional(v.number()),
    externalPostId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const creative = await ctx.db.get(args.creativeId);
    if (!creative) throw new Error(`creative ${args.creativeId} not found`);
    if (creative.status !== "approved") {
      throw new Error(`creative ${args.creativeId} is ${creative.status}, only approved creatives can post`);
    }
    // Data-layer label gate: AI creative must have an asset (label is burned into that asset).
    if (creative.aiLabelRequired && !creative.r2Key) {
      throw new Error(`creative ${args.creativeId} requires AI-labeled asset before scheduling`);
    }
    const status = args.status ?? ("scheduled" as const);
    const postId = await ctx.db.insert("posts", {
      siteId: args.siteId,
      creativeId: args.creativeId,
      platform: args.platform,
      status,
      scheduledFor: args.scheduledFor,
      publishedAt: status === "published" ? Date.now() : undefined,
      externalPostId: args.externalPostId,
      views: 0,
      engagement: 0,
    });
    await appendAudit(ctx, {
      siteId: args.siteId,
      event: "post_scheduled",
      detail: { postId, platform: args.platform, status, creativeId: args.creativeId },
    });
    return { postId, status };
  },
});

export const markPublished = mutation({
  args: { postId: v.id("posts"), externalPostId: v.optional(v.string()) },
  handler: async (ctx, { postId, externalPostId }) => {
    const p = await ctx.db.get(postId);
    if (!p) throw new Error(`post ${postId} not found`);
    await ctx.db.patch(postId, { status: "published", publishedAt: Date.now(), externalPostId });
    await appendAudit(ctx, { siteId: p.siteId, event: "post_published", detail: { postId, externalPostId } });
    return postId;
  },
});

export const recordEngagement = mutation({
  args: { postId: v.id("posts"), views: v.number(), engagement: v.number() },
  handler: async (ctx, { postId, views, engagement }) => {
    const p = await ctx.db.get(postId);
    if (!p) throw new Error(`post ${postId} not found`);
    await ctx.db.patch(postId, { views, engagement });
    return postId;
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
    const sites = await ctx.db.query("sites").take(200);
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
