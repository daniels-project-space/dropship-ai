// Content-factory creative lifecycle: requestGen → (factory fills r2Key) → review → approve/reject.
// Every read is index-driven (by_site_status / by_product). Approval/rejection appends to audit.
//
// AI-DISCLOSURE INVARIANT (locked): a creative with aiGenerated:true is ALWAYS stored with
// aiLabelRequired:true. `requestGen` enforces this so the flag can never be dropped upstream.
import { query, mutation } from "./authz";
import { v } from "convex/values";
import { appendAudit } from "./audit";

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
      createdAt: Date.now(),
    });
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
    await ctx.db.patch(creativeId, { r2Key, labelBurned, status: "review" });
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
    await ctx.db.patch(creativeId, { status: "approved" });
    await appendAudit(ctx, {
      siteId: c.siteId,
      event: "creative_approved",
      detail: { creativeId, approver: approver ?? "human" },
    });
    return creativeId;
  },
});

export const reject = mutation({
  args: { creativeId: v.id("creatives"), approver: v.optional(v.string()), reason: v.optional(v.string()) },
  handler: async (ctx, { creativeId, approver, reason }) => {
    const c = await ctx.db.get(creativeId);
    if (!c) throw new Error(`creative ${creativeId} not found`);
    if (c.status !== "review") throw new Error(`creative ${creativeId} is ${c.status}, not review`);
    await ctx.db.patch(creativeId, { status: "rejected" });
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
    return q.order("desc").take(limit ?? 100);
  },
});

// Cross-site review feed (Creative Studio default view): all sites, status="review".
// Bounded scan over a small site set, each read index-scoped.
export const listForReview = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const sites = (await ctx.db.query("sites").take(200)).filter((site) => site.sample !== true);
    const out = [];
    for (const s of sites) {
      const rows = await ctx.db
        .query("creatives")
        .withIndex("by_site_status", (q) => q.eq("siteId", s._id).eq("status", "review"))
        .order("desc")
        .take(limit ?? 50);
      for (const r of rows) out.push({ ...r, siteName: s.name });
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out.slice(0, limit ?? 100);
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
