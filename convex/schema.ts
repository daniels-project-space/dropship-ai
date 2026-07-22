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
  v.literal("superseded"),
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
    storeCurrency: v.optional(v.string()),        // ISO 4217 shop currency verified at connection
    shopifyAccessVerifiedAt: v.optional(v.number()), // recurring vault token resolved + identity read
    // Recurring identity above is deliberately separate from complete, current economic facts.
    shopifyEconomicsSyncStatus: v.optional(v.union(v.literal("pending"), v.literal("current"), v.literal("failed"), v.literal("incomplete"))),
    shopifyEconomicsSyncAttemptId: v.optional(v.string()),
    shopifyEconomicsSyncAttemptedAt: v.optional(v.number()),
    // Exact Convex-owned lower bound used by both the provider query and snapshot reducer.
    shopifyEconomicsSyncOrderCutoffAt: v.optional(v.number()),
    shopifyEconomicsSyncSucceededAt: v.optional(v.number()),
    shopifyEconomicsSyncExpiresAt: v.optional(v.number()),
    shopifyEconomicsSyncExpiredAt: v.optional(v.number()),
    shopifyEconomicsSyncExpiredAttemptId: v.optional(v.string()),
    shopifyEconomicsSyncSinceDays: v.optional(v.number()),
    shopifyEconomicsSyncProductCount: v.optional(v.number()),
    shopifyEconomicsSyncOrderCount: v.optional(v.number()),
    // Only the sole atomic snapshot reducer may stamp the matching protocol generation.
    shopifyEconomicsSnapshotProtocolVersion: v.optional(v.number()),
    shopifyEconomicsSyncInvalidatedAt: v.optional(v.number()),
    shopifyEconomicsSyncInvalidationReason: v.optional(v.string()),
    customDomain: v.optional(v.string()),
    // brand/margin guardrails (enforced by the brain)
    minKitPriceUsd: v.number(),                   // §8.2 never below this (e.g. 35–55)
    minBlendedMarginPct: v.number(),              // standing margin gate (e.g. 70)
    distributionMode: v.union(v.literal("semi_manual"), v.literal("automated")), // §8.1 cold-start = semi_manual
    killDate: v.optional(v.number()),             // pre-committed kill date (ms)
    createdAt: v.number(),
    sample: v.optional(v.boolean()),              // seeded demo brand (cleared by seed.clearSampleData)
  }).index("by_status", ["status"]).index("by_sample", ["sample"]).index("by_shopify_domain", ["shopifyDomain"]),

  // per-site credential REFERENCES (actual secrets live in env/vault; this maps which keys a site uses)
  siteSecrets: defineTable({
    siteId: v.id("sites"),
    key: v.string(),        // e.g. "SHOPIFY_ADMIN_TOKEN", "CJ_ACCESS_TOKEN"
    vaultRef: v.string(),   // pointer into the vault, NOT the secret value
  }).index("by_site", ["siteId"])
    .index("by_site_key", ["siteId", "key"])
    .index("by_key_vault_ref", ["key", "vaultRef"]),

  // ── catalog ───────────────────────────────────────────────────────────────
  products: defineTable({
    siteId: v.id("sites"),
    title: v.string(),
    shopifyProductId: v.optional(v.string()),
    // IDs returned by the approved DRAFT-only import. These are the authority for mapping
    // signed Shopify order lines back to the immutable CJ sourcing lineage; merchant SKU text
    // is intentionally never used as supplier identity.
    shopifyVariantId: v.optional(v.string()),
    shopifyDraftImportStatus: v.optional(v.union(v.literal("creating"), v.literal("created"), v.literal("ambiguous"))),
    shopifyDraftImportTraceId: v.optional(v.string()),
    // Snapshot generation is the economic inclusion fence. Provider observations are retained
    // independently so a webhook/draft-import race can invalidate or supersede a snapshot.
    shopifyObservedAt: v.optional(v.number()),
    shopifyEconomicsSnapshotAttemptId: v.optional(v.string()),
    shopifyEconomicsExcludedAt: v.optional(v.number()),
    cjProductId: v.optional(v.string()),
    cjVariantId: v.optional(v.string()),          // exact sellable variant used for the verified quote
    cjFromCountryCode: v.optional(v.string()),    // verified CJ inventory origin used for freight preflight
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
    sourceMediaUrl: v.optional(v.string()),       // exact CJ image used only for a Shopify DRAFT
    priceUsd: v.number(),
    contributionMarginPct: v.optional(v.number()),// computed: after COGS+ship+duty+fees+refund+content
    status: v.union(v.literal("draft"), v.literal("active"), v.literal("archived"), v.literal("killed")),
    createdAt: v.number(),
    sample: v.optional(v.boolean()),
  }).index("by_site", ["siteId"])
    .index("by_site_status", ["siteId", "status"])
    .index("by_site_shopify_product", ["siteId", "shopifyProductId"])
    .index("by_site_shopify_product_variant", ["siteId", "shopifyProductId", "shopifyVariantId"]),

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
    fromCountryCode: v.optional(v.string()),
    inventoryVerified: v.boolean(),
    sourceUrl: v.string(),
    mediaUrl: v.optional(v.string()),
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
    // Direct provider counters only. Legacy rate-only rows remain readable for historical sample
    // views but are intentionally excluded from live funnels.
    provider: v.optional(v.literal("shopify")),
    observedAt: v.optional(v.number()),
    addToCartCount: v.optional(v.number()),
    checkoutCount: v.optional(v.number()),
    purchaseCount: v.optional(v.number()),
    sample: v.optional(v.boolean()),
  }).index("by_site_day", ["siteId", "day"]).index("by_product_day", ["productId", "day"]),

  // ── content factory ───────────────────────────────────────────────────────
  creatives: defineTable({
    siteId: v.id("sites"),
    productId: v.optional(v.id("products")),
    // A durable generation variant may bind at most one review row. Optional for legacy rows.
    generationVariantId: v.optional(v.id("creativeGenerationVariants")),
    kind: v.union(v.literal("product_demo"), v.literal("ai_spokesperson"), v.literal("ai_broll"), v.literal("customer_ugc")),
    r2Key: v.string(),                            // asset in R2
    aiGenerated: v.boolean(),
    aiLabelRequired: v.boolean(),                 // §8.3 enforced before any publish
    // Set only by the assembler/factory after the disclosure is actually burned into the asset.
    // Optional for the migration so legacy rows fail closed at approval time.
    labelBurned: v.optional(v.boolean()),
    hook: v.optional(v.string()),
    status: v.union(v.literal("generating"), v.literal("review"), v.literal("approved"), v.literal("rejected")),
    revision: v.optional(v.number()),              // immutable publication authorization fence
    createdAt: v.number(),
    sample: v.optional(v.boolean()),
  }).index("by_site_status", ["siteId", "status"]).index("by_product", ["productId"]).index("by_r2_key", ["r2Key"])
    .index("by_generation_variant", ["generationVariantId"]),

  // One atomically-created parent plus K immutable children exists before any Trigger handoff.
  // The parent status/counts are a transactionally maintained projection of its children.
  creativeGenerationIntents: defineTable({
    siteId: v.id("sites"),
    productId: v.optional(v.id("products")),
    callerRequestId: v.string(),
    normalizedInputDigest: v.string(),
    generationSpecDigest: v.string(),
    requestedVariants: v.number(),
    status: v.union(v.literal("queued"), v.literal("active"), v.literal("ready"), v.literal("failed"), v.literal("needs_attention"), v.literal("mixed")),
    activeVariants: v.number(),
    readyVariants: v.number(),
    failedVariants: v.number(),
    attentionVariants: v.number(),
    handoffStatus: v.union(v.literal("pending"), v.literal("dispatching"), v.literal("dispatched")),
    handoffGeneration: v.number(),
    handoffLeaseExpiresAt: v.optional(v.number()),
    handoffDueAt: v.optional(v.number()),
    triggerRunId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  }).index("by_request_id", ["callerRequestId"])
    .index("by_handoff_due", ["handoffStatus", "handoffDueAt"])
    .index("by_site_updated", ["siteId", "updatedAt"]),

  creativeGenerationVariants: defineTable({
    intentId: v.id("creativeGenerationIntents"),
    siteId: v.id("sites"),
    productId: v.optional(v.id("products")),
    variantIndex: v.number(),
    // Immutable generation facts. They never appear in Trigger payloads or operator projections.
    hook: v.string(),
    imagePrompt: v.string(),
    clipPrompt: v.string(),
    imageModel: v.string(),
    clipModel: v.string(),
    ttsModel: v.string(),
    voiceId: v.string(),
    ttsTextDigest: v.string(),
    imageR2Key: v.string(),
    clipR2Key: v.string(),
    audioR2Key: v.string(),
    finalR2Key: v.string(),
    stage: v.union(
      v.literal("image_submission"), v.literal("image_polling"), v.literal("image_result_copy"),
      v.literal("clip_submission"), v.literal("clip_polling"), v.literal("clip_result_copy"),
      v.literal("tts_reservation"), v.literal("tts_receipt"), v.literal("tts_audio_copy"),
      v.literal("assembly"), v.literal("review_ready"), v.literal("failed"), v.literal("needs_attention"),
    ),
    terminal: v.boolean(),
    runnableAt: v.optional(v.number()),
    leaseOwner: v.optional(v.string()),
    leaseGeneration: v.number(),
    leaseExpiresAt: v.optional(v.number()),
    failureCount: v.number(),
    lastErrorCode: v.optional(v.string()),
    failedAtStage: v.optional(v.string()),
    retryEligible: v.optional(v.boolean()),
    // Written immediately before an external submission. If it survives without a receipt,
    // automatic replay is forbidden because the billed request may have reached the provider.
    submissionStartedStage: v.optional(v.string()),
    submissionStartedAt: v.optional(v.number()),
    imageFalRequestId: v.optional(v.string()),
    imageFalStatus: v.optional(v.string()),
    imageFalStatusUrl: v.optional(v.string()),
    imageFalResultUrl: v.optional(v.string()),
    clipFalRequestId: v.optional(v.string()),
    clipFalStatus: v.optional(v.string()),
    clipFalStatusUrl: v.optional(v.string()),
    clipFalResultUrl: v.optional(v.string()),
    ttsRequestId: v.optional(v.string()),
    ttsHistoryItemId: v.optional(v.string()),
    ttsCharacterCost: v.optional(v.number()),
    ttsCharacterCount: v.optional(v.number()),
    imageObject: v.optional(v.object({ contentType: v.string(), bytes: v.number(), sha256: v.string() })),
    clipObject: v.optional(v.object({ contentType: v.string(), bytes: v.number(), sha256: v.string() })),
    audioObject: v.optional(v.object({ contentType: v.string(), bytes: v.number(), sha256: v.string() })),
    finalObject: v.optional(v.object({ contentType: v.string(), bytes: v.number(), sha256: v.string() })),
    labelBurned: v.optional(v.boolean()),
    creativeId: v.optional(v.id("creatives")),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  }).index("by_intent_index", ["intentId", "variantIndex"])
    .index("by_due", ["terminal", "runnableAt"])
    .index("by_site_updated", ["siteId", "updatedAt"]),

  posts: defineTable({
    siteId: v.id("sites"),
    creativeId: v.id("creatives"),
    platform,
    targetAccount: v.optional(v.string()),
    caption: v.optional(v.string()),
    distributionDispatchId: v.optional(v.id("distributionDispatches")),
    status: postStatus,
    scheduledFor: v.optional(v.number()),
    publishedAt: v.optional(v.number()),
    externalPostId: v.optional(v.string()),
    views: v.optional(v.number()),
    engagement: v.optional(v.number()),
    metricsObservedAt: v.optional(v.number()),    // provider observation time, never a UI estimate
    metricsProvider: v.optional(v.literal("ayrshare")), // only a provider ingestion worker may set metrics
    sample: v.optional(v.boolean()),
  }).index("by_site_status", ["siteId", "status"]).index("by_site_platform", ["siteId", "platform"])
    .index("by_creative_platform", ["creativeId", "platform"]),

  // Created only by the separate publication-authorization action. Content approval alone has
  // no scheduling or external-distribution consequence.
  distributionDispatches: defineTable({
    siteId: v.id("sites"),
    creativeId: v.id("creatives"),
    // Optional only for rollout compatibility. Runtime claims reject every legacy row lacking
    // the exact authorization snapshot.
    creativeRevision: v.optional(v.number()),
    caption: v.optional(v.string()),
    destinations: v.optional(v.array(v.object({ platform, targetAccount: v.string() }))),
    dispatchKey: v.string(),
    status: v.union(v.literal("pending"), v.literal("dispatching"), v.literal("dispatched"), v.literal("delivered"), v.literal("reconcile_required")),
    triggerRunId: v.optional(v.string()),
    triggerLeaseExpiresAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_creative", ["creativeId"]).index("by_status", ["status"]),

  // ── orders + CJ fulfillment loop ──────────────────────────────────────────
  orders: defineTable({
    siteId: v.id("sites"),
    shopifyOrderId: v.string(),
    cjOrderId: v.optional(v.string()),            // may arrive later (§C3: async)
    // CJ's immutable custom order identity. This is distinct from Shopify's order id and is
    // the only key accepted for CJ tracking/reconciliation.
    cjOrderNumber: v.optional(v.string()),
    currencyCode: v.optional(v.string()),
    currentTotal: v.optional(v.number()),
    financialStatus: v.optional(v.string()),
    test: v.optional(v.boolean()),
    cancelled: v.optional(v.boolean()),
    creditAdjustmentState: v.optional(v.union(v.literal("none"), v.literal("partial"), v.literal("full"))),
    shopifyObservedAt: v.optional(v.number()),
    shopifyEconomicsSnapshotAttemptId: v.optional(v.string()),
    shopifyEconomicsExcludedAt: v.optional(v.number()),
    // Server-owned per-field observation lineage. Snapshot races are fenced transactionally on
    // the site row; these timestamps remain evidence and never authorize a caller-clock merge.
    shopifyEconomicFieldObservedAt: v.optional(v.object({
      currencyCode: v.optional(v.number()),
      currentTotal: v.optional(v.number()),
      financialStatus: v.optional(v.number()),
      test: v.optional(v.number()),
      cancelled: v.optional(v.number()),
      creditAdjustmentState: v.optional(v.number()),
    })),
    fulfillmentStatus: v.union(
      v.literal("received"), v.literal("sent_to_cj"), v.literal("shipped"), v.literal("delivered"), v.literal("error"),
    ),
    trackingNumber: v.optional(v.string()),       // via CJ ORDER webhook, not create-response
    trackingUrl: v.optional(v.string()),
    // Legacy display field. New ingestion writes currentTotal + currencyCode and analytics never
    // interprets this value without explicit USD eligibility.
    totalUsd: v.optional(v.number()),
    // Immutable input supplied to CJ only after a separate human approval. This contains order
    // PII, so it is never copied to outbox payloads, traces, logs, or Trigger payloads.
    cjOrderInput: v.optional(v.object({
      orderNumber: v.string(),
      shippingZip: v.string(),
      shippingCountryCode: v.string(),
      shippingCountry: v.string(),
      shippingProvince: v.string(),
      shippingCity: v.string(),
      shippingAddress: v.string(),
      shippingCustomerName: v.string(),
      shippingPhone: v.string(),
      logisticName: v.string(),
      fromCountryCode: v.string(),
      products: v.array(v.object({ vid: v.string(), quantity: v.number() })),
    })),
    // Exact read-only freight quote used to select the required CJ logistics fields above.
    // It contains no customer address and is never copied to jobs, traces, logs, or browsers.
    cjLogisticsPreflight: v.optional(v.object({
      logisticName: v.string(),
      fromCountryCode: v.string(),
      quotedAt: v.number(),
      quotedPriceUsd: v.number(),
    })),
    cjOrderInputHash: v.optional(v.string()),
    // Each fresh freight quote is an immutable approval generation. Provider lineage is never
    // rewritten once a create has been reserved, ambiguous, or sent.
    cjDispatchGeneration: v.optional(v.number()),
    cjDispatchGenerationFingerprint: v.optional(v.string()),
    cjQuoteInputDigest: v.optional(v.string()),
    cjDispatchAttempt: v.optional(v.number()),   // fenced reservation generation; never reused after a reconcile miss
    // The one current provider-bound receipt. Historical attempts remain in
    // cjDispatchExecutions for audit, but the hot path never scans them.
    cjDispatchExecutionId: v.optional(v.id("cjDispatchExecutions")),
    cjApprovalActionId: v.optional(v.id("actions")),
    cjDispatchStatus: v.optional(v.union(v.literal("staged"), v.literal("reserved"), v.literal("ambiguous"), v.literal("sent"), v.literal("failed"))),
    createdAt: v.number(),
    sample: v.optional(v.boolean()),
  }).index("by_site", ["siteId"])
    .index("by_site_created_at", ["siteId", "createdAt"])
    .index("by_site_shopify_order", ["siteId", "shopifyOrderId"])
    .index("by_site_cj_order_number", ["siteId", "cjOrderNumber"])
    // CJ supports one callback per topic. This dedicated global routing index is used only by
    // the signed webhook path; ordinary reads remain tenant-scoped above.
    .index("by_cj_webhook_order_number", ["cjOrderNumber"])
    .index("by_site_cj_order_id", ["siteId", "cjOrderId"])
    .index("by_site_status", ["siteId", "fulfillmentStatus"]),

  // A Shopify delivery has a durable, separate CJ preflight intent. The raw shipping fields are
  // intentionally confined to Convex; Trigger receives only this row's stable ID.
  cjStagingIntents: defineTable({
    siteId: v.id("sites"),
    orderId: v.id("orders"),
    deliveryId: v.string(),
    payloadHash: v.string(),
    status: v.union(v.literal("pending"), v.literal("preflighting"), v.literal("quoted"), v.literal("preflight_required"), v.literal("staged"), v.literal("approval_dispatching"), v.literal("approval_dispatched"), v.literal("approval_resolved"), v.literal("needs_attention"), v.literal("failed")),
    attempt: v.number(),
    // Monotonic lease fence. It is independent from the bounded failure budget so a replayed
    // claim can never consume a retry and a stale worker can never mutate a newer lease.
    leaseGeneration: v.optional(v.number()),
    failureCount: v.optional(v.number()),
    // Legacy compatibility only; rollout copies its value into failureCount once and no new
    // code writes it.
    workerAttempt: v.optional(v.number()),
    leaseExpiresAt: v.optional(v.number()),
    // The only scheduler index. Ready rows are due now; leased rows are due at their fence.
    runnableAt: v.optional(v.number()),
    lastError: v.optional(v.object({ code: v.string() })),
    // PII is durable only here and in the immutable CJ order snapshot. It must never enter an
    // outbox, trace, audit detail, Trigger payload, or logger context.
    shipping: v.object({ shippingZip: v.string(), shippingCountryCode: v.string(), shippingCountry: v.string(), shippingProvince: v.string(), shippingCity: v.string(), shippingAddress: v.string(), shippingCustomerName: v.string(), shippingPhone: v.string() }),
    shopifyLines: v.array(v.object({ productId: v.string(), variantId: v.string(), quantity: v.number() })),
    // Optional solely for pre-existing rows; an absent digest fails closed into reconciliation.
    stagingInputDigest: v.optional(v.string()),
    quoteInputDigest: v.optional(v.string()),
    quoteProvider: v.optional(v.object({ endpoint: v.string(), version: v.string() })),
    quote: v.optional(v.object({ logisticName: v.string(), logisticPriceUsd: v.number(), fromCountryCode: v.string(), quotedAt: v.number() })),
    actionId: v.optional(v.id("actions")),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_site_status", ["siteId", "status"]).index("by_status", ["status"]).index("by_runnable_at", ["runnableAt"]).index("by_status_runnable_at", ["status", "runnableAt"]).index("by_created_at", ["createdAt"]).index("by_order", ["orderId"]).index("by_site_delivery", ["siteId", "deliveryId"]),

  // A singleton, versioned rollout cursor. Once complete, sweeps never fan out through legacy
  // status indexes again; a future migration uses a new version row.
  cjStagingRollouts: defineTable({
    version: v.string(),
    phase: v.number(),
    cursor: v.optional(v.string()),
    completed: v.boolean(),
    updatedAt: v.number(),
  }).index("by_version", ["version"]),

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
    status: v.union(v.literal("pending"), v.literal("processing"), v.literal("delivered"), v.literal("failed"), v.literal("ambiguous")),
    attempts: v.number(),
    availableAt: v.number(),
    deliveredAt: v.optional(v.number()),
    providerReceiptId: v.optional(v.string()), // Ayrshare post id; enables read-only reconciliation
    lastError: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_idempotency_key", ["idempotencyKey"]).index("by_status_available_at", ["status", "availableAt"]).index("by_site_created_at", ["siteId", "createdAt"]),

  // The provider-bound CJ create receipt.  This is deliberately separate from an order's
  // display status: a response can be lost after a Convex commit, and only this row tells a
  // later worker whether it is safe to create, must reconcile, or is terminal.
  cjDispatchExecutions: defineTable({
    siteId: v.id("sites"),
    actionId: v.id("actions"),
    orderId: v.id("orders"),
    orderNumber: v.string(),
    inputHash: v.string(),
    generation: v.number(),
    generationFingerprint: v.string(),
    attempt: v.number(),
    triggerRunId: v.string(),
    // A keyed opaque per-Trigger-run capability. It is not an order/customer value and the
    // HMAC key remains only in the Trigger worker environment.
    leaseToken: v.string(),
    leaseVersion: v.number(),
    providerMode: v.literal("sandbox"),
    providerIdentity: v.string(),
    phase: v.union(v.literal("prepared"), v.literal("provider_calling"), v.literal("reconciliation_required"), v.literal("sent"), v.literal("pre_provider_failed"), v.literal("needs_attention")),
    idempotencyKey: v.string(),
    traceId: v.string(),
    // It is assigned before this atomic mutation commits. Optional solely because Convex
    // validates an insert before the subsequently-created outbox has an ID.
    outboxId: v.optional(v.id("outbox")),
    leaseExpiresAt: v.number(),
    reconciliationCount: v.number(),
    reconciliationMax: v.number(),
    nextReconcileAt: v.optional(v.number()),
    // Scheduling is a replayable projection of nextReconcileAt. A short lease means a
    // lost Trigger response can be reclaimed without inventing another provider write.
    reconciliationScheduleGeneration: v.number(),
    reconciliationScheduleLeaseExpiresAt: v.optional(v.number()),
    lastReconcileResult: v.optional(v.union(v.literal("absent"), v.literal("found"), v.literal("mismatched"), v.literal("exhausted"))),
    cjOrderId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_order", ["orderId"]).index("by_order_updated_at", ["orderId", "updatedAt"]).index("by_action_run", ["actionId", "triggerRunId"]).index("by_phase_next_reconcile", ["phase", "nextReconcileAt"]),

  traces: defineTable({
    traceId: v.string(),
    siteId: v.id("sites"),
    operation: v.string(),
    target: v.string(),
    idempotencyKey: v.string(),
    status: v.union(v.literal("started"), v.literal("reconciling"), v.literal("succeeded"), v.literal("failed"), v.literal("skipped")),
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
    cjStagingIntentId: v.optional(v.id("cjStagingIntents")),
    receivedAt: v.number(),
  }).index("by_provider_site_delivery", ["provider", "siteId", "deliveryId"])
    .index("by_provider_delivery", ["provider", "deliveryId"])
    .index("by_site_received_at", ["siteId", "receivedAt"]),

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
