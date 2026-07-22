import { mutation, query } from "./authz";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  creativeGenerationInputDigest,
  deterministicGenerationKey,
  isProviderSubmissionStage,
  MAX_STAGE_FAILURES,
  type GenerationStage,
} from "../src/lib/creativeGeneration";
import { stableSha256 } from "../src/lib/cjOrder";
import { appendAudit } from "./audit";

const stage = v.union(
  v.literal("image_submission"), v.literal("image_polling"), v.literal("image_result_copy"),
  v.literal("clip_submission"), v.literal("clip_polling"), v.literal("clip_result_copy"),
  v.literal("tts_reservation"), v.literal("tts_receipt"), v.literal("tts_audio_copy"),
  v.literal("assembly"), v.literal("review_ready"), v.literal("failed"), v.literal("needs_attention"),
);
const objectReceipt = v.object({ contentType: v.string(), bytes: v.number(), sha256: v.string() });
const MIN_DUE_CUTOFF = 1_577_836_800_000; // 2020-01-01
const MAX_DUE_CUTOFF = 4_102_444_800_000; // 2100-01-01
const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 10 * 60_000;

async function requireServiceIdentity(ctx: { auth: { getUserIdentity: () => Promise<{ subject?: string } | null> } }) {
  if ((await ctx.auth.getUserIdentity())?.subject !== "dropship-ai:service") {
    throw new Error("UNAUTHENTICATED: creative generation requires the service runtime");
  }
}

function safeLimit(limit: number | undefined, fallback = 25, max = 100): number {
  return Number.isInteger(limit) ? Math.max(1, Math.min(limit!, max)) : fallback;
}

function assertDueCutoff(now: number): number {
  if (!Number.isSafeInteger(now) || now < MIN_DUE_CUTOFF || now > MAX_DUE_CUTOFF) {
    throw new Error("invalid due discovery cutoff");
  }
  return now;
}

function assertPositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${name}`);
  return value;
}

function assertControlIdentity(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) throw new Error(`invalid ${name}`);
  return value;
}

function assertReceipt(receipt: { contentType: string; bytes: number; sha256: string }, expected: string) {
  if (receipt.contentType !== expected || !Number.isInteger(receipt.bytes) || receipt.bytes < 1
    || !/^[a-f0-9]{64}$/.test(receipt.sha256)) throw new Error("invalid deterministic object receipt");
}

async function refreshIntentProjection(ctx: any, intentId: Id<"creativeGenerationIntents">) {
  const intent = await ctx.db.get(intentId);
  if (!intent) throw new Error("generation intent not found");
  const variants = await ctx.db.query("creativeGenerationVariants")
    .withIndex("by_intent_index", (q: any) => q.eq("intentId", intentId)).take(intent.requestedVariants + 1);
  const ready = variants.filter((row: any) => row.stage === "review_ready").length;
  const failed = variants.filter((row: any) => row.stage === "failed").length;
  const attention = variants.filter((row: any) => row.stage === "needs_attention").length;
  const active = variants.length - ready - failed - attention;
  const allTerminal = variants.length === intent.requestedVariants && active === 0;
  let status: "queued" | "active" | "ready" | "failed" | "needs_attention" | "mixed";
  if (variants.length !== intent.requestedVariants) status = "needs_attention";
  else if (ready === intent.requestedVariants) status = "ready";
  else if (attention > 0) status = "needs_attention";
  else if (failed === intent.requestedVariants) status = "failed";
  else if (allTerminal) status = "mixed";
  else if (variants.every((row: any) => row.stage === "image_submission" && row.failureCount === 0)) status = "queued";
  else status = "active";
  const now = Date.now();
  await ctx.db.patch(intentId, {
    status, activeVariants: active, readyVariants: ready, failedVariants: failed,
    attentionVariants: attention, updatedAt: now, completedAt: allTerminal ? now : undefined,
  });
  return { requested: intent.requestedVariants, active, ready, failed, needsAttention: attention, status };
}

function hasProviderReceipt(row: any, currentStage: GenerationStage): boolean {
  if (currentStage === "image_submission") return !!row.imageFalRequestId;
  if (currentStage === "clip_submission") return !!row.clipFalRequestId;
  if (currentStage === "tts_reservation") return !!row.ttsRequestId;
  return false;
}

function assertLease(row: any, expectedStage: GenerationStage, leaseGeneration: number) {
  assertPositiveSafeInteger(leaseGeneration, "lease generation");
  if (row.stage !== expectedStage || row.leaseGeneration !== leaseGeneration || !row.leaseOwner
    || !row.leaseExpiresAt || row.leaseExpiresAt < Date.now()) throw new Error("stale creative generation stage lease");
}

export const createOrReuseIntent = mutation({
  args: {
    siteId: v.id("sites"), productId: v.optional(v.id("products")), callerRequestId: v.string(),
    normalizedInputDigest: v.string(), requestedVariants: v.number(), scenePrompt: v.string(), hooks: v.array(v.string()),
    imageModel: v.string(), clipModel: v.string(), ttsModel: v.string(), voiceId: v.string(),
  },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(args.callerRequestId)
      || !/^[a-f0-9]{64}$/.test(args.normalizedInputDigest)
      || !Number.isInteger(args.requestedVariants) || args.requestedVariants < 1 || args.requestedVariants > 3
      || args.hooks.length < 1 || args.hooks.length > 3 || args.scenePrompt.length > 1_000
      || args.hooks.some((hook) => !hook || hook.length > 300)
      || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(args.imageModel) || args.imageModel.length > 200
      || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(args.clipModel) || args.clipModel.length > 200
      || !/^[A-Za-z0-9._-]{1,200}$/.test(args.ttsModel) || !/^[A-Za-z0-9_-]{1,200}$/.test(args.voiceId)) {
      throw new Error("invalid normalized generation input");
    }
    const exactDigest = creativeGenerationInputDigest({
      siteId: args.siteId, productId: args.productId ?? null, variants: args.requestedVariants,
      scenePrompt: args.scenePrompt, hooks: args.hooks,
    });
    if (exactDigest !== args.normalizedInputDigest) throw new Error("normalized input digest mismatch");
    const generationSpecDigest = stableSha256(JSON.stringify({
      normalizedInputDigest: args.normalizedInputDigest, imageModel: args.imageModel,
      clipModel: args.clipModel, ttsModel: args.ttsModel, voiceId: args.voiceId,
    }));
    const site = await ctx.db.get(args.siteId);
    if (!site || site.sample === true || site.status !== "active") throw new Error("generation requires an active non-sample site");
    if (args.productId) {
      const product = await ctx.db.get(args.productId);
      if (!product || product.siteId !== args.siteId) throw new Error("product does not belong to the generation site");
    }
    const existing = await ctx.db.query("creativeGenerationIntents")
      .withIndex("by_request_id", (q) => q.eq("callerRequestId", args.callerRequestId)).unique();
    if (existing) {
      if (existing.normalizedInputDigest !== args.normalizedInputDigest || existing.siteId !== args.siteId
        || existing.productId !== args.productId || existing.requestedVariants !== args.requestedVariants
        || existing.generationSpecDigest !== generationSpecDigest) {
        throw new Error("generation request ID was already used with different immutable input");
      }
      return { intentId: existing._id, reused: true as const, status: existing.status, handoffStatus: existing.handoffStatus };
    }
    const now = Date.now();
    const intentId = await ctx.db.insert("creativeGenerationIntents", {
      siteId: args.siteId, productId: args.productId, callerRequestId: args.callerRequestId,
      normalizedInputDigest: args.normalizedInputDigest, generationSpecDigest, requestedVariants: args.requestedVariants,
      status: "queued", activeVariants: args.requestedVariants, readyVariants: 0, failedVariants: 0,
      attentionVariants: 0, handoffStatus: "pending", handoffGeneration: 1, handoffDueAt: now,
      createdAt: now, updatedAt: now,
    });
    for (let index = 0; index < args.requestedVariants; index++) {
      const hook = args.hooks[index % args.hooks.length];
      await ctx.db.insert("creativeGenerationVariants", {
        intentId, siteId: args.siteId, productId: args.productId, variantIndex: index, hook,
        imagePrompt: `${args.scenePrompt}, variation ${index + 1}`, clipPrompt: "gentle slow push-in, subtle texture motion, calm",
        imageModel: args.imageModel, clipModel: args.clipModel, ttsModel: args.ttsModel, voiceId: args.voiceId,
        ttsTextDigest: stableSha256(hook),
        imageR2Key: deterministicGenerationKey(intentId, index, "image"),
        clipR2Key: deterministicGenerationKey(intentId, index, "clip"),
        audioR2Key: deterministicGenerationKey(intentId, index, "audio"),
        finalR2Key: deterministicGenerationKey(intentId, index, "final"),
        stage: "image_submission", terminal: false, runnableAt: now, leaseGeneration: 0,
        failureCount: 0, createdAt: now, updatedAt: now,
      });
    }
    return { intentId, reused: false as const, status: "queued" as const, handoffStatus: "pending" as const };
  },
});

export const claimIntentHandoff = mutation({
  args: { intentId: v.id("creativeGenerationIntents") },
  handler: async (ctx, { intentId }) => {
    await requireServiceIdentity(ctx);
    const row = await ctx.db.get(intentId); const now = Date.now();
    if (!row) throw new Error("generation intent not found");
    if (row.handoffStatus === "dispatched") return { state: "dispatched" as const, generation: row.handoffGeneration, triggerRunId: row.triggerRunId };
    if (row.handoffStatus === "dispatching" && (row.handoffLeaseExpiresAt ?? 0) > now) {
      return { state: "busy" as const, generation: row.handoffGeneration };
    }
    if (typeof row.handoffDueAt !== "number" || !Number.isSafeInteger(row.handoffDueAt) || row.handoffDueAt > now) {
      return { state: "not_due" as const, generation: row.handoffGeneration };
    }
    const leaseExpiresAt = now + 60_000;
    // Preserve the same generation across response-loss reclaim so Trigger's idempotency key is stable.
    const generation = row.handoffGeneration || 1;
    await ctx.db.patch(intentId, { handoffStatus: "dispatching", handoffLeaseExpiresAt: leaseExpiresAt, handoffDueAt: leaseExpiresAt, updatedAt: now });
    return { state: "dispatch" as const, generation };
  },
});

export const recordIntentHandoff = mutation({
  args: { intentId: v.id("creativeGenerationIntents"), generation: v.number(), triggerRunId: v.string() },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    assertPositiveSafeInteger(args.generation, "handoff generation");
    assertControlIdentity(args.triggerRunId, "Trigger run ID");
    const row = await ctx.db.get(args.intentId);
    if (!row) throw new Error("generation intent not found");
    if (row.handoffStatus === "dispatched") {
      if (row.triggerRunId !== args.triggerRunId || row.handoffGeneration !== args.generation) throw new Error("generation handoff receipt conflict");
      return { reused: true as const };
    }
    if (row.handoffStatus !== "dispatching" || row.handoffGeneration !== args.generation) throw new Error("stale generation handoff lease");
    await ctx.db.patch(args.intentId, { handoffStatus: "dispatched", triggerRunId: args.triggerRunId, handoffDueAt: undefined, handoffLeaseExpiresAt: undefined, updatedAt: Date.now() });
    return { reused: false as const };
  },
});

export const listDueIntentHandoffs = query({
  args: { now: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, { now, limit }) => {
    await requireServiceIdentity(ctx);
    const take = safeLimit(limit); const cutoff = assertDueCutoff(now);
    const pending = await ctx.db.query("creativeGenerationIntents").withIndex("by_handoff_due", (q) => q.eq("handoffStatus", "pending").lte("handoffDueAt", cutoff)).take(take);
    const dispatching = await ctx.db.query("creativeGenerationIntents").withIndex("by_handoff_due", (q) => q.eq("handoffStatus", "dispatching").lte("handoffDueAt", cutoff)).take(take);
    return [...pending, ...dispatching].sort((a, b) => (a.handoffDueAt ?? 0) - (b.handoffDueAt ?? 0)).slice(0, take).map((row) => ({ intentId: row._id }));
  },
});

export const listDueVariants = query({
  args: { now: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, { now, limit }) => {
    await requireServiceIdentity(ctx);
    const cutoff = assertDueCutoff(now);
    const rows = await ctx.db.query("creativeGenerationVariants").withIndex("by_due", (q) => q.eq("terminal", false).lte("runnableAt", cutoff)).take(safeLimit(limit));
    return rows.map((row) => ({ variantId: row._id, stage: row.stage, leaseGeneration: row.leaseGeneration }));
  },
});

export const listDueVariantsForIntent = query({
  args: { intentId: v.id("creativeGenerationIntents"), now: v.number() },
  handler: async (ctx, { intentId, now }) => {
    await requireServiceIdentity(ctx);
    const cutoff = assertDueCutoff(now);
    if (!await ctx.db.get(intentId)) throw new Error("generation intent not found");
    const rows = await ctx.db.query("creativeGenerationVariants")
      .withIndex("by_intent_due", (q) => q.eq("intentId", intentId).eq("terminal", false).lte("runnableAt", cutoff))
      .take(4);
    if (rows.length > 3) throw new Error("generation intent variant bound exceeded");
    return rows.map((row) => ({ variantId: row._id, stage: row.stage, leaseGeneration: row.leaseGeneration }));
  },
});

export const claimVariantStage = mutation({
  args: { variantId: v.id("creativeGenerationVariants"), expectedStage: stage, owner: v.string(), leaseMs: v.number() },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    assertControlIdentity(args.owner, "worker owner ID");
    if (!Number.isSafeInteger(args.leaseMs) || args.leaseMs < MIN_LEASE_MS || args.leaseMs > MAX_LEASE_MS) {
      throw new Error("invalid stage lease duration");
    }
    const row = await ctx.db.get(args.variantId); const now = Date.now();
    if (!row) throw new Error("generation variant not found");
    if (row.stage !== args.expectedStage || row.terminal) return { state: "stale" as const, stage: row.stage };
    if (row.leaseExpiresAt && row.leaseExpiresAt > now) {
      if (row.leaseOwner === args.owner) return { state: "claimed" as const, leaseGeneration: row.leaseGeneration, variant: row };
      return { state: "busy" as const, stage: row.stage };
    }
    if (typeof row.runnableAt !== "number" || !Number.isSafeInteger(row.runnableAt) || row.runnableAt > now) return { state: "not_due" as const, stage: row.stage };
    if (row.submissionStartedStage === row.stage && isProviderSubmissionStage(row.stage as GenerationStage) && !hasProviderReceipt(row, row.stage as GenerationStage)) {
      await ctx.db.patch(args.variantId, { stage: "needs_attention", terminal: true, runnableAt: undefined, leaseOwner: undefined, leaseExpiresAt: undefined, lastErrorCode: "provider_submission_receipt_ambiguous", failedAtStage: row.stage, retryEligible: false, updatedAt: now, completedAt: now });
      await refreshIntentProjection(ctx, row.intentId);
      return { state: "needs_attention" as const, stage: row.stage };
    }
    const leaseGeneration = row.leaseGeneration + 1;
    const leaseExpiresAt = now + args.leaseMs;
    await ctx.db.patch(args.variantId, { leaseOwner: args.owner, leaseGeneration, leaseExpiresAt, runnableAt: leaseExpiresAt, updatedAt: now });
    return { state: "claimed" as const, leaseGeneration, variant: { ...row, leaseOwner: args.owner, leaseGeneration, leaseExpiresAt } };
  },
});

export const beginProviderSubmission = mutation({
  args: { variantId: v.id("creativeGenerationVariants"), expectedStage: v.union(v.literal("image_submission"), v.literal("clip_submission"), v.literal("tts_reservation")), leaseGeneration: v.number() },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const row = await ctx.db.get(args.variantId); if (!row) throw new Error("generation variant not found");
    assertLease(row, args.expectedStage, args.leaseGeneration);
    if (row.submissionStartedStage === args.expectedStage) throw new Error("provider submission was already started");
    await ctx.db.patch(args.variantId, { submissionStartedStage: args.expectedStage, submissionStartedAt: Date.now(), updatedAt: Date.now() });
    return { started: true as const };
  },
});

export const recordFalSubmission = mutation({
  args: { variantId: v.id("creativeGenerationVariants"), kind: v.union(v.literal("image"), v.literal("clip")), leaseGeneration: v.number(), requestId: v.string(), model: v.string(), statusUrl: v.string(), resultUrl: v.string() },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const row = await ctx.db.get(args.variantId); if (!row) throw new Error("generation variant not found");
    const expectedStage = `${args.kind}_submission` as "image_submission" | "clip_submission";
    assertLease(row, expectedStage, args.leaseGeneration);
    const model = args.kind === "image" ? row.imageModel : row.clipModel;
    const root = `https://queue.fal.run/${model}/requests/${args.requestId}`;
    if (row.submissionStartedStage !== expectedStage || args.model !== model || !/^[A-Za-z0-9-]{8,128}$/.test(args.requestId)
      || args.statusUrl !== `${root}/status` || args.resultUrl !== `${root}/response`) throw new Error("invalid fal queue receipt identity");
    const patch = args.kind === "image"
      ? { imageFalRequestId: args.requestId, imageFalStatus: "IN_QUEUE", imageFalStatusUrl: args.statusUrl, imageFalResultUrl: args.resultUrl }
      : { clipFalRequestId: args.requestId, clipFalStatus: "IN_QUEUE", clipFalStatusUrl: args.statusUrl, clipFalResultUrl: args.resultUrl };
    await ctx.db.patch(args.variantId, { ...patch, stage: `${args.kind}_polling`, runnableAt: Date.now(), leaseOwner: undefined, leaseExpiresAt: undefined, failureCount: 0, lastErrorCode: undefined, updatedAt: Date.now() });
    await refreshIntentProjection(ctx, row.intentId);
    return { recorded: true as const };
  },
});

export const recordFalPoll = mutation({
  args: { variantId: v.id("creativeGenerationVariants"), kind: v.union(v.literal("image"), v.literal("clip")), leaseGeneration: v.number(), requestId: v.string(), status: v.union(v.literal("IN_QUEUE"), v.literal("IN_PROGRESS"), v.literal("COMPLETED")) },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const row = await ctx.db.get(args.variantId); if (!row) throw new Error("generation variant not found");
    const expectedStage = `${args.kind}_polling` as "image_polling" | "clip_polling";
    assertLease(row, expectedStage, args.leaseGeneration);
    const requestId = args.kind === "image" ? row.imageFalRequestId : row.clipFalRequestId;
    if (!requestId || requestId !== args.requestId) throw new Error("fal poll receipt mismatch");
    const nextStage: "image_polling" | "clip_polling" | "image_result_copy" | "clip_result_copy" = args.status === "COMPLETED"
      ? (args.kind === "image" ? "image_result_copy" : "clip_result_copy") : expectedStage;
    const patch = args.kind === "image" ? { imageFalStatus: args.status } : { clipFalStatus: args.status };
    await ctx.db.patch(args.variantId, {
      ...patch, stage: nextStage, runnableAt: Date.now() + (args.status === "COMPLETED" ? 0 : 15_000),
      leaseOwner: undefined, leaseExpiresAt: undefined,
      ...(args.status === "COMPLETED" ? { failureCount: 0, lastErrorCode: undefined } : {}),
      updatedAt: Date.now(),
    });
    return { stage: nextStage };
  },
});

export const recordFalObjectCopy = mutation({
  args: { variantId: v.id("creativeGenerationVariants"), kind: v.union(v.literal("image"), v.literal("clip")), leaseGeneration: v.number(), requestId: v.string(), object: objectReceipt },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const row = await ctx.db.get(args.variantId); if (!row) throw new Error("generation variant not found");
    const expectedStage = `${args.kind}_result_copy` as "image_result_copy" | "clip_result_copy";
    assertLease(row, expectedStage, args.leaseGeneration);
    const requestId = args.kind === "image" ? row.imageFalRequestId : row.clipFalRequestId;
    if (requestId !== args.requestId) throw new Error("fal result receipt mismatch");
    assertReceipt(args.object, args.kind === "image" ? "image/jpeg" : "video/mp4");
    const nextStage = args.kind === "image" ? "clip_submission" : "tts_reservation";
    const patch = args.kind === "image" ? { imageObject: args.object } : { clipObject: args.object };
    await ctx.db.patch(args.variantId, { ...patch, stage: nextStage, runnableAt: Date.now(), leaseOwner: undefined, leaseExpiresAt: undefined, failureCount: 0, lastErrorCode: undefined, updatedAt: Date.now() });
    return { stage: nextStage };
  },
});

export const recordTtsReceipt = mutation({
  args: { variantId: v.id("creativeGenerationVariants"), leaseGeneration: v.number(), requestId: v.string(), voiceId: v.string(), model: v.string(), textDigest: v.string(), characterCost: v.optional(v.number()), characterCount: v.number() },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const row = await ctx.db.get(args.variantId); if (!row) throw new Error("generation variant not found");
    assertLease(row, "tts_reservation", args.leaseGeneration);
    if (row.submissionStartedStage !== "tts_reservation" || !/^[A-Za-z0-9_-]{1,200}$/.test(args.requestId) || args.voiceId !== row.voiceId
      || args.model !== row.ttsModel || args.textDigest !== row.ttsTextDigest || args.characterCount !== row.hook.length
      || (args.characterCost !== undefined && (!Number.isFinite(args.characterCost) || args.characterCost < 0))) throw new Error("invalid ElevenLabs receipt identity");
    await ctx.db.patch(args.variantId, { stage: "tts_receipt", ttsRequestId: args.requestId, ttsCharacterCost: args.characterCost, ttsCharacterCount: args.characterCount, runnableAt: Date.now(), leaseOwner: undefined, leaseExpiresAt: undefined, failureCount: 0, lastErrorCode: undefined, updatedAt: Date.now() });
    return { stage: "tts_receipt" as const };
  },
});

export const recordTtsHistoryItem = mutation({
  args: { variantId: v.id("creativeGenerationVariants"), leaseGeneration: v.number(), requestId: v.string(), historyItemId: v.string() },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const row = await ctx.db.get(args.variantId); if (!row) throw new Error("generation variant not found");
    assertLease(row, "tts_receipt", args.leaseGeneration);
    if (row.ttsRequestId !== args.requestId || !/^[A-Za-z0-9_-]{1,200}$/.test(args.historyItemId)) throw new Error("ElevenLabs history receipt mismatch");
    await ctx.db.patch(args.variantId, { stage: "tts_audio_copy", ttsHistoryItemId: args.historyItemId, runnableAt: Date.now(), leaseOwner: undefined, leaseExpiresAt: undefined, failureCount: 0, lastErrorCode: undefined, updatedAt: Date.now() });
    return { stage: "tts_audio_copy" as const };
  },
});

export const recordTtsObjectCopy = mutation({
  args: { variantId: v.id("creativeGenerationVariants"), leaseGeneration: v.number(), requestId: v.string(), historyItemId: v.string(), object: objectReceipt },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const row = await ctx.db.get(args.variantId); if (!row) throw new Error("generation variant not found");
    assertLease(row, "tts_audio_copy", args.leaseGeneration);
    if (row.ttsRequestId !== args.requestId || row.ttsHistoryItemId !== args.historyItemId) throw new Error("ElevenLabs audio receipt mismatch");
    assertReceipt(args.object, "audio/mpeg");
    await ctx.db.patch(args.variantId, { stage: "assembly", audioObject: args.object, runnableAt: Date.now(), leaseOwner: undefined, leaseExpiresAt: undefined, failureCount: 0, lastErrorCode: undefined, updatedAt: Date.now() });
    return { stage: "assembly" as const };
  },
});

export const completeAssembly = mutation({
  args: { variantId: v.id("creativeGenerationVariants"), leaseGeneration: v.number(), object: objectReceipt, labelBurned: v.boolean() },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const row = await ctx.db.get(args.variantId); if (!row) throw new Error("generation variant not found");
    if (row.stage === "review_ready" && row.creativeId) {
      if (row.leaseGeneration !== args.leaseGeneration || !row.finalObject || JSON.stringify(row.finalObject) !== JSON.stringify(args.object) || args.labelBurned !== true) throw new Error("assembled object receipt conflict");
      return { creativeId: row.creativeId, reused: true as const };
    }
    assertLease(row, "assembly", args.leaseGeneration);
    assertReceipt(args.object, "video/mp4");
    if (!args.labelBurned) throw new Error("AI creative cannot enter review without verified burned-in disclosure");
    let creative = await ctx.db.query("creatives").withIndex("by_generation_variant", (q) => q.eq("generationVariantId", args.variantId)).unique();
    if (creative && (creative.r2Key !== row.finalR2Key || creative.siteId !== row.siteId || creative.status !== "review")) throw new Error("generation variant creative binding conflict");
    let creativeId = creative?._id;
    if (!creativeId) {
      creativeId = await ctx.db.insert("creatives", {
        siteId: row.siteId, productId: row.productId, generationVariantId: args.variantId, kind: "product_demo",
        r2Key: row.finalR2Key, aiGenerated: true, aiLabelRequired: true, labelBurned: true,
        hook: row.hook, status: "review", revision: 1, createdAt: Date.now(),
      });
      await appendAudit(ctx, { siteId: row.siteId, event: "creative_requested", detail: { creativeId, generationVariantId: args.variantId, kind: "product_demo", aiGenerated: true, aiLabelRequired: true, labelBurned: true, status: "review" } });
    }
    const now = Date.now();
    await ctx.db.patch(args.variantId, { stage: "review_ready", terminal: true, finalObject: args.object, labelBurned: true, creativeId, runnableAt: undefined, leaseOwner: undefined, leaseExpiresAt: undefined, failureCount: 0, lastErrorCode: undefined, updatedAt: now, completedAt: now });
    await refreshIntentProjection(ctx, row.intentId);
    return { creativeId, reused: !!creative as boolean };
  },
});

export const recordVariantFailure = mutation({
  args: { variantId: v.id("creativeGenerationVariants"), expectedStage: stage, leaseGeneration: v.number(), kind: v.union(v.literal("retryable_safe"), v.literal("definitive"), v.literal("ambiguous")), errorCode: v.string() },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const row = await ctx.db.get(args.variantId); if (!row) throw new Error("generation variant not found");
    assertLease(row, args.expectedStage, args.leaseGeneration);
    if (!/^[a-z0-9_:-]{1,100}$/.test(args.errorCode)) throw new Error("unsafe generation error code");
    const now = Date.now(); const failureCount = row.failureCount + 1;
    if (args.kind === "retryable_safe" && failureCount < MAX_STAGE_FAILURES) {
      await ctx.db.patch(args.variantId, { failureCount, lastErrorCode: args.errorCode, runnableAt: now + Math.min(60_000, 5_000 * 2 ** (failureCount - 1)), leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: now });
      await refreshIntentProjection(ctx, row.intentId);
      return { status: "retrying" as const, failureCount };
    }
    const terminalStage = args.kind === "ambiguous" ? "needs_attention" : "failed";
    const retryEligible = terminalStage === "failed" && isProviderSubmissionStage(args.expectedStage as GenerationStage)
      && row.submissionStartedStage !== args.expectedStage;
    await ctx.db.patch(args.variantId, { stage: terminalStage, terminal: true, failureCount, lastErrorCode: args.errorCode, failedAtStage: args.expectedStage, retryEligible, runnableAt: undefined, leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: now, completedAt: now });
    await refreshIntentProjection(ctx, row.intentId);
    return { status: terminalStage, failureCount, retryEligible };
  },
});

export const retryFailedVariant = mutation({
  args: { variantId: v.id("creativeGenerationVariants") },
  handler: async (ctx, { variantId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity?.subject !== "dropship-ai:operator" && identity?.subject !== "dropship-ai:service") throw new Error("UNAUTHENTICATED: operator retry required");
    const row = await ctx.db.get(variantId);
    if (!row || row.stage !== "failed" || row.retryEligible !== true || !row.failedAtStage
      || !isProviderSubmissionStage(row.failedAtStage as GenerationStage) || row.submissionStartedStage === row.failedAtStage) {
      throw new Error("only a proven pre-submission failure may be retried by an operator");
    }
    const retryStage = row.failedAtStage as "image_submission" | "clip_submission" | "tts_reservation";
    await ctx.db.patch(variantId, { stage: retryStage, terminal: false, failureCount: 0, lastErrorCode: undefined, failedAtStage: undefined, retryEligible: undefined, completedAt: undefined, runnableAt: Date.now(), updatedAt: Date.now() });
    await refreshIntentProjection(ctx, row.intentId);
    return { variantId, status: "queued" as const, stage: retryStage };
  },
});

export const listOperatorProjection = query({
  args: { siteId: v.optional(v.id("sites")), limit: v.optional(v.number()) },
  handler: async (ctx, { siteId, limit }) => {
    const take = safeLimit(limit, 20, 50);
    let intents: any[] = [];
    if (siteId) intents = await ctx.db.query("creativeGenerationIntents").withIndex("by_site_updated", (q) => q.eq("siteId", siteId)).order("desc").take(take);
    else {
      const sites = (await ctx.db.query("sites").take(200)).filter((site) => site.sample !== true);
      for (const site of sites) intents.push(...await ctx.db.query("creativeGenerationIntents").withIndex("by_site_updated", (q) => q.eq("siteId", site._id)).order("desc").take(take));
      intents.sort((a, b) => b.updatedAt - a.updatedAt); intents = intents.slice(0, take);
    }
    return Promise.all(intents.map(async (intent) => {
      const variants = await ctx.db.query("creativeGenerationVariants").withIndex("by_intent_index", (q) => q.eq("intentId", intent._id)).take(intent.requestedVariants);
      return {
        intentId: intent._id, siteId: intent.siteId, requested: intent.requestedVariants, status: intent.status,
        active: intent.activeVariants, ready: intent.readyVariants, failed: intent.failedVariants,
        needsAttention: intent.attentionVariants, handoffStatus: intent.handoffStatus, updatedAt: intent.updatedAt,
        variants: variants.map((row) => ({ variantId: row._id, index: row.variantIndex, stage: row.stage, terminal: row.terminal, lastErrorCode: row.lastErrorCode, retryEligible: row.retryEligible === true, creativeId: row.creativeId })),
      };
    }));
  },
});
