// Admin maintenance mutations — demo-data teardown for the Phase-1 spike.
//
// The Phase-0 scaffold seeded placeholder tenants (e.g. "Nimbus Home", "Aurora Pet Co."), a
// placeholder creative pointing at creatives/placeholder/pending.mp4, and a sample proposed action.
// Once the real Calm-Collar creative exists we purge that demo data so the dashboard shows ONLY
// real, generated assets. These mutations are deliberately explicit (delete by id) rather than a
// blanket wipe, so they can never touch a real site.
import { mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Cascade-delete a single site and everything scoped to it: creatives, posts, actions, auditLog,
 * products, signals, metrics, siteSecrets, experiments, orders. Index-driven (no full scans).
 */
export const deleteSiteCascade = mutation({
  args: { siteId: v.id("sites") },
  handler: async (ctx, { siteId }) => {
    const site = await ctx.db.get(siteId);
    if (!site) return { deleted: false, reason: "site not found" };

    let removed = 0;
    const delAll = async (rows: { _id: any }[]) => {
      for (const r of rows) {
        await ctx.db.delete(r._id);
        removed++;
      }
    };

    await delAll(await ctx.db.query("creatives").withIndex("by_site_status", (q) => q.eq("siteId", siteId)).collect());
    await delAll(await ctx.db.query("posts").withIndex("by_site_status", (q) => q.eq("siteId", siteId)).collect());
    await delAll(await ctx.db.query("actions").withIndex("by_site_status", (q) => q.eq("siteId", siteId)).collect());
    await delAll(await ctx.db.query("auditLog").withIndex("by_site_at", (q) => q.eq("siteId", siteId)).collect());
    await delAll(await ctx.db.query("products").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect());
    await delAll(await ctx.db.query("productSignals").withIndex("by_site_day", (q) => q.eq("siteId", siteId)).collect());
    await delAll(await ctx.db.query("conversionMetrics").withIndex("by_site_day", (q) => q.eq("siteId", siteId)).collect());
    await delAll(await ctx.db.query("siteSecrets").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect());
    await delAll(await ctx.db.query("experiments").withIndex("by_site_status", (q) => q.eq("siteId", siteId)).collect());
    await delAll(await ctx.db.query("orders").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect());

    await ctx.db.delete(siteId);
    removed++;
    return { deleted: true, site: site.name, rowsRemoved: removed };
  },
});

/** Delete a single creative by id (used to drop the placeholder creative directly). */
export const deleteCreative = mutation({
  args: { creativeId: v.id("creatives") },
  handler: async (ctx, { creativeId }) => {
    const c = await ctx.db.get(creativeId);
    if (!c) return { deleted: false };
    await ctx.db.delete(creativeId);
    return { deleted: true, r2Key: c.r2Key };
  },
});

/** Delete a single action by id. */
export const deleteAction = mutation({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }) => {
    const a = await ctx.db.get(actionId);
    if (!a) return { deleted: false };
    await ctx.db.delete(actionId);
    return { deleted: true, type: a.type };
  },
});
