// Admin maintenance mutations — demo-data teardown for the Phase-1 spike.
//
// The Phase-0 scaffold seeded placeholder tenants (e.g. "Nimbus Home", "Aurora Pet Co."), a
// placeholder creative pointing at creatives/placeholder/pending.mp4, and a sample proposed action.
// Once the real Calm-Collar creative exists we purge that demo data so the dashboard shows ONLY
// real, generated assets. These mutations are deliberately explicit (delete by id) rather than a
// blanket wipe, so they can never touch a real site.
import { mutation } from "./authz";
import { v } from "convex/values";
import { deleteSiteProjections, projectActionTransition, projectCreativeTransition, projectProductTransition } from "./dashboardProjections";

/**
 * Cascade-delete a single site and everything scoped to it: creatives, posts, actions, auditLog,
 * generation intents/variants, products, signals, metrics, siteSecrets, experiments, orders.
 * Index-driven (no full scans).
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
    await delAll(await ctx.db.query("creativeGenerationVariants").withIndex("by_site_updated", (q) => q.eq("siteId", siteId)).collect());
    await delAll(await ctx.db.query("creativeGenerationIntents").withIndex("by_site_updated", (q) => q.eq("siteId", siteId)).collect());
    await delAll(await ctx.db.query("posts").withIndex("by_site_status", (q) => q.eq("siteId", siteId)).collect());
    await delAll(await ctx.db.query("actions").withIndex("by_site_status", (q) => q.eq("siteId", siteId)).collect());
    await delAll(await ctx.db.query("auditLog").withIndex("by_site_at", (q) => q.eq("siteId", siteId)).collect());
    await delAll(await ctx.db.query("products").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect());
    await delAll(await ctx.db.query("productSignals").withIndex("by_site_day", (q) => q.eq("siteId", siteId)).collect());
    await delAll(await ctx.db.query("conversionMetrics").withIndex("by_site_day", (q) => q.eq("siteId", siteId)).collect());
    await delAll(await ctx.db.query("siteSecrets").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect());
    await delAll(await ctx.db.query("experiments").withIndex("by_site_status", (q) => q.eq("siteId", siteId)).collect());
    await delAll(await ctx.db.query("orders").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect());

    await deleteSiteProjections(ctx, site);
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
    await projectCreativeTransition(ctx, c, null);
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
    await projectActionTransition(ctx, a, null);
    return { deleted: true, type: a.type };
  },
});

/**
 * Delete a single product by id, plus any audit entries that reference it in their detail.
 * Used to tear down screenshot-seed products without disturbing the rest of the brand.
 */
export const deleteProduct = mutation({
  args: { productId: v.id("products") },
  handler: async (ctx, { productId }) => {
    const p = await ctx.db.get(productId);
    if (!p) return { deleted: false };
    // remove product_created / product_updated audit rows that point at this productId
    const audit = await ctx.db
      .query("auditLog")
      .withIndex("by_site_at", (q) => q.eq("siteId", p.siteId))
      .collect();
    let auditRemoved = 0;
    for (const row of audit) {
      const d = row.detail as { productId?: string } | null;
      if (d && d.productId === productId) {
        await ctx.db.delete(row._id);
        auditRemoved++;
      }
    }
    await ctx.db.delete(productId);
    await projectProductTransition(ctx, p, null);
    return { deleted: true, title: p.title, auditRemoved };
  },
});
