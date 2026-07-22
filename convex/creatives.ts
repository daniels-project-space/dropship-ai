// Content-factory creative lifecycle: requestGen → (factory fills r2Key) → review → approve/reject.
// Every read is index-driven (by_site_status / by_product). Approval/rejection appends to audit.
//
// AI-DISCLOSURE INVARIANT (locked): a creative with aiGenerated:true is ALWAYS stored with
// aiLabelRequired:true. `requestGen` enforces this so the flag can never be dropped upstream.
import { query, mutation } from "./authz";
import { v } from "convex/values";
import { appendAudit } from "./audit";
import { stableSha256 } from "../src/lib/cjOrder";
import { dashboardProjectionReady, projectCreativeTransition } from "./dashboardProjections";

const creativeKind = v.union(
  v.literal("product_demo"),
  v.literal("ai_spokesperson"),
  v.literal("ai_broll"),
  v.literal("customer_ugc"),
);
const creativeStatus = v.union(
  v.literal("generating"),
  v.literal("review"),
  v.literal("approved"),
  v.literal("rejected"),
);

// Create a creative row in "generating" (or "review" if the factory supplied a verified asset).
export const requestGen = mutation({
  args: {
    siteId: v.id("sites"),
    productId: v.optional(v.id("products")),
    kind: creativeKind,
    aiGenerated: v.boolean(),
    hook: v.optional(v.string()),
    r2Key: v.optional(v.string()),      // present when the factory has already assembled the asset
    labelBurned: v.optional(v.boolean()), // factory proof: disclosure was rendered into the asset
    status: v.optional(creativeStatus), // factory passes "review" once the asset exists
  },
  handler: async (ctx, args) => {
    // INVARIANT: any AI-generated asset requires the disclosure label, full stop.
    const aiLabelRequired = args.aiGenerated === true;
    const labelBurned = args.labelBurned === true;
    const status = args.status ?? (args.r2Key ? ("review" as const) : ("generating" as const));
    if (status === "review" && !args.r2Key) {
      throw new Error("creative cannot enter review without an assembled asset");
    }
    if (aiLabelRequired && status === "review" && !labelBurned) {
      throw new Error("AI creative cannot enter review without verified burned-in disclosure");
    }
    const creativeId = await ctx.db.insert("creatives", {
      siteId: args.siteId,
      productId: args.productId,
      kind: args.kind,
      r2Key: args.r2Key ?? "", // empty until the factory uploads + patches via setAsset
      aiGenerated: args.aiGenerated,
      aiLabelRequired,
      labelBurned,
      hook: args.hook,
      status,
      publicationAuthorized: false,
      queueState: status === "review" ? "review" : "none",
      revision: 1,
      createdAt: Date.now(),
    });
    await projectCreativeTransition(ctx, null, (await ctx.db.get(creativeId))!);
    await appendAudit(ctx, {
      siteId: args.siteId,
      event: "creative_requested",
      detail: { creativeId, kind: args.kind, aiGenerated: args.aiGenerated, aiLabelRequired, labelBurned, status },
    });
    return { creativeId, aiLabelRequired, status };
  },
});

// Factory callback: attach the finished R2 asset and flip to "review".
export const setAsset = mutation({
  args: { creativeId: v.id("creatives"), r2Key: v.string(), labelBurned: v.boolean() },
  handler: async (ctx, { creativeId, r2Key, labelBurned }) => {
    const c = await ctx.db.get(creativeId);
    if (!c) throw new Error(`creative ${creativeId} not found`);
    if (c.aiLabelRequired && !labelBurned) {
      throw new Error(`creative ${creativeId} requires verified burned-in AI disclosure`);
    }
    if (c.status === "approved" || c.status === "rejected") throw new Error(`creative ${creativeId} is immutable after review resolution`);
    const revision = (c.revision ?? 1) + 1;
    await ctx.db.patch(creativeId, { r2Key, labelBurned, status: "review", revision, publicationAuthorized: false, queueState: "review" });
    await projectCreativeTransition(ctx, c, (await ctx.db.get(creativeId))!);
    await appendAudit(ctx, { siteId: c.siteId, event: "creative_asset_ready", detail: { creativeId, r2Key, labelBurned } });
    return creativeId;
  },
});

export const approve = mutation({
  args: { creativeId: v.id("creatives"), approver: v.optional(v.string()) },
  handler: async (ctx, { creativeId, approver }) => {
    const c = await ctx.db.get(creativeId);
    if (!c) throw new Error(`creative ${creativeId} not found`);
    if (c.status !== "review") throw new Error(`creative ${creativeId} is ${c.status}, not review`);
    if (!c.r2Key) {
      throw new Error(`creative ${creativeId} requires an assembled asset before approval`);
    }
    // Legacy rows without labelBurned intentionally fail closed here.
    if (c.aiLabelRequired && c.labelBurned !== true) {
      throw new Error(`creative ${creativeId} requires verified burned-in AI disclosure before approval`);
    }
    await ctx.db.patch(creativeId, { status: "approved", publicationAuthorized: false, queueState: "publication_authorization" });
    await projectCreativeTransition(ctx, c, (await ctx.db.get(creativeId))!);
    await appendAudit(ctx, {
      siteId: c.siteId,
      event: "creative_approved",
      detail: { creativeId, approver: approver ?? "human" },
    });
    return { creativeId, revision: c.revision ?? 1, publicationAuthorized: false as const };
  },
});

const publicationDestination = v.object({ platform: v.union(
  v.literal("tiktok"), v.literal("instagram"), v.literal("youtube"), v.literal("facebook"),
), targetAccount: v.string() });

/** A distinct operator act binds publication to one exact content/account snapshot. */
export const authorizePublication = mutation({
  args: {
    creativeId: v.id("creatives"),
    expectedRevision: v.number(),
    caption: v.string(),
    destinations: v.array(publicationDestination),
    operator: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const creative = await ctx.db.get(args.creativeId);
    if (!creative) throw new Error(`creative ${args.creativeId} not found`);
    if (creative.status !== "approved") throw new Error("content must be approved before publication can be authorized");
    const revision = creative.revision ?? 1;
    if (!Number.isInteger(args.expectedRevision) || args.expectedRevision !== revision) {
      throw new Error("publication authorization is stale: creative revision changed");
    }
    const caption = args.caption.trim();
    if (!caption) throw new Error("publication caption is required");
    if (!args.destinations.length || args.destinations.length > 4) throw new Error("select one to four publication destinations");
    const destinations = args.destinations.map(({ platform, targetAccount }) => ({ platform, targetAccount: targetAccount.trim() }));
    if (destinations.some(({ targetAccount }) => !targetAccount)) throw new Error("every selected platform requires an exact target account");
    if (new Set(destinations.map(({ platform }) => platform)).size !== destinations.length) throw new Error("a platform may be selected only once");
    const binding = stableSha256(JSON.stringify({ creativeId: args.creativeId, revision, caption, destinations }));
    const dispatchKey = `distribution:${args.creativeId}:r${revision}:${binding.slice(0, 24)}`;
    const existing = await ctx.db.query("distributionDispatches").withIndex("by_creative", (q) => q.eq("creativeId", args.creativeId)).first();
    if (existing) {
      if (existing.dispatchKey !== dispatchKey || existing.creativeRevision !== revision
        || existing.caption !== caption || JSON.stringify(existing.destinations) !== JSON.stringify(destinations)) {
        throw new Error("publication was already authorized for different immutable input");
      }
      if (creative.publicationAuthorized !== true || creative.queueState !== "none") {
        await ctx.db.patch(args.creativeId, { publicationAuthorized: true, queueState: "none" });
      }
      return { creativeId: args.creativeId, dispatchKey, reused: true as const };
    }
    const now = Date.now();
    await ctx.db.insert("distributionDispatches", {
      siteId: creative.siteId, creativeId: args.creativeId, creativeRevision: revision,
      caption, destinations, dispatchKey, status: "pending", createdAt: now, updatedAt: now,
    });
    await ctx.db.patch(args.creativeId, { publicationAuthorized: true, queueState: "none" });
    await appendAudit(ctx, {
      siteId: creative.siteId,
      event: "creative_publication_authorized",
      detail: { creativeId: args.creativeId, revision, platforms: destinations.map((d) => d.platform), operator: args.operator ?? "human" },
    });
    return { creativeId: args.creativeId, dispatchKey, reused: false as const };
  },
});

export const reject = mutation({
  args: { creativeId: v.id("creatives"), approver: v.optional(v.string()), reason: v.optional(v.string()) },
  handler: async (ctx, { creativeId, approver, reason }) => {
    const c = await ctx.db.get(creativeId);
    if (!c) throw new Error(`creative ${creativeId} not found`);
    if (c.status !== "review") throw new Error(`creative ${creativeId} is ${c.status}, not review`);
    await ctx.db.patch(creativeId, { status: "rejected", publicationAuthorized: false, queueState: "none" });
    await projectCreativeTransition(ctx, c, (await ctx.db.get(creativeId))!);
    await appendAudit(ctx, {
      siteId: c.siteId,
      event: "creative_rejected",
      detail: { creativeId, approver: approver ?? "human", reason: reason ?? null },
    });
    return creativeId;
  },
});

// Index-driven list. status omitted → all creatives for the site (by_site_status partial range).
export const listByStatus = query({
  args: { siteId: v.id("sites"), status: v.optional(creativeStatus), limit: v.optional(v.number()) },
  handler: async (ctx, { siteId, status, limit }) => {
    const q = status
      ? ctx.db.query("creatives").withIndex("by_site_status", (qq) => qq.eq("siteId", siteId).eq("status", status))
      : ctx.db.query("creatives").withIndex("by_site_status", (qq) => qq.eq("siteId", siteId));
    const rows = await q.order("desc").take(limit ?? 100);
    if (!(await dashboardProjectionReady(ctx))) {
      return Promise.all(rows.map(async (row) => ({
        ...row,
        revision: row.revision ?? 1,
        publicationAuthorized: !!(await ctx.db.query("distributionDispatches").withIndex("by_creative", (qq) => qq.eq("creativeId", row._id)).first()),
      })));
    }
    return rows.map((row) => ({
      ...row,
      revision: row.revision ?? 1,
      publicationAuthorized: row.publicationAuthorized === true,
    }));
  },
});

// Cross-site review feed (Creative Studio default view): all sites, status="review".
// Bounded scan over a small site set, each read index-scoped.
export const listForReview = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    if (!(await dashboardProjectionReady(ctx))) {
      const allSites = await ctx.db.query("sites").take(501);
      if (allSites.length > 500) throw new Error("live review queue exceeds the bounded legacy site cap");
      const sites = allSites.filter((site) => site.sample !== true);
      const out = [];
      for (const site of sites) {
        const rows = await ctx.db.query("creatives").withIndex("by_site_status", (q) => q.eq("siteId", site._id).eq("status", "review")).order("desc").take(limit ?? 50);
        for (const row of rows) out.push({ ...row, siteName: site.name });
      }
      return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit ?? 100);
    }
    const cap = Math.min(limit ?? 100, 100);
    const rows = await ctx.db.query("creatives")
      .withIndex("by_queue_created_at_mode", (q) => q.eq("dashboardDataMode", "live").eq("queueState", "review"))
      .order("desc").take(cap);
    const siteIds = [...new Set(rows.map((row) => row.siteId))];
    const sites = new Map((await Promise.all(siteIds.map((siteId) => ctx.db.get(siteId))))
      .filter((site): site is NonNullable<typeof site> => !!site && site.sample !== true)
      .map((site) => [site._id, site]));
    return rows.filter((row) => sites.has(row.siteId)).slice(0, cap)
      .map((row) => ({ ...row, siteName: sites.get(row.siteId)!.name }));
  },
});

export const listForPublicationAuthorization = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    if (!(await dashboardProjectionReady(ctx))) {
      const allSites = await ctx.db.query("sites").take(501);
      if (allSites.length > 500) throw new Error("live publication queue exceeds the bounded legacy site cap");
      const sites = allSites.filter((site) => site.sample !== true);
      const out = [];
      for (const site of sites) {
        const rows = await ctx.db.query("creatives").withIndex("by_site_status", (q) => q.eq("siteId", site._id).eq("status", "approved")).order("desc").take(limit ?? 50);
        for (const row of rows) {
          const dispatch = await ctx.db.query("distributionDispatches").withIndex("by_creative", (q) => q.eq("creativeId", row._id)).first();
          if (!dispatch) out.push({ ...row, revision: row.revision ?? 1, siteName: site.name });
        }
      }
      return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit ?? 100);
    }
    const cap = Math.min(limit ?? 100, 100);
    const rows = await ctx.db.query("creatives")
      .withIndex("by_queue_created_at_mode", (q) => q.eq("dashboardDataMode", "live").eq("queueState", "publication_authorization"))
      .order("desc").take(cap);
    const siteIds = [...new Set(rows.map((row) => row.siteId))];
    const sites = new Map((await Promise.all(siteIds.map((siteId) => ctx.db.get(siteId))))
      .filter((site): site is NonNullable<typeof site> => !!site && site.sample !== true)
      .map((site) => [site._id, site]));
    return rows.filter((row) => sites.has(row.siteId)).slice(0, cap)
      .map((row) => ({ ...row, revision: row.revision ?? 1, siteName: sites.get(row.siteId)!.name }));
  },
});

export const get = query({
  args: { creativeId: v.id("creatives") },
  handler: async (ctx, { creativeId }) => ctx.db.get(creativeId),
});

export const getByR2Key = query({
  args: { r2Key: v.string() },
  handler: async (ctx, { r2Key }) => ctx.db.query("creatives").withIndex("by_r2_key", (q) => q.eq("r2Key", r2Key)).first(),
});
