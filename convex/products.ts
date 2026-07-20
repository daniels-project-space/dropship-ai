// Catalog CRUD. siteId-scoped; index-driven reads only.
import { query, mutation } from "./authz";
import { v } from "convex/values";
import { appendAudit } from "./audit";

const productStatus = v.union(
  v.literal("draft"),
  v.literal("active"),
  v.literal("archived"),
  v.literal("killed"),
);

// Insert-or-update keyed on (siteId + cjProductId) when present, else creates new.
export const upsert = mutation({
  args: {
    siteId: v.id("sites"),
    title: v.string(),
    cogsUsd: v.number(),
    shippingUsd: v.number(),
    priceUsd: v.number(),
    cjFromUsWarehouse: v.boolean(),
    shopifyProductId: v.optional(v.string()),
    cjProductId: v.optional(v.string()),
    contributionMarginPct: v.optional(v.number()),
    status: v.optional(productStatus),
  },
  handler: async (ctx, args) => {
    const { status, cjProductId, ...rest } = args;
    // Dedup by cjProductId within the site if one was supplied.
    if (cjProductId) {
      const existing = await ctx.db
        .query("products")
        .withIndex("by_site", (q) => q.eq("siteId", args.siteId))
        .filter((q) => q.eq(q.field("cjProductId"), cjProductId))
        .first();
      if (existing) {
        const patch = { ...rest, cjProductId, ...(status ? { status } : {}) };
        await ctx.db.patch(existing._id, patch);
        await appendAudit(ctx, { siteId: args.siteId, event: "product_updated", detail: { productId: existing._id, title: args.title } });
        return existing._id;
      }
    }
    const productId = await ctx.db.insert("products", {
      ...rest,
      cjProductId,
      status: status ?? "draft",
      createdAt: Date.now(),
    });
    await appendAudit(ctx, { siteId: args.siteId, event: "product_created", detail: { productId, title: args.title } });
    return productId;
  },
});

// Bulk idempotent upsert of REAL Shopify products (keyed on siteId + shopifyProductId).
// cogsUsd/shippingUsd stay 0 (unknown until CJ sourcing) and contributionMarginPct is left
// undefined; the dashboard derives a price-only margin when those are absent. Every row is
// written sample:false so it replaces — and is never confused with — seeded demo data.
export const upsertFromShopify = mutation({
  args: {
    siteId: v.id("sites"),
    products: v.array(
      v.object({
        shopifyProductId: v.string(),
        title: v.string(),
        priceUsd: v.number(),
        status: productStatus,
        imageUrl: v.optional(v.string()), // accepted for parity; schema has no image column (ignored)
      }),
    ),
  },
  handler: async (ctx, { siteId, products }) => {
    let inserted = 0;
    let updated = 0;
    for (const p of products) {
      const existing = await ctx.db
        .query("products")
        .withIndex("by_site", (q) => q.eq("siteId", siteId))
        .filter((q) => q.eq(q.field("shopifyProductId"), p.shopifyProductId))
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, {
          title: p.title,
          priceUsd: p.priceUsd,
          status: p.status,
          sample: false,
        });
        updated++;
      } else {
        await ctx.db.insert("products", {
          siteId,
          title: p.title,
          shopifyProductId: p.shopifyProductId,
          cjFromUsWarehouse: false,
          cogsUsd: 0,
          shippingUsd: 0,
          priceUsd: p.priceUsd,
          status: p.status,
          createdAt: Date.now(),
          sample: false,
        });
        inserted++;
      }
    }
    return { inserted, updated, total: products.length };
  },
});

export const listBySite = query({
  args: {
    siteId: v.id("sites"),
    status: v.optional(productStatus),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { siteId, status, limit }) => {
    if (status) {
      return ctx.db
        .query("products")
        .withIndex("by_site_status", (q) => q.eq("siteId", siteId).eq("status", status))
        .order("desc")
        .take(limit ?? 200);
    }
    return ctx.db
      .query("products")
      .withIndex("by_site", (q) => q.eq("siteId", siteId))
      .order("desc")
      .take(limit ?? 200);
  },
});

export const setStatus = mutation({
  args: { productId: v.id("products"), status: productStatus },
  handler: async (ctx, { productId, status }) => {
    const product = await ctx.db.get(productId);
    if (!product) throw new Error(`product ${productId} not found`);
    await ctx.db.patch(productId, { status });
    await appendAudit(ctx, { siteId: product.siteId, event: "product_status_changed", detail: { productId, status } });
    return productId;
  },
});

export const get = query({
  args: { productId: v.id("products") },
  handler: async (ctx, { productId }) => ctx.db.get(productId),
});

// Cross-brand candidate catalog for the global Research page. Optionally scoped to ONE
// brand. Index-driven per site (by_site / by_site_status), merged + tagged with siteName.
export const listAllAcrossBrands = query({
  args: { siteId: v.optional(v.id("sites")), status: v.optional(productStatus), limit: v.optional(v.number()) },
  handler: async (ctx, { siteId, status, limit }) => {
    const cap = limit ?? 200;
    const allSites = await ctx.db.query("sites").take(200);
    const sites = siteId ? allSites.filter((s) => s._id === siteId) : allSites;

    const out: Array<Record<string, unknown>> = [];
    for (const s of sites) {
      const rows = status
        ? await ctx.db
            .query("products")
            .withIndex("by_site_status", (q) => q.eq("siteId", s._id).eq("status", status))
            .order("desc")
            .take(cap)
        : await ctx.db
            .query("products")
            .withIndex("by_site", (q) => q.eq("siteId", s._id))
            .order("desc")
            .take(cap);
      for (const r of rows) out.push({ ...r, siteName: s.name });
    }
    out.sort((a, b) => (b.createdAt as number) - (a.createdAt as number));
    return out.slice(0, cap);
  },
});
