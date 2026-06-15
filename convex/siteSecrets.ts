// Per-site credential REFERENCES (the secret value never lives here — only a vaultRef pointer).
// Index-driven reads only (by_site / by_site_key). The actual token lives in the project-hub vault;
// this table maps "which vault key does site X use for service Y".
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

// Insert-or-update the vaultRef for a (siteId, key) pair. Idempotent on (siteId, key).
export const upsertRef = mutation({
  args: {
    siteId: v.id("sites"),
    key: v.string(), // e.g. "SHOPIFY_ADMIN_TOKEN"
    vaultRef: v.string(), // pointer into the vault, e.g. "shopify/CALM_COLLAR" — NEVER the value
  },
  handler: async (ctx, { siteId, key, vaultRef }) => {
    const existing = await ctx.db
      .query("siteSecrets")
      .withIndex("by_site_key", (q) => q.eq("siteId", siteId).eq("key", key))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { vaultRef });
      return existing._id;
    }
    return ctx.db.insert("siteSecrets", { siteId, key, vaultRef });
  },
});

// Resolve the vaultRef for a (siteId, key) pair, or null if none is registered.
export const getRef = query({
  args: { siteId: v.id("sites"), key: v.string() },
  handler: async (ctx, { siteId, key }) => {
    const row = await ctx.db
      .query("siteSecrets")
      .withIndex("by_site_key", (q) => q.eq("siteId", siteId).eq("key", key))
      .first();
    return row?.vaultRef ?? null;
  },
});

// All credential references for a site (names only — values stay in the vault).
export const listBySite = query({
  args: { siteId: v.id("sites") },
  handler: async (ctx, { siteId }) => {
    return ctx.db
      .query("siteSecrets")
      .withIndex("by_site", (q) => q.eq("siteId", siteId))
      .collect();
  },
});
