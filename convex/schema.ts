// Autonomous AI Dropshipping System — multi-tenant Convex schema (Phase 0 keystone)
// Verified-sound (SE-CoVe 2026-06-14). Every tenant-scoped table carries `siteId` + indexes;
// NEVER .collect() without .withIndex() (rmv2 read-blowup lesson). Time-series → daily rollups,
// counts → Aggregate component, not table scans.
//
// Reflects verification corrections: US-warehouse sourcing flag, AI-disclosure label on creatives,
// semi-manual publish path, risk-tiered actions + Trigger waitpoint approval, append-only audit.

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// ── shared enums ────────────────────────────────────────────────────────────
const riskTier = v.union(v.literal("auto"), v.literal("human_gated")); // money/ban-risk → human_gated
const actionStatus = v.union(
  v.literal("proposed"),
  v.literal("pending_approval"),
  v.literal("approved"),
  v.literal("rejected"),
  v.literal("executing"),
  v.literal("executed"),
  v.literal("failed"),
);
const platform = v.union(
  v.literal("tiktok"),
  v.literal("instagram"), // Reels
  v.literal("youtube"),   // Shorts
  v.literal("facebook"),
);
const postStatus = v.union(
  v.literal("draft"),
  v.literal("scheduled"),
  v.literal("awaiting_manual_publish"), // cold-start: Daniel taps publish (TikTok audit gate, §8.1)
  v.literal("published"),
  v.literal("failed"),
);

export default defineSchema({
  // ── tenants: one row per brand/store ──────────────────────────────────────
  sites: defineTable({
    name: v.string(),
    niche: v.string(),
    status: v.union(v.literal("provisioning"), v.literal("active"), v.literal("paused"), v.literal("killed")),
    shopifyDomain: v.optional(v.string()),        // *.myshopify.com (store created manually)
    customDomain: v.optional(v.string()),
    // brand/margin guardrails (enforced by the brain)
    minKitPriceUsd: v.number(),                   // §8.2 never below this (e.g. 35–55)
    minBlendedMarginPct: v.number(),              // standing margin gate (e.g. 70)
    distributionMode: v.union(v.literal("semi_manual"), v.literal("automated")), // §8.1 cold-start = semi_manual
    killDate: v.optional(v.number()),             // pre-committed kill date (ms)
    createdAt: v.number(),
    sample: v.optional(v.boolean()),              // seeded demo brand (cleared by seed.clearSampleData)
  }).index("by_status", ["status"]).index("by_sample", ["sample"]),

  // per-site credential REFERENCES (actual secrets live in env/vault; this maps which keys a site uses)
  siteSecrets: defineTable({
    siteId: v.id("sites"),
    key: v.string(),        // e.g. "SHOPIFY_ADMIN_TOKEN", "CJ_ACCESS_TOKEN"
    vaultRef: v.string(),   // pointer into the vault, NOT the secret value
  }).index("by_site", ["siteId"]).index("by_site_key", ["siteId", "key"]),

  // ── catalog ───────────────────────────────────────────────────────────────
  products: defineTable({
    siteId: v.id("sites"),
    title: v.string(),
    shopifyProductId: v.optional(v.string()),
    shopifyDraftImportStatus: v.optional(v.union(v.literal("creating"), v.literal("created"), v.literal("ambiguous"))),
    shopifyDraftImportTraceId: v.optional(v.string()),
    cjProductId: v.optional(v.string()),
    cjVariantId: v.optional(v.string()),          // exact sellable variant used for the verified quote
    cjEvidenceId: v.optional(v.id("cjEvidence")), // immutable parsed CJ read used to derive costs
    cjFromUsWarehouse: v.boolean(),               // §8.2 prefer US-warehouse (duty-paid bulk) only
    cogsUsd: v.number(),
    shippingUsd: v.number(),
    dutyUsd: v.optional(v.number()),
    paymentFeeUsd: v.optional(v.number()),
    refundReserveUsd: v.optional(v.number()),
    contentCostUsd: v.optional(v.number()),
    landedCostUsd: v.optional(v.number()),        // COGS + shipping + duty, computed by sourced-draft gate
    sourceVerifiedAt: v.optional(v.number()),     // CJ facts refreshed at this timestamp
    sourceUrl: v.optional(v.string()),            // read-only source evidence; never an affiliate click target
    priceUsd: v.number(),
    contributionMarginPct: v.optional(v.number()),// computed: after COGS+ship+duty+fees+refund+content
    status: v.union(v.literal("draft"), v.literal("active"), v.literal("archived"), v.literal("killed")),
    createdAt: v.number(),
    sample: v.optional(v.boolean()),
  }).index("by_site", ["siteId"]).index("by_site_status", ["siteId", "status"]),

  // Parsed, server-read CJ evidence. Optional costs mean "unknown", never zero; candidates
  // using them fail closed. This row is the lineage anchor for a sourced product and its trace.
  cjEvidence: defineTable({
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
  }).index("by_site_read_at", ["siteId", "readAt"])
    .index("by_site_product_variant", ["siteId", "cjProductId", "cjVariantId"]),

  // One operator selection is one durable sourcing workflow. `requestId` is generated by the
  // caller before the HTTP request and is deliberately indexed so a retry cannot mint another
  // read/economics/action lineage. It is not a provider identifier.
  sourceSelections: defineTable({
    siteId: v.id("sites"),
    requestId: v.string(),
    cjProductId: v.string(),
    cjVariantId: v.string(),
    priceUsd: v.number(),
    evidenceId: v.id("cjEvidence"),
    productId: v.optional(v.id("products")),
    actionId: v.optional(v.id("actions")),
    status: v.union(v.literal("denied"), v.literal("pending_approval")),
    approvalDispatchKey: v.optional(v.string()),
    approvalRunId: v.optional(v.string()),
    approvalDispatchStatus: v.optional(v.union(v.literal("pending"), v.literal("dispatching"), v.literal("dispatched"), v.literal("ambiguous"))),
    createdAt: v.number(),
  }).index("by_site_request", ["siteId", "requestId"])
    .index("by_site_candidate", ["siteId", "cjProductId", "cjVariantId"])
    .index("by_action", ["actionId"]),

  // ── signals (rolled-up, never raw-event spam) ─────────────────────────────
  productSignals: defineTable({
    siteId: v.id("sites"),
    productId: v.optional(v.id("products")),
    source: v.string(),     // "google_trends" | "meta_ad_library" | "tiktok_cc" | "serp"
    signalType: v.string(), // "trend_score" | "competitor_runtime_days" | "keyword_rank"
    value: v.number(),
    day: v.string(),        // YYYY-MM-DD rollup bucket
  }).index("by_site_day", ["siteId", "day"]).index("by_site_product", ["siteId", "productId"]),

  conversionMetrics: defineTable({
    siteId: v.id("sites"),
    productId: v.id("products"),
    day: v.string(),
    pageviews: v.number(),
    addToCartRate: v.number(),
    cvr: v.number(),
    aovUsd: v.number(),
    refundRate: v.number(),
    sample: v.optional(v.boolean()),
  }).index("by_site_day", ["siteId", "day"]).index("by_product_day", ["productId", "day"]),

  // ── content factory ───────────────────────────────────────────────────────
  creatives: defineTable({
    siteId: v.id("sites"),
    productId: v.optional(v.id("products")),
    kind: v.union(v.literal("product_demo"), v.literal("ai_spokesperson"), v.literal("ai_broll"), v.literal("customer_ugc")),
    r2Key: v.string(),                            // asset in R2
    aiGenerated: v.boolean(),
    aiLabelRequired: v.boolean(),                 // §8.3 enforced before any publish
    // Set only by the assembler/factory after the disclosure is actually burned into the asset.
    // Optional for the migration so legacy rows fail closed at approval time.
    labelBurned: v.optional(v.boolean()),
    hook: v.optional(v.string()),
    status: v.union(v.literal("generating"), v.literal("review"), v.literal("approved"), v.literal("rejected")),
    createdAt: v.number(),
    sample: v.optional(v.boolean()),
  }).index("by_site_status", ["siteId", "status"]).index("by_product", ["productId"]).index("by_r2_key", ["r2Key"]),

  posts: defineTable({
    siteId: v.id("sites"),
    creativeId: v.id("creatives"),
    platform,
    status: postStatus,
    scheduledFor: v.optional(v.number()),
    publishedAt: v.optional(v.number()),
    externalPostId: v.optional(v.string()),
    views: v.optional(v.number()),
    engagement: v.optional(v.number()),
    metricsObservedAt: v.optional(v.number()),    // provider observation time, never a UI estimate
    sample: v.optional(v.boolean()),
  }).index("by_site_status", ["siteId", "status"]).index("by_site_platform", ["siteId", "platform"])
    .index("by_creative_platform", ["creativeId", "platform"]),

  // ── orders + CJ fulfillment loop ──────────────────────────────────────────
  orders: defineTable({
    siteId: v.id("sites"),
    shopifyOrderId: v.string(),
    cjOrderId: v.optional(v.string()),            // may arrive later (§C3: async)
    fulfillmentStatus: v.union(
      v.literal("received"), v.literal("sent_to_cj"), v.literal("shipped"), v.literal("delivered"), v.literal("error"),
    ),
    trackingNumber: v.optional(v.string()),       // via CJ ORDER webhook, not create-response
    trackingUrl: v.optional(v.string()),
    totalUsd: v.number(),
    createdAt: v.number(),
    sample: v.optional(v.boolean()),
  }).index("by_site", ["siteId"]).index("by_shopify_order", ["shopifyOrderId"]).index("by_site_status", ["siteId", "fulfillmentStatus"]),

  // ── the brain: proposed actions + risk-tiered approval ────────────────────
  actions: defineTable({
    siteId: v.id("sites"),
    type: v.string(),                             // "import_product" | "rewrite_copy" | "reorder_collection" | "schedule_post" | "kill_product" | "spark_ad" ...
    params: v.any(),                              // Zod-validated upstream (generateObject)
    riskTier,                                     // auto vs human_gated
    status: actionStatus,
    rationale: v.string(),                        // brain's reason (audit)
    confidence: v.optional(v.number()),
    waitpointToken: v.optional(v.string()),       // Trigger waitpoint for human_gated (§8.4 long timeout + re-arm)
    selectionRequestId: v.optional(v.string()),   // stable source-selection idempotency key
    approvalDispatchKey: v.optional(v.string()),
    approvalRunId: v.optional(v.string()),
    approvalDispatchStatus: v.optional(v.union(v.literal("pending"), v.literal("dispatching"), v.literal("dispatched"), v.literal("ambiguous"))),
    proposedAt: v.number(),
    resolvedAt: v.optional(v.number()),
    sample: v.optional(v.boolean()),
  }).index("by_site_status", ["siteId", "status"]).index("by_status", ["status"]),

  // append-only audit ledger (no deletes — every proposed + executed action)
  auditLog: defineTable({
    siteId: v.id("sites"),
    actionId: v.optional(v.id("actions")),
    event: v.string(),
    detail: v.any(),
    at: v.number(),
    sample: v.optional(v.boolean()),
  }).index("by_site_at", ["siteId", "at"]),

  // Durable coordination records. A target lock prevents two workers from issuing the
  // same external side effect, while outbox + traces preserve intent and retry evidence.
  targetLocks: defineTable({
    target: v.string(),
    owner: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  }).index("by_target", ["target"]),

  outbox: defineTable({
    siteId: v.id("sites"),
    kind: v.string(),
    target: v.string(),
    idempotencyKey: v.string(),
    traceId: v.string(),
    payload: v.any(),
    status: v.union(v.literal("pending"), v.literal("processing"), v.literal("delivered"), v.literal("failed")),
    attempts: v.number(),
    availableAt: v.number(),
    deliveredAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_idempotency_key", ["idempotencyKey"]).index("by_status_available_at", ["status", "availableAt"]).index("by_site_created_at", ["siteId", "createdAt"]),

  traces: defineTable({
    traceId: v.string(),
    siteId: v.id("sites"),
    operation: v.string(),
    target: v.string(),
    idempotencyKey: v.string(),
    status: v.union(v.literal("started"), v.literal("succeeded"), v.literal("failed"), v.literal("skipped")),
    detail: v.any(),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  }).index("by_trace_id", ["traceId"]).index("by_site_started_at", ["siteId", "startedAt"]),

  // Provider delivery de-duplication. Store only a digest, never a webhook body: order and
  // address payloads can contain customer data and are not needed for replay protection.
  webhookReceipts: defineTable({
    provider: v.string(),
    deliveryId: v.string(),
    topic: v.string(),
    siteId: v.id("sites"),
    payloadHash: v.string(),
    outcome: v.union(v.literal("applied"), v.literal("ignored")),
    receivedAt: v.number(),
  }).index("by_provider_site_delivery", ["provider", "siteId", "deliveryId"]).index("by_site_received_at", ["siteId", "receivedAt"]),

  // ── experiments (CRO) ─────────────────────────────────────────────────────
  experiments: defineTable({
    siteId: v.id("sites"),
    productId: v.optional(v.id("products")),
    hypothesis: v.string(),
    variantA: v.any(),
    variantB: v.any(),
    status: v.union(v.literal("running"), v.literal("concluded")),
    winner: v.optional(v.string()),
    startedAt: v.number(),
    sample: v.optional(v.boolean()),
  }).index("by_site_status", ["siteId", "status"]),
});
