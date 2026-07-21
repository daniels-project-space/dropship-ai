// Catalog CRUD. siteId-scoped; index-driven reads only.
import { query, mutation } from "./authz";
import { v } from "convex/values";
import { appendAudit } from "./audit";
import { evaluatePersistedCjEvidence } from "../src/lib/sourcingPolicy";
import { hasVerifiedInternalShopifyDraftLineage } from "../src/lib/shopifyDraftLineage";

const productStatus = v.union(
  v.literal("draft"),
  v.literal("active"),
  v.literal("archived"),
  v.literal("killed"),
);

/** Provider-read facts and provider-write state transitions are server-to-server only. */
async function requireServiceIdentity(ctx: { auth: { getUserIdentity: () => Promise<{ subject?: string } | null> } }): Promise<void> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity?.subject !== "dropship-ai:service") {
    throw new Error("UNAUTHENTICATED: a service identity is required for provider evidence");
  }
}

// Insert-or-update for non-CJ catalog rows. CJ-linked candidates always use
// createSourcedDraft(), which owns evidence and economics.
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
    // A CJ-linked draft must go through createSourcedDraft(), which verifies inventory and
    // computes the full contribution margin server-side. This generic mutation remains for
    // Shopify mirrors and non-supplier catalog maintenance only.
    if (args.cjProductId) throw new Error("CJ-sourced products must use products.createSourcedDraft");
    if (args.status === "active") throw new Error("products.upsert cannot activate a product; use products.setStatus after verified sourcing");
    const { status, cjProductId: _cjProductId, ...rest } = args;
    const productId = await ctx.db.insert("products", {
      ...rest,
      status: status ?? "draft",
      createdAt: Date.now(),
    });
    await appendAudit(ctx, { siteId: args.siteId, event: "product_created", detail: { productId, title: args.title } });
    return productId;
  },
});

/**
 * The sole local-write boundary for a CJ-sourced product candidate. It only ever creates/updates
 * a local `draft`; it does not create a Shopify product, request CJ sourcing, or pay/order
 * anything. Unsafe candidates are deliberately denied with an auditable result rather than
 * becoming catalog rows.
 */
export const createSourcedDraft = mutation({
  args: {
    siteId: v.id("sites"),
    evidenceId: v.id("cjEvidence"),
    priceUsd: v.number(),
  },
  handler: async (ctx, args) => {
    const site = await ctx.db.get(args.siteId);
    if (!site) throw new Error(`site ${args.siteId} not found`);
    const evidence = await ctx.db.get(args.evidenceId);
    if (!evidence || evidence.siteId !== args.siteId) throw new Error("CJ evidence was not found for this site");
    const denied = async (reason: string, detail: Record<string, unknown> = {}) => {
      await appendAudit(ctx, {
        siteId: args.siteId,
        event: "product_sourced_draft_denied",
        detail: { evidenceId: args.evidenceId, cjProductId: evidence.cjProductId, cjVariantId: evidence.cjVariantId, reason, ...detail },
      });
      return { status: "denied" as const, reason };
    };
    const gate = evaluatePersistedCjEvidence(evidence, {
      priceUsd: args.priceUsd,
      minimumPriceUsd: site.minKitPriceUsd,
      minimumMarginPct: site.minBlendedMarginPct,
    });
    if (!gate.eligible) return denied(gate.reason, gate.economics ? { contributionMarginPct: gate.economics.contributionMarginPct, minimumMarginPct: site.minBlendedMarginPct } : {});
    const economics = gate.economics;
    const existing = await ctx.db
      .query("products")
      .withIndex("by_site", (q) => q.eq("siteId", args.siteId))
      .filter((q) => q.eq(q.field("cjProductId"), evidence.cjProductId))
      .filter((q) => q.eq(q.field("cjVariantId"), evidence.cjVariantId))
      .first();
    if (existing && existing.status !== "draft") return denied("source is already catalogued", { productId: existing._id, status: existing.status });

    const record = {
      title: evidence.title,
      cjProductId: evidence.cjProductId,
      cjVariantId: evidence.cjVariantId,
      cjEvidenceId: evidence._id,
      cjFromUsWarehouse: true,
      sourceUrl: evidence.sourceUrl,
      sourceVerifiedAt: evidence.readAt,
      cogsUsd: economics.cogsUsd,
      shippingUsd: economics.shippingUsd,
      dutyUsd: economics.dutyUsd,
      paymentFeeUsd: economics.paymentFeeUsd,
      refundReserveUsd: economics.refundReserveUsd,
      contentCostUsd: economics.contentCostUsd,
      landedCostUsd: economics.landedCostUsd,
      priceUsd: args.priceUsd,
      contributionMarginPct: economics.contributionMarginPct,
      status: "draft" as const,
      sample: false,
    };
    const productId = existing
      ? (await ctx.db.patch(existing._id, record), existing._id)
      : await ctx.db.insert("products", { siteId: args.siteId, ...record, createdAt: Date.now() });
    await appendAudit(ctx, {
      siteId: args.siteId,
      event: existing ? "product_sourced_draft_refreshed" : "product_sourced_draft_created",
      detail: {
        productId,
        evidenceId: evidence._id,
        traceId: evidence.traceId,
        cjProductId: evidence.cjProductId,
        cjVariantId: evidence.cjVariantId,
        contributionMarginPct: economics.contributionMarginPct,
        landedCostUsd: economics.landedCostUsd,
      },
    });
    return { status: "created" as const, productId, contributionMarginPct: economics.contributionMarginPct, landedCostUsd: economics.landedCostUsd };
  },
});

/** Persist parsed CJ read facts and an immutable success trace before catalog evaluation. */
export const recordCjEvidence = mutation({
  args: {
    siteId: v.id("sites"),
    cjProductId: v.string(),
    cjVariantId: v.string(),
    title: v.string(),
    cogsUsd: v.optional(v.number()),
    shippingUsd: v.optional(v.number()),
    inventoryQty: v.number(),
    fromUsWarehouse: v.boolean(),
    inventoryVerified: v.boolean(),
    sourceUrl: v.string(),
    traceId: v.string(),
    readAt: v.number(),
  },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const site = await ctx.db.get(args.siteId);
    if (!site) throw new Error(`site ${args.siteId} not found`);
    if (!args.title.trim() || !args.cjProductId.trim() || !args.cjVariantId.trim()) throw new Error("CJ evidence identifiers and title are required");
    if (!/^https:\/\/.+/i.test(args.sourceUrl)) throw new Error("CJ evidence sourceUrl must be HTTPS");
    if (!Number.isFinite(args.inventoryQty) || args.inventoryQty < 0) throw new Error("CJ evidence inventory must be non-negative");
    for (const [name, value] of [["cogsUsd", args.cogsUsd], ["shippingUsd", args.shippingUsd]] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error(`CJ evidence ${name} must be non-negative when known`);
    }
    const evidenceId = await ctx.db.insert("cjEvidence", args);
    await ctx.db.insert("traces", {
      traceId: args.traceId,
      siteId: args.siteId,
      operation: "cj.catalog.read",
      target: `cj:${args.cjProductId}:${args.cjVariantId}`,
      idempotencyKey: `cj:read:${args.traceId}`,
      status: "succeeded",
      detail: { evidenceId, sourceUrl: args.sourceUrl, costsKnown: args.cogsUsd !== undefined && args.shippingUsd !== undefined },
      startedAt: args.readAt,
      finishedAt: args.readAt,
    });
    await appendAudit(ctx, {
      siteId: args.siteId,
      event: "cj_evidence_persisted",
      detail: { evidenceId, traceId: args.traceId, cjProductId: args.cjProductId, cjVariantId: args.cjVariantId, costsKnown: args.cogsUsd !== undefined && args.shippingUsd !== undefined },
    });
    return { evidenceId, traceId: args.traceId };
  },
});

function actionMatchesApprovedDraftImport(action: { siteId: unknown; type: string; riskTier: string; status: string; params: unknown }, product: { siteId: unknown; _id: unknown; cjEvidenceId?: unknown; cjProductId?: unknown; cjVariantId?: unknown; priceUsd: number; cogsUsd: number; shippingUsd: number; landedCostUsd?: number; contributionMarginPct?: number; sourceVerifiedAt?: number }): boolean {
  if (action.siteId !== product.siteId || action.type !== "import_sourced_product" || action.riskTier !== "human_gated" || action.status !== "approved") return false;
  const params = action.params;
  return typeof params === "object" && params !== null
    && (params as Record<string, unknown>).productId === product._id
    && (params as Record<string, unknown>).evidenceId === product.cjEvidenceId
    && (params as Record<string, unknown>).cjProductId === product.cjProductId
    && (params as Record<string, unknown>).cjVariantId === product.cjVariantId
    && (params as Record<string, unknown>).priceUsd === product.priceUsd
    && (params as Record<string, unknown>).cogsUsd === product.cogsUsd
    && (params as Record<string, unknown>).shippingUsd === product.shippingUsd
    && (params as Record<string, unknown>).landedCostUsd === product.landedCostUsd
    && (params as Record<string, unknown>).contributionMarginPct === product.contributionMarginPct
    && (params as Record<string, unknown>).sourceVerifiedAt === product.sourceVerifiedAt;
}

/** Reserve one approved, draft-only Shopify import before crossing the provider boundary. */
export const reserveApprovedShopifyDraftImport = mutation({
  args: { siteId: v.id("sites"), productId: v.id("products"), actionId: v.id("actions"), traceId: v.string() },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const product = await ctx.db.get(args.productId);
    const action = await ctx.db.get(args.actionId);
    if (!product || product.siteId !== args.siteId) throw new Error("product was not found for this site");
    if (!action || !actionMatchesApprovedDraftImport(action, product)) throw new Error("a human-approved import action bound to this product evidence is required");
    if (product.status !== "draft") throw new Error("only local drafts can be imported to Shopify");
    if (!product.cjEvidenceId || !product.cjProductId || !product.cjVariantId) throw new Error("Shopify draft import requires persisted CJ evidence");
    const evidence = await ctx.db.get(product.cjEvidenceId);
    if (!evidence || evidence.siteId !== args.siteId || evidence.cjProductId !== product.cjProductId || evidence.cjVariantId !== product.cjVariantId) {
      throw new Error("Shopify draft import CJ evidence lineage is invalid");
    }
    const site = await ctx.db.get(args.siteId);
    if (!site) throw new Error(`site ${args.siteId} not found`);
    const gate = evaluatePersistedCjEvidence(evidence, {
      priceUsd: product.priceUsd,
      minimumPriceUsd: site.minKitPriceUsd,
      minimumMarginPct: site.minBlendedMarginPct,
    });
    if (!gate.eligible) throw new Error(`Shopify draft import denied: ${gate.reason}`);
    if (product.shopifyProductId || product.shopifyDraftImportStatus === "created") {
      const trace = product.shopifyDraftImportTraceId
        ? await ctx.db.query("traces").withIndex("by_trace_id", (q) => q.eq("traceId", product.shopifyDraftImportTraceId!)).first()
        : null;
      const importedHere = hasVerifiedInternalShopifyDraftLineage({
        shopifyProductId: product.shopifyProductId,
        shopifyDraftImportStatus: product.shopifyDraftImportStatus,
        trace,
      });
      if (!importedHere) {
        throw new Error("Shopify product is provider-mirrored or has incomplete draft-import lineage; reconcile provider state before retrying");
      }
      return { status: "already_created" as const, shopifyProductId: product.shopifyProductId };
    }
    if (product.shopifyDraftImportStatus) throw new Error(`Shopify draft import is ${product.shopifyDraftImportStatus}; reconcile before retrying`);
    await ctx.db.patch(args.productId, { shopifyDraftImportStatus: "creating", shopifyDraftImportTraceId: args.traceId });
    await ctx.db.insert("traces", {
      traceId: args.traceId,
      siteId: args.siteId,
      operation: "shopify.product.create_draft",
      target: `shopify:draft:${args.productId}`,
      idempotencyKey: `shopify:draft:${args.productId}`,
      status: "started",
      detail: { actionId: args.actionId, evidenceId: product.cjEvidenceId },
      startedAt: Date.now(),
    });
    await appendAudit(ctx, { siteId: args.siteId, actionId: args.actionId, event: "shopify_draft_import_reserved", detail: { productId: args.productId, traceId: args.traceId } });
    return { status: "reserved" as const };
  },
});

export const completeApprovedShopifyDraftImport = mutation({
  args: { siteId: v.id("sites"), productId: v.id("products"), actionId: v.id("actions"), traceId: v.string(), shopifyProductId: v.string() },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const product = await ctx.db.get(args.productId);
    const action = await ctx.db.get(args.actionId);
    if (!product || product.siteId !== args.siteId || !action || !actionMatchesApprovedDraftImport(action, product)) throw new Error("draft import lineage is invalid");
    if (product.shopifyDraftImportStatus !== "creating" || product.shopifyDraftImportTraceId !== args.traceId) throw new Error("draft import was not reserved by this trace");
    const trace = await ctx.db.query("traces").withIndex("by_trace_id", (q) => q.eq("traceId", args.traceId)).first();
    if (!trace) throw new Error("draft import trace is missing");
    const now = Date.now();
    await ctx.db.patch(args.productId, { shopifyProductId: args.shopifyProductId, shopifyDraftImportStatus: "created" });
    await ctx.db.patch(args.actionId, { status: "executed", resolvedAt: now });
    await ctx.db.patch(trace._id, { status: "succeeded", detail: { shopifyProductId: args.shopifyProductId, published: false }, finishedAt: now });
    await appendAudit(ctx, { siteId: args.siteId, actionId: args.actionId, event: "shopify_draft_imported", detail: { productId: args.productId, shopifyProductId: args.shopifyProductId, traceId: args.traceId, published: false } });
    return args.productId;
  },
});

/** Fail closed after a provider error: automatic retry could create a second Shopify product. */
export const markApprovedShopifyDraftImportAmbiguous = mutation({
  args: { siteId: v.id("sites"), productId: v.id("products"), actionId: v.id("actions"), traceId: v.string(), error: v.string() },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const product = await ctx.db.get(args.productId);
    const action = await ctx.db.get(args.actionId);
    if (!product || product.siteId !== args.siteId || !action || !actionMatchesApprovedDraftImport(action, product)) throw new Error("draft import lineage is invalid");
    if (product.shopifyDraftImportStatus !== "creating" || product.shopifyDraftImportTraceId !== args.traceId) throw new Error("draft import was not reserved by this trace");
    const trace = await ctx.db.query("traces").withIndex("by_trace_id", (q) => q.eq("traceId", args.traceId)).first();
    const now = Date.now();
    await ctx.db.patch(args.productId, { shopifyDraftImportStatus: "ambiguous" });
    if (trace) await ctx.db.patch(trace._id, { status: "failed", detail: { error: args.error, reconcileRequired: true }, finishedAt: now });
    await appendAudit(ctx, { siteId: args.siteId, actionId: args.actionId, event: "shopify_draft_import_ambiguous", detail: { productId: args.productId, traceId: args.traceId, reconcileRequired: true } });
    return args.productId;
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
        // A Shopify sync must never be an activation path. Existing active products retain their
        // state for observation, while DRAFT/unknown-cost products remain local drafts until the
        // verified evidence gate is explicitly passed through setStatus.
        const status = p.status === "active" && existing.status !== "active" ? "draft" : p.status;
        await ctx.db.patch(existing._id, {
          title: p.title,
          priceUsd: p.priceUsd,
          status,
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
          status: p.status === "active" ? "draft" : p.status,
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
    if (status === "active") {
      if (!product.cjEvidenceId || !product.cjProductId || !product.cjVariantId) {
        throw new Error("activation requires persisted CJ evidence");
      }
      const evidence = await ctx.db.get(product.cjEvidenceId);
      if (!evidence || evidence.siteId !== product.siteId || evidence.cjProductId !== product.cjProductId || evidence.cjVariantId !== product.cjVariantId) {
        throw new Error("activation CJ evidence lineage is invalid");
      }
      const site = await ctx.db.get(product.siteId);
      if (!site) throw new Error(`site ${product.siteId} not found`);
      const gate = evaluatePersistedCjEvidence(evidence, {
        priceUsd: product.priceUsd,
        minimumPriceUsd: site.minKitPriceUsd,
        minimumMarginPct: site.minBlendedMarginPct,
      });
      if (!gate.eligible) throw new Error(`activation denied: ${gate.reason}`);
      const economics = gate.economics;
      // Re-stamp only values derived from the lineage record, preventing stale UI values from
      // becoming the activation basis.
      await ctx.db.patch(productId, {
        cogsUsd: economics.cogsUsd,
        shippingUsd: economics.shippingUsd,
        dutyUsd: economics.dutyUsd,
        paymentFeeUsd: economics.paymentFeeUsd,
        refundReserveUsd: economics.refundReserveUsd,
        contentCostUsd: economics.contentCostUsd,
        landedCostUsd: economics.landedCostUsd,
        contributionMarginPct: economics.contributionMarginPct,
      });
    }
    await ctx.db.patch(productId, { status });
    await appendAudit(ctx, { siteId: product.siteId, event: "product_status_changed", detail: { productId, status, activationEvidenceId: status === "active" ? product.cjEvidenceId : undefined } });
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
