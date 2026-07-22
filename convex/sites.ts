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

const snapshotProductStatus = v.union(
  v.literal("draft"), v.literal("active"), v.literal("archived"),
);
const snapshotFulfillmentStatus = v.union(
  v.literal("received"), v.literal("shipped"),
);
const snapshotCreditAdjustmentState = v.union(v.literal("none"), v.literal("partial"), v.literal("full"));
const SHOPIFY_ECONOMICS_CANONICAL_SINCE_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const ADVANCED_ORDER = { received: 0, sent_to_cj: 1, shipped: 2, delivered: 3, error: 0 } as const;

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

/**
 * The sole success boundary for a Shopify economics snapshot. Convex applies every catalogue,
 * order, reconciliation, audit, count, and current-marker write as one transaction. Counts are
 * derived from the validated snapshot arrays and no caller can assert success independently.
 */
export const commitEconomicsSnapshot = mutation({
  args: {
    siteId: v.id("sites"),
    attemptId: v.string(),
    snapshotReadAt: v.number(),
    products: v.array(v.object({
      shopifyProductId: v.string(), title: v.string(), priceUsd: v.number(), status: snapshotProductStatus,
      imageUrl: v.optional(v.string()),
    })),
    orders: v.array(v.object({
      shopifyOrderId: v.string(), currencyCode: v.string(), currentTotal: v.number(),
      financialStatus: v.string(), test: v.boolean(), cancelled: v.boolean(),
      creditAdjustmentState: snapshotCreditAdjustmentState,
      fulfillmentStatus: snapshotFulfillmentStatus, createdAt: v.number(),
    })),
  },
  handler: async (ctx, { siteId, attemptId, snapshotReadAt, products, orders }) => {
    await requireServiceIdentity(ctx);
    const site = await ctx.db.get(siteId);
    if (!site || site.shopifyEconomicsSyncAttemptId !== attemptId) {
      throw new Error("Shopify economics sync attempt was superseded");
    }
    if (site.shopifyEconomicsSyncStatus !== "pending") throw new Error("Shopify economics sync attempt is not active");
    if (!site.shopifyDomain || site.sample === true || site.storeCurrency !== "USD" || !Number.isFinite(site.shopifyAccessVerifiedAt)) {
      throw new Error("verified USD Shopify identity is required for economics snapshot commit");
    }
    const attemptedAt = site.shopifyEconomicsSyncAttemptedAt;
    if (!Number.isFinite(attemptedAt)) throw new Error("Shopify economics sync attempt has no durable start fence");
    const finishedAt = Date.now();
    if (!Number.isFinite(snapshotReadAt) || snapshotReadAt < attemptedAt! || snapshotReadAt > finishedAt) {
      throw new Error("Shopify economics snapshot read fence is invalid");
    }

    // A diagnostic window can be read, but it can never mutate or become launch-current.
    if (site.shopifyEconomicsSyncSinceDays !== SHOPIFY_ECONOMICS_CANONICAL_SINCE_DAYS) {
      await ctx.db.patch(siteId, { shopifyEconomicsSyncStatus: "incomplete" });
      await appendAudit(ctx, { siteId, event: "shopify_economics_sync_incomplete", detail: { attemptId, reason: "noncanonical_window", sinceDays: site.shopifyEconomicsSyncSinceDays } });
      return { status: "incomplete" as const, productCount: products.length, orderCount: orders.length, finishedAt };
    }
    if (products.length > 250 || orders.length > 250) throw new Error("Shopify economics snapshot exceeds the bounded provider read cap");

    const productIds = new Set<string>();
    for (const product of products) {
      if (!product.shopifyProductId.startsWith("gid://shopify/Product/") || productIds.has(product.shopifyProductId)) {
        throw new Error("complete Shopify catalogue snapshot contains an invalid or duplicate product identity");
      }
      if (!product.title.trim() || !Number.isFinite(product.priceUsd) || product.priceUsd < 0) {
        throw new Error("complete Shopify catalogue snapshot contains invalid product facts");
      }
      productIds.add(product.shopifyProductId);
    }
    const orderIds = new Set<string>();
    const cutoff = attemptedAt! - SHOPIFY_ECONOMICS_CANONICAL_SINCE_DAYS * DAY_MS;
    for (const order of orders) {
      if (!order.shopifyOrderId.startsWith("gid://shopify/Order/") || orderIds.has(order.shopifyOrderId)) {
        throw new Error("complete Shopify order snapshot contains an invalid or duplicate order identity");
      }
      if (order.currencyCode !== "USD" || !Number.isFinite(order.currentTotal) || order.currentTotal < 0
        || !Number.isFinite(order.createdAt) || order.createdAt < cutoff || order.createdAt > finishedAt + DAY_MS
        || !order.financialStatus.trim()) {
        throw new Error("complete Shopify order snapshot contains invalid or out-of-window facts");
      }
      orderIds.add(order.shopifyOrderId);
    }

    const existingProducts = await ctx.db.query("products").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect();
    const existingOrders = await ctx.db.query("orders").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect();
    const productsByProviderId = new Map<string, (typeof existingProducts)[number]>();
    for (const product of existingProducts) {
      if (!product.shopifyProductId) continue;
      if (productsByProviderId.has(product.shopifyProductId)) throw new Error("local Shopify product identity is ambiguous");
      productsByProviderId.set(product.shopifyProductId, product);
    }
    const ordersByProviderId = new Map<string, (typeof existingOrders)[number]>();
    for (const order of existingOrders) {
      if (ordersByProviderId.has(order.shopifyOrderId)) throw new Error("local Shopify order identity is ambiguous");
      ordersByProviderId.set(order.shopifyOrderId, order);
    }

    // If an independently observed provider row appeared after this attempt began but is absent
    // from its reads, the reads raced provider state. Preserve that row and write no snapshot.
    const racedProduct = existingProducts.some((product) => product.shopifyProductId
      && !productIds.has(product.shopifyProductId)
      && ((product.shopifyObservedAt ?? product._creationTime) > attemptedAt!));
    const racedOrder = existingOrders.some((order) => order.createdAt >= cutoff
      && !orderIds.has(order.shopifyOrderId)
      && ((order.shopifyObservedAt ?? order._creationTime) > attemptedAt!));
    if (racedProduct || racedOrder) {
      await ctx.db.patch(siteId, { shopifyEconomicsSyncStatus: "incomplete" });
      await appendAudit(ctx, { siteId, event: "shopify_economics_sync_incomplete", detail: { attemptId, reason: "provider_observation_race", racedProduct, racedOrder } });
      return { status: "incomplete" as const, productCount: products.length, orderCount: orders.length, finishedAt };
    }

    for (const product of products) {
      const existing = productsByProviderId.get(product.shopifyProductId);
      if (existing) {
        const observedAfterRead = (existing.shopifyObservedAt ?? 0) > snapshotReadAt;
        const status = product.status === "active" && existing.status !== "active" ? "draft" : product.status;
        await ctx.db.patch(existing._id, {
          ...(!observedAfterRead ? { title: product.title, priceUsd: product.priceUsd, status } : {}),
          shopifyObservedAt: observedAfterRead ? existing.shopifyObservedAt : snapshotReadAt,
          shopifyEconomicsSnapshotAttemptId: attemptId,
          shopifyEconomicsExcludedAt: undefined,
          sample: false,
        });
      } else {
        await ctx.db.insert("products", {
          siteId, title: product.title, shopifyProductId: product.shopifyProductId,
          cjFromUsWarehouse: false, cogsUsd: 0, shippingUsd: 0, priceUsd: product.priceUsd,
          status: product.status === "active" ? "draft" : product.status,
          shopifyObservedAt: snapshotReadAt, shopifyEconomicsSnapshotAttemptId: attemptId,
          createdAt: finishedAt, sample: false,
        });
      }
    }
    for (const existing of existingProducts) {
      if (!existing.shopifyProductId || productIds.has(existing.shopifyProductId)) continue;
      await ctx.db.patch(existing._id, {
        status: "archived",
        shopifyEconomicsSnapshotAttemptId: undefined,
        shopifyEconomicsExcludedAt: finishedAt,
      });
    }

    for (const order of orders) {
      const existing = ordersByProviderId.get(order.shopifyOrderId);
      if (existing) {
        const fieldObservedAt = existing.shopifyEconomicFieldObservedAt;
        const newer = (field: keyof NonNullable<typeof fieldObservedAt>) => (fieldObservedAt?.[field] ?? 0) > snapshotReadAt;
        const currencyCode = newer("currencyCode") ? existing.currencyCode : order.currencyCode;
        const currentTotal = newer("currentTotal") ? existing.currentTotal : order.currentTotal;
        const financialStatus = newer("financialStatus") ? existing.financialStatus : order.financialStatus;
        const test = newer("test") ? existing.test : order.test;
        const cancelled = newer("cancelled") ? existing.cancelled : order.cancelled;
        const creditAdjustmentState = newer("creditAdjustmentState") ? existing.creditAdjustmentState : order.creditAdjustmentState;
        const nextStatus = ADVANCED_ORDER[order.fulfillmentStatus] > ADVANCED_ORDER[existing.fulfillmentStatus]
          ? order.fulfillmentStatus : existing.fulfillmentStatus;
        await ctx.db.patch(existing._id, {
          currencyCode, currentTotal, financialStatus, test, cancelled, creditAdjustmentState,
          totalUsd: currencyCode === "USD" ? currentTotal : undefined,
          fulfillmentStatus: nextStatus,
          shopifyObservedAt: (existing.shopifyObservedAt ?? 0) > snapshotReadAt ? existing.shopifyObservedAt : snapshotReadAt,
          shopifyEconomicsSnapshotAttemptId: attemptId,
          shopifyEconomicsExcludedAt: undefined,
          sample: false,
        });
      } else {
        await ctx.db.insert("orders", {
          siteId, shopifyOrderId: order.shopifyOrderId, fulfillmentStatus: order.fulfillmentStatus,
          currencyCode: order.currencyCode, currentTotal: order.currentTotal,
          financialStatus: order.financialStatus, test: order.test, cancelled: order.cancelled,
          creditAdjustmentState: order.creditAdjustmentState, totalUsd: order.currentTotal,
          shopifyObservedAt: snapshotReadAt, shopifyEconomicsSnapshotAttemptId: attemptId,
          createdAt: order.createdAt, sample: false,
        });
      }
    }
    for (const existing of existingOrders) {
      if (existing.createdAt < cutoff || orderIds.has(existing.shopifyOrderId)) continue;
      await ctx.db.patch(existing._id, {
        shopifyEconomicsSnapshotAttemptId: undefined,
        shopifyEconomicsExcludedAt: finishedAt,
      });
    }

    const productCount = products.length;
    const orderCount = orders.length;
    await ctx.db.patch(siteId, {
      shopifyEconomicsSyncStatus: "current",
      shopifyEconomicsSyncSucceededAt: finishedAt,
      shopifyEconomicsSyncProductCount: productCount,
      shopifyEconomicsSyncOrderCount: orderCount,
    });
    await appendAudit(ctx, {
      siteId,
      event: "shopify_economics_sync_current",
      detail: { attemptId, productCount, orderCount, sinceDays: SHOPIFY_ECONOMICS_CANONICAL_SINCE_DAYS },
    });
    return { finishedAt, status: "current" as const, productCount, orderCount };
  },
});

/** Failure/incomplete is deliberately incapable of writing mirror rows or claiming success. */
export const markEconomicsSyncNotCurrent = mutation({
  args: {
    siteId: v.id("sites"), attemptId: v.string(),
    status: v.union(v.literal("failed"), v.literal("incomplete")),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { siteId, attemptId, status, reason }) => {
    await requireServiceIdentity(ctx);
    const site = await ctx.db.get(siteId);
    if (!site || site.shopifyEconomicsSyncAttemptId !== attemptId || site.shopifyEconomicsSyncStatus !== "pending") {
      return { ignored: true as const, status };
    }
    await ctx.db.patch(siteId, { shopifyEconomicsSyncStatus: status });
    await appendAudit(ctx, { siteId, event: `shopify_economics_sync_${status}`, detail: { attemptId, ...(reason ? { reason } : {}) } });
    return { ignored: false as const, status };
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
