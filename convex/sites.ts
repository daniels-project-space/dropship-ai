// Tenant (store/brand) CRUD. One row per site; everything else is siteId-scoped.
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { appendAudit } from "./audit";

const siteStatus = v.union(
  v.literal("provisioning"),
  v.literal("active"),
  v.literal("paused"),
  v.literal("killed"),
);

export const create = mutation({
  args: {
    name: v.string(),
    niche: v.string(),
    minKitPriceUsd: v.number(),
    minBlendedMarginPct: v.number(),
    distributionMode: v.union(v.literal("semi_manual"), v.literal("automated")),
    shopifyDomain: v.optional(v.string()),
    customDomain: v.optional(v.string()),
    killDate: v.optional(v.number()),
    status: v.optional(siteStatus),
  },
  handler: async (ctx, args) => {
    const { status, ...rest } = args;
    const siteId = await ctx.db.insert("sites", {
      ...rest,
      status: status ?? "provisioning",
      createdAt: Date.now(),
    });
    await appendAudit(ctx, { siteId, event: "site_created", detail: { name: args.name, niche: args.niche } });
    return siteId;
  },
});

export const list = query({
  args: { status: v.optional(siteStatus) },
  handler: async (ctx, { status }) => {
    if (status) {
      return ctx.db
        .query("sites")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect();
    }
    // Unfiltered listing of tenants — bounded small set; take() caps worst case.
    return ctx.db.query("sites").order("desc").take(500);
  },
});

export const get = query({
  args: { siteId: v.id("sites") },
  handler: async (ctx, { siteId }) => {
    return ctx.db.get(siteId);
  },
});

export const update = mutation({
  args: {
    siteId: v.id("sites"),
    name: v.optional(v.string()),
    niche: v.optional(v.string()),
    status: v.optional(siteStatus),
    shopifyDomain: v.optional(v.string()),
    customDomain: v.optional(v.string()),
    minKitPriceUsd: v.optional(v.number()),
    minBlendedMarginPct: v.optional(v.number()),
    distributionMode: v.optional(v.union(v.literal("semi_manual"), v.literal("automated"))),
    killDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { siteId, ...patch } = args;
    const existing = await ctx.db.get(siteId);
    if (!existing) throw new Error(`site ${siteId} not found`);
    const clean = Object.fromEntries(Object.entries(patch).filter(([, val]) => val !== undefined));
    await ctx.db.patch(siteId, clean);
    await appendAudit(ctx, { siteId, event: "site_updated", detail: clean });
    return siteId;
  },
});
