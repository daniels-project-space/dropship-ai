// Tenant (store/brand) CRUD. One row per site; everything else is siteId-scoped.
import { query, mutation } from "./authz";
import { v } from "convex/values";
import { appendAudit } from "./audit";
import { isMyshopifyDomain, SHOPIFY_TOKEN_KEY, vaultRefForDomain } from "../src/lib/shopifyIdentity";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const siteStatus = v.union(
  v.literal("provisioning"),
  v.literal("active"),
  v.literal("paused"),
  v.literal("killed"),
);

async function requireServiceIdentity(ctx: { auth: { getUserIdentity: () => Promise<{ subject?: string } | null> } }) {
  if ((await ctx.auth.getUserIdentity())?.subject !== "dropship-ai:service") throw new Error("UNAUTHENTICATED: Shopify connection verification requires the service runtime");
}

async function requireUnaliasedVaultRef(ctx: MutationCtx, siteId: Id<"sites">, vaultRef: string) {
  const aliases = await ctx.db.query("siteSecrets")
    .withIndex("by_key_vault_ref", (q) => q.eq("key", SHOPIFY_TOKEN_KEY).eq("vaultRef", vaultRef))
    .take(3);
  if (aliases.some((row) => row.siteId !== siteId)) {
    throw new Error("Shopify vault reference is already bound to another site; aliased domains require distinct credentials");
  }
}

export const create = mutation({
  args: {
    name: v.string(),
    niche: v.string(),
    minKitPriceUsd: v.number(),
    minBlendedMarginPct: v.number(),
    distributionMode: v.union(v.literal("semi_manual"), v.literal("automated")),
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

// Resolve the signed webhook's shop identity only when it maps to one active, non-sample tenant.
export const getByDomain = query({
  args: { shopifyDomain: v.string() },
  handler: async (ctx, { shopifyDomain }) => {
    const sites = await ctx.db.query("sites").withIndex("by_shopify_domain", (q) => q.eq("shopifyDomain", shopifyDomain)).take(3);
    const eligible = sites.filter((site) => site.sample !== true && site.status === "active");
    return eligible.length === 1 ? eligible[0] : null;
  },
});

// Connect a real Shopify store to a site: stamp the verified myshopify domain, flip status to
// active, and clear the `sample` flag so the dashboard + SampleDataPill stop treating it as demo
// data. Read-only connection (Phase 2a) — no fulfillment wiring. Idempotent.
export const connectStore = mutation({
  args: { siteId: v.id("sites"), shopifyDomain: v.string(), storeCurrency: v.string() },
  handler: async (ctx, { siteId, shopifyDomain, storeCurrency }) => {
    await requireServiceIdentity(ctx);
    const existing = await ctx.db.get(siteId);
    if (!existing) throw new Error(`site ${siteId} not found`);
    if (existing.sample === true) throw new Error("sample site cannot become live; clear sample data and create a real site first");
    if (!isMyshopifyDomain(shopifyDomain)) throw new Error("Shopify domain must be a canonical myshopify.com domain");
    if (storeCurrency !== "USD") throw new Error(`unsupported Shopify store currency ${storeCurrency}; launch analytics require a USD store until conversion is implemented`);
    if (existing.shopifyDomain && existing.shopifyDomain !== shopifyDomain) {
      throw new Error("connected Shopify domain cannot be changed; an explicit migration is required");
    }
    const domainOwners = await ctx.db.query("sites").withIndex("by_shopify_domain", (q) => q.eq("shopifyDomain", shopifyDomain)).take(2);
    if (domainOwners.some((site) => site._id !== siteId && site.sample !== true)) throw new Error("Shopify domain is already connected to another site");
    const vaultRef = vaultRefForDomain(shopifyDomain);
    await requireUnaliasedVaultRef(ctx, siteId, vaultRef);
    const secretRefs = await ctx.db.query("siteSecrets")
      .withIndex("by_site_key", (q) => q.eq("siteId", siteId).eq("key", SHOPIFY_TOKEN_KEY)).take(2);
    if (secretRefs.length > 1) throw new Error("Shopify recurring vault reference is ambiguous");
    const secretRef = secretRefs[0];
    if (secretRef) await ctx.db.patch(secretRef._id, { vaultRef });
    else await ctx.db.insert("siteSecrets", { siteId, key: SHOPIFY_TOKEN_KEY, vaultRef });
    const verifiedAt = Date.now();
    await ctx.db.patch(siteId, {
      shopifyDomain,
      storeCurrency,
      shopifyAccessVerifiedAt: verifiedAt,
      shopifyEconomicsSyncStatus: "pending",
      shopifyEconomicsSyncAttemptedAt: verifiedAt,
      status: "active",
      sample: false,
    });
    await appendAudit(ctx, { siteId, event: "shopify_store_connected", detail: { shopifyDomain, storeCurrency } });
    return siteId;
  },
});

// A recurring sync re-reads Shopify first. This mutation atomically backfills the verified USD
// identity and re-persists the existing deterministic vault reference before economic facts move.
export const verifyConnectedStore = mutation({
  args: { siteId: v.id("sites"), shopifyDomain: v.string(), storeCurrency: v.string() },
  handler: async (ctx, { siteId, shopifyDomain, storeCurrency }) => {
    await requireServiceIdentity(ctx);
    if (!isMyshopifyDomain(shopifyDomain)) throw new Error("Shopify domain must be a canonical myshopify.com domain");
    const site = await ctx.db.get(siteId);
    if (!site || site.shopifyDomain !== shopifyDomain) throw new Error("connected Shopify domain changed during verification");
    if (storeCurrency !== "USD") throw new Error(`unsupported Shopify store currency ${storeCurrency}; launch analytics require a USD store until conversion is implemented`);
    const expectedRef = vaultRefForDomain(shopifyDomain);
    await requireUnaliasedVaultRef(ctx, siteId, expectedRef);
    const secretRefs = await ctx.db.query("siteSecrets")
      .withIndex("by_site_key", (q) => q.eq("siteId", siteId).eq("key", SHOPIFY_TOKEN_KEY)).take(2);
    if (secretRefs.length !== 1) throw new Error("Shopify recurring vault reference requires re-verification");
    const secretRef = secretRefs[0];
    if (!secretRef || secretRef.vaultRef !== expectedRef) throw new Error("Shopify recurring vault reference requires re-verification");
    const verifiedAt = Date.now();
    await ctx.db.patch(secretRef._id, { vaultRef: expectedRef });
    await ctx.db.patch(siteId, { storeCurrency, shopifyAccessVerifiedAt: verifiedAt });
    await appendAudit(ctx, { siteId, event: "shopify_recurring_access_verified", detail: { shopifyDomain, storeCurrency } });
    return { verifiedAt };
  },
});

export const beginEconomicsSync = mutation({
  args: { siteId: v.id("sites"), attemptId: v.string(), sinceDays: v.number() },
  handler: async (ctx, { siteId, attemptId, sinceDays }) => {
    await requireServiceIdentity(ctx);
    const site = await ctx.db.get(siteId);
    if (!site?.shopifyDomain || site.sample === true) throw new Error("a real connected Shopify site is required before economics sync");
    if (!/^[A-Za-z0-9-]{1,100}$/.test(attemptId)) throw new Error("invalid Shopify sync attempt identity");
    if (!Number.isInteger(sinceDays) || sinceDays < 1 || sinceDays > 60) throw new Error("invalid Shopify sync coverage window");
    const attemptedAt = Date.now();
    await ctx.db.patch(siteId, {
      shopifyEconomicsSyncStatus: "pending",
      shopifyEconomicsSyncAttemptId: attemptId,
      shopifyEconomicsSyncAttemptedAt: attemptedAt,
      shopifyEconomicsSyncSinceDays: sinceDays,
    });
    await appendAudit(ctx, { siteId, event: "shopify_economics_sync_started", detail: { attemptId, sinceDays } });
    return { attemptedAt };
  },
});

export const finishEconomicsSync = mutation({
  args: {
    siteId: v.id("sites"),
    attemptId: v.string(),
    status: v.union(v.literal("current"), v.literal("failed"), v.literal("incomplete")),
    productCount: v.optional(v.number()),
    orderCount: v.optional(v.number()),
  },
  handler: async (ctx, { siteId, attemptId, status, productCount, orderCount }) => {
    await requireServiceIdentity(ctx);
    const site = await ctx.db.get(siteId);
    if (!site || site.shopifyEconomicsSyncAttemptId !== attemptId) {
      throw new Error("Shopify economics sync attempt was superseded");
    }
    const finishedAt = Date.now();
    if (status === "current") {
      if (!Number.isInteger(productCount) || productCount! < 0 || !Number.isInteger(orderCount) || orderCount! < 0) {
        throw new Error("complete Shopify economics sync requires durable row counts");
      }
      await ctx.db.patch(siteId, {
        shopifyEconomicsSyncStatus: status,
        shopifyEconomicsSyncSucceededAt: finishedAt,
        shopifyEconomicsSyncProductCount: productCount,
        shopifyEconomicsSyncOrderCount: orderCount,
      });
    } else {
      // Preserve the last successful timestamp/counts as evidence while latest-attempt state fails closed.
      await ctx.db.patch(siteId, { shopifyEconomicsSyncStatus: status });
    }
    await appendAudit(ctx, {
      siteId,
      event: `shopify_economics_sync_${status}`,
      detail: { attemptId, ...(productCount !== undefined ? { productCount } : {}), ...(orderCount !== undefined ? { orderCount } : {}) },
    });
    return { finishedAt, status };
  },
});

export const update = mutation({
  args: {
    siteId: v.id("sites"),
    name: v.optional(v.string()),
    niche: v.optional(v.string()),
    status: v.optional(siteStatus),
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
