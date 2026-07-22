// Durable content generation. Trigger payloads carry only opaque Convex IDs; immutable prompts,
// provider receipts, leases, deterministic object identities, and parent truth live in Convex.
import { task, tasks, schedules, queue, logger } from "@trigger.dev/sdk/v3";
import { convexClient, api } from "../lib/convexClient";
import type { Id } from "../../convex/_generated/dataModel";
import {
  clipQueueInput, copyFalQueueResult, FAL_CLIP_START_TIMEOUT_SECONDS,
  FAL_INPUT_URL_MARGIN_SECONDS, FalDefinitiveSubmissionError, FalSubmissionAmbiguousError,
  getFalApiKey, imageQueueInput, readFalQueueStatus, submitFalQueue,
  type FalQueueReceipt,
} from "../lib/gen/fal";
import {
  copyTtsHistoryAudio, findUniqueTtsHistoryItem, getElevenLabsApiKey, openElevenLabsTts,
  TtsDefinitiveSubmissionError, TtsSubmissionAmbiguousError, type TtsProviderReceipt,
} from "../lib/gen/tts";
import { assemble } from "../lib/assemble";
import { distribute, reconcileAyrsharePost, type CreativeForPublish, type Platform } from "../lib/distribute";
import { providerDeliveryDecision } from "../lib/distributionState";
import { DeterministicObjectConflictError, getSignedUrl } from "../lib/storage";
import { cancelResponseBody } from "../lib/boundedBody";
import { generationHandoffKey, generationStageKey, validateControlPlaneIdentity, type GenerationStage } from "../lib/creativeGeneration";

const configuredConcurrency = Number(process.env.CREATIVE_GENERATION_CONCURRENCY ?? "3");
export const creativeGenerationQueue = queue({
  name: "creative-generation-stages",
  concurrencyLimit: Number.isInteger(configuredConcurrency) ? Math.max(1, Math.min(configuredConcurrency, 8)) : 3,
});

type VariantPayload = { variantId: string; stage: GenerationStage };
type VariantRow = Record<string, any> & { _id: Id<"creativeGenerationVariants">; stage: GenerationStage; leaseGeneration: number };

function falReceipt(row: VariantRow, kind: "image" | "clip"): FalQueueReceipt {
  return kind === "image"
    ? { requestId: row.imageFalRequestId, model: row.imageModel, statusUrl: row.imageFalStatusUrl, resultUrl: row.imageFalResultUrl }
    : { requestId: row.clipFalRequestId, model: row.clipModel, statusUrl: row.clipFalStatusUrl, resultUrl: row.clipFalResultUrl };
}

function ttsReceipt(row: VariantRow): TtsProviderReceipt {
  return { requestId: row.ttsRequestId, voiceId: row.voiceId, model: row.ttsModel, textDigest: row.ttsTextDigest, characterCount: row.ttsCharacterCount, characterCost: row.ttsCharacterCost };
}

type ExecutorOverrides = {
  convex?: ReturnType<typeof convexClient>;
  getElevenLabsApiKey?: typeof getElevenLabsApiKey;
  openElevenLabsTts?: typeof openElevenLabsTts;
  cancelResponseBody?: typeof cancelResponseBody;
};

export async function processCreativeGenerationVariant(payload: VariantPayload, owner: string, overrides: ExecutorOverrides = {}) {
  const convex = overrides.convex ?? convexClient();
  validateControlPlaneIdentity(owner, "worker owner ID");
  const variantId = payload.variantId as Id<"creativeGenerationVariants">;
  const claimed: any = await convex.mutation(api.creativeGenerations.claimVariantStage, {
    variantId, expectedStage: payload.stage, owner, leaseMs: payload.stage === "assembly" ? 10 * 60_000 : 2 * 60_000,
  });
  if (claimed.state !== "claimed") return claimed;
  const row = claimed.variant as VariantRow;
  const leaseGeneration = claimed.leaseGeneration as number;
  const fail = (kind: "retryable_safe" | "definitive" | "ambiguous", errorCode: string) =>
    convex.mutation(api.creativeGenerations.recordVariantFailure, { variantId, expectedStage: payload.stage, leaseGeneration, kind, errorCode });

  try {
    if (payload.stage === "image_submission" || payload.stage === "clip_submission") {
      const kind = payload.stage === "image_submission" ? "image" : "clip";
      const apiKey = await getFalApiKey(); // known pre-submission configuration failure is safely retryable
      let input: Record<string, unknown>;
      if (kind === "image") input = imageQueueInput(row.imagePrompt);
      else {
        const lifetime = FAL_CLIP_START_TIMEOUT_SECONDS + FAL_INPUT_URL_MARGIN_SECONDS;
        input = clipQueueInput(await getSignedUrl(row.imageR2Key, lifetime), row.clipPrompt);
      }
      await convex.mutation(api.creativeGenerations.beginProviderSubmission, { variantId, expectedStage: payload.stage, leaseGeneration });
      try {
        const receipt = await submitFalQueue({
          model: kind === "image" ? row.imageModel : row.clipModel, input, apiKey,
          ...(kind === "clip" ? { startTimeoutSeconds: FAL_CLIP_START_TIMEOUT_SECONDS } : {}),
        });
        return await convex.mutation(api.creativeGenerations.recordFalSubmission, { variantId, kind, leaseGeneration, ...receipt });
      } catch (error) {
        if (error instanceof FalDefinitiveSubmissionError) return fail("definitive", "fal_submission_rejected");
        return fail("ambiguous", error instanceof FalSubmissionAmbiguousError ? "fal_submission_receipt_ambiguous" : "fal_submission_unknown");
      }
    }

    if (payload.stage === "image_polling" || payload.stage === "clip_polling") {
      const kind = payload.stage === "image_polling" ? "image" : "clip";
      const receipt = falReceipt(row, kind);
      const status = await readFalQueueStatus({ receipt, apiKey: await getFalApiKey() });
      if (status.failed) return fail("definitive", "fal_request_failed");
      return convex.mutation(api.creativeGenerations.recordFalPoll, { variantId, kind, leaseGeneration, requestId: receipt.requestId, status: status.status });
    }

    if (payload.stage === "image_result_copy" || payload.stage === "clip_result_copy") {
      const kind = payload.stage === "image_result_copy" ? "image" : "clip";
      const receipt = falReceipt(row, kind);
      const object = await copyFalQueueResult({ kind, receipt, apiKey: await getFalApiKey(), r2Key: kind === "image" ? row.imageR2Key : row.clipR2Key });
      return convex.mutation(api.creativeGenerations.recordFalObjectCopy, { variantId, kind, leaseGeneration, requestId: receipt.requestId, object });
    }

    if (payload.stage === "tts_reservation") {
      const apiKey = await (overrides.getElevenLabsApiKey ?? getElevenLabsApiKey)();
      await convex.mutation(api.creativeGenerations.beginProviderSubmission, { variantId, expectedStage: "tts_reservation", leaseGeneration });
      try {
        const opened = await (overrides.openElevenLabsTts ?? openElevenLabsTts)({ text: row.hook, voiceId: row.voiceId, model: row.ttsModel, apiKey });
        const recorded = await convex.mutation(api.creativeGenerations.recordTtsReceipt, { variantId, leaseGeneration, ...opened.receipt });
        // The header receipt is durable. Stop the unneeded audio stream without materializing it;
        // the next stage recovers this exact billed generation from history.
        await (overrides.cancelResponseBody ?? cancelResponseBody)(opened.response);
        return recorded;
      } catch (error) {
        if (error instanceof TtsDefinitiveSubmissionError) return fail("definitive", "tts_submission_rejected");
        return fail("ambiguous", error instanceof TtsSubmissionAmbiguousError ? "tts_submission_receipt_ambiguous" : "tts_submission_unknown");
      }
    }

    if (payload.stage === "tts_receipt") {
      try {
        const receipt = ttsReceipt(row);
        const historyItemId = await findUniqueTtsHistoryItem({ receipt, text: row.hook, createdAt: row.submissionStartedAt, apiKey: await getElevenLabsApiKey() });
        return convex.mutation(api.creativeGenerations.recordTtsHistoryItem, { variantId, leaseGeneration, requestId: receipt.requestId, historyItemId });
      } catch {
        return fail(row.failureCount >= 2 ? "ambiguous" : "retryable_safe", "tts_history_not_uniquely_recoverable");
      }
    }

    if (payload.stage === "tts_audio_copy") {
      try {
        const receipt = ttsReceipt(row);
        const object = await copyTtsHistoryAudio({ historyItemId: row.ttsHistoryItemId, apiKey: await getElevenLabsApiKey(), r2Key: row.audioR2Key });
        return convex.mutation(api.creativeGenerations.recordTtsObjectCopy, { variantId, leaseGeneration, requestId: receipt.requestId, historyItemId: row.ttsHistoryItemId, object });
      } catch {
        return fail(row.failureCount >= 2 ? "ambiguous" : "retryable_safe", "tts_audio_copy_failed");
      }
    }

    if (payload.stage === "assembly") {
      const result = await assemble({
        productClipR2Key: row.clipR2Key, productClipReceipt: row.clipObject,
        voiceoverR2Key: row.audioR2Key, voiceoverReceipt: row.audioObject,
        captions: row.hook, aiLabelRequired: true, outR2Key: row.finalR2Key,
      });
      return convex.mutation(api.creativeGenerations.completeAssembly, {
        variantId, leaseGeneration, object: { contentType: result.contentType, bytes: result.bytes, sha256: result.sha256 }, labelBurned: result.labelBurned,
      });
    }
    return { state: "terminal" as const, stage: payload.stage };
  } catch (error) {
    const conflict = error instanceof DeterministicObjectConflictError;
    logger.warn("creative generation stage deferred", { variantId, stage: payload.stage, code: conflict ? "deterministic_object_conflict" : "safe_stage_failure" });
    return fail(conflict ? "ambiguous" : "retryable_safe", conflict ? "deterministic_object_conflict" : "safe_stage_failure");
  }
}

export const creativeGenerationStage = task({
  id: "creative-generation-stage",
  queue: creativeGenerationQueue,
  maxDuration: 600,
  run: async (payload: VariantPayload, { ctx }) => processCreativeGenerationVariant(payload, ctx.run.id),
});

type DispatchOverrides = {
  convex?: ReturnType<typeof convexClient>;
  trigger?: typeof tasks.trigger;
  now?: number;
};

async function dispatchRows(
  due: Array<{ variantId: string; stage: GenerationStage; leaseGeneration: number }>,
  trigger: typeof tasks.trigger,
) {
  for (const row of due) {
    await trigger<typeof creativeGenerationStage>("creative-generation-stage", { variantId: row.variantId, stage: row.stage }, {
      idempotencyKey: generationStageKey(row.variantId, row.stage, row.leaseGeneration + 1), idempotencyKeyTTL: "1m",
    });
  }
  return due.length;
}

export async function dispatchDueVariants(limit = 12, overrides: DispatchOverrides = {}) {
  const convex = overrides.convex ?? convexClient();
  const due: Array<{ variantId: string; stage: GenerationStage; leaseGeneration: number }> = await convex.query(
    api.creativeGenerations.listDueVariants, { limit, now: overrides.now ?? Date.now() },
  ) as any;
  return dispatchRows(due, overrides.trigger ?? tasks.trigger);
}

export async function dispatchDueVariantsForIntent(intentIdentity: string, overrides: DispatchOverrides = {}) {
  const intentId = validateControlPlaneIdentity(intentIdentity, "generation intent ID") as Id<"creativeGenerationIntents">;
  const convex = overrides.convex ?? convexClient();
  const due: Array<{ variantId: string; stage: GenerationStage; leaseGeneration: number }> = await convex.query(
    api.creativeGenerations.listDueVariantsForIntent, { intentId, now: overrides.now ?? Date.now() },
  ) as any;
  return dispatchRows(due, overrides.trigger ?? tasks.trigger);
}

export async function runContentFactory(payload: { intentId: string }, overrides: DispatchOverrides = {}) {
  const intentId = validateControlPlaneIdentity(payload.intentId, "generation intent ID");
  return { intentId, dispatchedVariants: await dispatchDueVariantsForIntent(intentId, overrides) };
}

// The original task ID is retained as a short, idempotent handoff for deployed callers.
export const contentFactory = task({
  id: "content-factory",
  maxDuration: 60,
  run: async (payload: { intentId: string }) => runContentFactory(payload),
});

export const creativeGenerationRecovery = schedules.task({
  id: "creative-generation-recovery",
  cron: "*/1 * * * *",
  run: async () => {
    const convex = convexClient();
    const handoffs: Array<{ intentId: string }> = await convex.query(api.creativeGenerations.listDueIntentHandoffs, { limit: 25, now: Date.now() }) as any;
    let recoveredHandoffs = 0;
    for (const due of handoffs) {
      const claim: any = await convex.mutation(api.creativeGenerations.claimIntentHandoff, { intentId: due.intentId as Id<"creativeGenerationIntents"> });
      if (claim.state !== "dispatch") continue;
      try {
        const handle = await tasks.trigger<typeof contentFactory>("content-factory", { intentId: due.intentId }, { idempotencyKey: generationHandoffKey(due.intentId, claim.generation), idempotencyKeyTTL: "24w" });
        await convex.mutation(api.creativeGenerations.recordIntentHandoff, { intentId: due.intentId as Id<"creativeGenerationIntents">, generation: claim.generation, triggerRunId: handle.id });
        recoveredHandoffs++;
      } catch {
        logger.warn("creative generation handoff remains reclaimable", { intentId: due.intentId });
      }
    }
    return { dueHandoffs: handoffs.length, recoveredHandoffs, dispatchedVariants: await dispatchDueVariants(25) };
  },
});

// On explicit publication authorization → distribute the immutable destination snapshot.
export const scheduleApprovedCreative = task({
  id: "schedule-approved-creative",
  run: async (payload: { creativeId: string; dispatchKey: string }) => {
    const convex = convexClient();
    const creativeId = payload.creativeId as Id<"creatives">;
    const creative = await convex.query(api.creatives.get, { creativeId });
    if (!creative) throw new Error(`creative ${creativeId} not found`);
    if (creative.status !== "approved") {
      logger.warn("schedule-approved-creative: not approved, skipping", { creativeId, status: creative.status });
      return { skipped: true, reason: `status ${creative.status}` };
    }
    if (creative.aiLabelRequired && creative.labelBurned !== true) {
      return { skipped: true, reason: "AI disclosure burn was not verified", creativeId };
    }
    const authorization = await convex.query(api.posts.getDistributionAuthorization, { creativeId, dispatchKey: payload.dispatchKey });
    if (!authorization) return { skipped: true, reason: "publication authorization is missing, stale, or mismatched", creativeId };
    const site = await convex.query(api.sites.get, { siteId: creative.siteId as Id<"sites"> });
    if (!site || site.sample === true) {
      return { skipped: true, reason: "sample or missing site cannot distribute", creativeId };
    }

    const idempotencyKey = authorization.dispatchKey;
    const target = `creative-distribution:${creativeId}`;
    const queued = await convex.mutation(api.ops.enqueue, {
      siteId: creative.siteId as Id<"sites">, kind: "creative.distribute", target, idempotencyKey, traceId: idempotencyKey,
      payload: { creativeId, creativeRevision: authorization.creativeRevision, platforms: authorization.destinations.map((d) => d.platform) },
    });
    if (queued.duplicate && queued.status === "delivered") return { skipped: true, reason: "already distributed", creativeId };
    const lock = await convex.mutation(api.ops.claimTarget, { target, owner: idempotencyKey, leaseMs: 10 * 60_000 });
    if (!lock.acquired) return { skipped: true, reason: "target locked", creativeId };

    try {
      // Create the local schedule before marking the external attempt. A crash at any point
      // therefore leaves a durable post ledger entry, while a crash after `processing` can only
      // move to receipt reconciliation and can never issue a second provider POST.
      const scheduledPosts: Record<string, Id<"posts">> = {};
      for (const destination of authorization.destinations) {
        const post = await convex.mutation(api.posts.schedule, {
          siteId: creative.siteId as Id<"sites">, creativeId, platform: destination.platform,
          targetAccount: destination.targetAccount, caption: authorization.caption,
          dispatchKey: authorization.dispatchKey, status: "scheduled",
        });
        scheduledPosts[destination.platform] = post.postId;
      }

      const outbox = queued.duplicate ? await convex.query(api.ops.getOutboxByKey, { idempotencyKey }) : undefined;
      const deliveryDecision = providerDeliveryDecision((outbox?.status ?? queued.status) as "pending" | "processing" | "delivered" | "failed" | "ambiguous");
      if (deliveryDecision === "already_delivered") return { skipped: true, reason: "already distributed", creativeId };
      if (deliveryDecision === "reconcile_required") {
        if (!outbox?.providerReceiptId) {
          await convex.mutation(api.posts.completeDistributionDispatch, { creativeId, dispatchKey: idempotencyKey, reconciliationRequired: true, error: "provider_receipt_missing" });
          return { mode: "reconcile_required", creativeId, reason: "provider attempt has no receipt; automatic repost is forbidden" };
        }
        const reconciliation = await reconcileAyrsharePost(outbox.providerReceiptId, authorization.destinations.map((d) => d.platform as Platform));
        for (const [platform, externalPostId] of Object.entries(reconciliation.postIds)) {
          const postId = scheduledPosts[platform];
          if (postId) await convex.mutation(api.posts.markPublished, { postId, externalPostId });
        }
        if (reconciliation.missingPlatforms.length) {
          await convex.mutation(api.posts.completeDistributionDispatch, { creativeId, dispatchKey: idempotencyKey, reconciliationRequired: true, error: "provider_receipt_incomplete" });
          return { mode: "reconcile_required", creativeId, reason: "provider receipt is incomplete; automatic repost is forbidden" };
        }
        await convex.mutation(api.ops.markOutbox, { outboxId: queued.outboxId, status: "delivered", detail: { mode: "ayrshare", reconciled: true } });
        await convex.mutation(api.posts.completeDistributionDispatch, { creativeId, dispatchKey: idempotencyKey });
        return { mode: "ayrshare", posts: Object.keys(reconciliation.postIds).length, reconciled: true };
      }

      await convex.mutation(api.ops.markOutbox, { outboxId: queued.outboxId, status: "processing" });
      const mediaUrl = await getSignedUrl(creative.r2Key, 3600);
      const forPublish: CreativeForPublish = {
        aiGenerated: creative.aiGenerated,
        aiLabelRequired: creative.aiLabelRequired,
        labelBurned: creative.labelBurned === true,
        mediaUrl,
        caption: authorization.caption,
      };

      // distribute() runs assertLabelGate() first — hard stop on any unlabeled AI asset.
      const result = await distribute(forPublish, {
        distributionMode: site.distributionMode, idempotencyKey,
        destinations: authorization.destinations as Array<{ platform: Platform; targetAccount: string }>,
      });

      if (result.mode === "ayrshare" && result.ok) {
        for (const [platform, externalPostId] of Object.entries(result.postIds)) {
          const postId = scheduledPosts[platform];
          if (postId) await convex.mutation(api.posts.markPublished, { postId, externalPostId });
        }
        if (result.missingPlatforms.length) {
          await convex.mutation(api.ops.markOutbox, { outboxId: queued.outboxId, status: "ambiguous", providerReceiptId: result.providerReceiptId, error: "provider_receipt_missing", detail: { mode: "ayrshare", missingPlatforms: result.missingPlatforms, providerErrors: result.providerErrors ?? null } });
          await convex.mutation(api.posts.completeDistributionDispatch, { creativeId, dispatchKey: idempotencyKey, reconciliationRequired: true, error: "provider_receipt_missing" });
          return { mode: "reconcile_required", creativeId, reason: "provider response omitted one or more post receipts; automatic repost is forbidden" };
        }
        await convex.mutation(api.ops.markOutbox, { outboxId: queued.outboxId, status: "delivered", providerReceiptId: result.providerReceiptId, detail: { mode: "ayrshare", platforms: result.platforms } });
        await convex.mutation(api.posts.completeDistributionDispatch, { creativeId, dispatchKey: idempotencyKey });
        return { mode: "ayrshare", posts: result.platforms.length };
      }

      if (result.mode === "semi_manual") {
        // cold-start: convert the pre-created rows to an explicit manual directive.
        for (const postId of Object.values(scheduledPosts)) await convex.mutation(api.posts.markAwaitingManualPublish, { postId: postId as Id<"posts"> });
        await convex.mutation(api.ops.markOutbox, { outboxId: queued.outboxId, status: "delivered", detail: { mode: "semi_manual" } });
        await convex.mutation(api.posts.completeDistributionDispatch, { creativeId, dispatchKey: idempotencyKey });
        return { mode: "semi_manual", posts: authorization.destinations.length, reason: result.reason };
      }

      logger.error("schedule-approved-creative: distribution blocked", { creativeId, result });
      await convex.mutation(api.ops.markOutbox, { outboxId: queued.outboxId, status: "failed", error: result.ok ? "unknown" : result.reason });
      await convex.mutation(api.posts.completeDistributionDispatch, { creativeId, dispatchKey: idempotencyKey, reconciliationRequired: true, error: result.ok ? "unknown" : result.reason });
      return { mode: "blocked", reason: result.ok ? "unknown" : result.reason };
    } catch (error) {
      // Once processing was durably recorded, the network call may have reached Ayrshare. Do not
      // let Trigger retry it as a fresh post; preserve reconciliation instead.
      await convex.mutation(api.ops.markOutbox, { outboxId: queued.outboxId, status: "ambiguous", error: String(error).slice(0, 500) });
      await convex.mutation(api.posts.completeDistributionDispatch, { creativeId, dispatchKey: idempotencyKey, reconciliationRequired: true, error: "provider_response_ambiguous" });
      return { mode: "reconcile_required", creativeId, reason: "provider response was ambiguous; automatic repost is forbidden" };
    } finally {
      await convex.mutation(api.ops.releaseTarget, { target, owner: idempotencyKey });
    }
  },
});
