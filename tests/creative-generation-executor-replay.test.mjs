import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import "./helpers/unref-long-convex-timers.mjs";
import { convexTest } from "convex-test";
import { getFunctionName } from "convex/server";
import schemaModule from "../convex/schema.ts";
import apiModule from "../convex/_generated/api.js";
import { creativeGenerationInputDigest } from "../src/lib/creativeGeneration.ts";
import { FalSubmissionAmbiguousError } from "../src/lib/gen/fal.ts";
import { processCreativeGenerationVariant } from "../src/trigger/content-factory.ts";

const modules = {
  "../convex/creativeGenerations.ts": () => import("../convex/creativeGenerations.ts"),
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
};
const schema = schemaModule.default ?? schemaModule;
const { api } = apiModule;
const service = (t) => t.withIdentity({ subject: "dropship-ai:service" });

const storedObject = (contentType, marker) => ({
  contentType, bytes: 12, sha256: createHash("sha256").update(marker).digest("hex"),
});

async function seedVariant(t, requestId) {
  const siteId = await t.run((ctx) => ctx.db.insert("sites", {
    name: requestId, niche: "test", status: "active", minKitPriceUsd: 40,
    minBlendedMarginPct: 70, distributionMode: "semi_manual", createdAt: 1,
  }));
  const normalized = { siteId, productId: null, variants: 1, scenePrompt: "fixture", hooks: ["one"] };
  const intent = await service(t).mutation(api.creativeGenerations.createOrReuseIntent, {
    siteId, callerRequestId: requestId, normalizedInputDigest: creativeGenerationInputDigest(normalized),
    requestedVariants: 1, scenePrompt: normalized.scenePrompt, hooks: normalized.hooks,
    imageModel: "fal-ai/flux/schnell", clipModel: "fal-ai/kling-video/v1/standard/image-to-video",
    ttsModel: "eleven_turbo_v2_5", voiceId: "voice-1",
  });
  const row = await t.run((ctx) => ctx.db.query("creativeGenerationVariants")
    .withIndex("by_intent_index", (q) => q.eq("intentId", intent.intentId)).unique());
  return { siteId, intentId: intent.intentId, row };
}

function countingConvex(t, counts, afterMutation) {
  const client = service(t);
  return {
    query: (...args) => client.query(...args),
    mutation: async (reference, args) => {
      const name = getFunctionName(reference);
      counts[name] = (counts[name] ?? 0) + 1;
      const result = await client.mutation(reference, args);
      if (afterMutation) await afterMutation(name, args, result);
      return result;
    },
  };
}

function effectsFor(t, counts, overrides = {}, afterMutation) {
  const forbidden = (name) => async () => { throw new Error(`unexpected executor effect: ${name}`); };
  return {
    convex: countingConvex(t, counts.mutations, afterMutation),
    getFalApiKey: async () => { counts.vaultReads++; return "fal-fixture"; },
    getElevenLabsApiKey: async () => { counts.vaultReads++; return "eleven-fixture"; },
    getSignedUrl: forbidden("getSignedUrl"),
    submitFalQueue: forbidden("submitFalQueue"),
    readFalQueueStatus: forbidden("readFalQueueStatus"),
    copyFalQueueResult: forbidden("copyFalQueueResult"),
    openElevenLabsTts: forbidden("openElevenLabsTts"),
    cancelResponseBody: forbidden("cancelResponseBody"),
    findUniqueTtsHistoryItem: forbidden("findUniqueTtsHistoryItem"),
    copyTtsHistoryAudio: forbidden("copyTtsHistoryAudio"),
    assemble: forbidden("assemble"),
    ...overrides,
  };
}

function freshCounts() {
  return { mutations: {}, vaultReads: 0, falSubmits: 0, falStatusReads: 0, falResultReads: 0,
    ttsSubmits: 0, ttsHistoryReads: 0, ttsAudioReads: 0, bodyCancels: 0,
    storageAttempts: 0, storageCommits: 0, assemblyRuns: 0 };
}

async function installFalReceipt(t, row, status = "IN_QUEUE") {
  const claim = await service(t).mutation(api.creativeGenerations.claimVariantStage, {
    variantId: row._id, expectedStage: "image_submission", owner: "fixture-submit", leaseMs: 60_000,
  });
  await service(t).mutation(api.creativeGenerations.beginProviderSubmission, {
    variantId: row._id, expectedStage: "image_submission", leaseGeneration: claim.leaseGeneration,
  });
  const requestId = "fal-request-0001";
  const root = `https://queue.fal.run/${row.imageModel}/requests/${requestId}`;
  await service(t).mutation(api.creativeGenerations.recordFalSubmission, {
    variantId: row._id, kind: "image", leaseGeneration: claim.leaseGeneration,
    requestId, model: row.imageModel, statusUrl: `${root}/status`, resultUrl: `${root}/response`,
  });
  if (status === "COMPLETED") {
    const pollClaim = await service(t).mutation(api.creativeGenerations.claimVariantStage, {
      variantId: row._id, expectedStage: "image_polling", owner: "fixture-poll", leaseMs: 60_000,
    });
    await service(t).mutation(api.creativeGenerations.recordFalPoll, {
      variantId: row._id, kind: "image", leaseGeneration: pollClaim.leaseGeneration,
      requestId, status: "COMPLETED",
    });
  }
  return requestId;
}

test("actual executor terminalizes a lost Fal submission response and replay cannot resubmit", async () => {
  const t = convexTest({ schema, modules });
  const { row } = await seedVariant(t, "executor-fal-loss-0001");
  const counts = freshCounts();
  const effects = effectsFor(t, counts, {
    submitFalQueue: async () => { counts.falSubmits++; throw new FalSubmissionAmbiguousError(); },
  });
  const first = await processCreativeGenerationVariant({ variantId: row._id, stage: "image_submission" }, "fal-loss-owner", effects);
  const replay = await processCreativeGenerationVariant({ variantId: row._id, stage: "image_submission" }, "fal-loss-replay", effects);
  const durable = await t.run((ctx) => ctx.db.get(row._id));
  assert.deepEqual({ first: first.status, replay: replay.state, stage: durable.stage, terminal: durable.terminal },
    { first: "needs_attention", replay: "stale", stage: "needs_attention", terminal: true });
  assert.deepEqual({ submits: counts.falSubmits, begin: counts.mutations["creativeGenerations:beginProviderSubmission"],
    failures: counts.mutations["creativeGenerations:recordVariantFailure"], claims: counts.mutations["creativeGenerations:claimVariantStage"] },
  { submits: 1, begin: 1, failures: 1, claims: 2 });
});

test("actual executor restarts a known Fal receipt with status/result reads and zero submit", async () => {
  const t = convexTest({ schema, modules });
  const { row } = await seedVariant(t, "executor-fal-receipt-0001");
  const requestId = await installFalReceipt(t, row);
  const counts = freshCounts();
  const receiptObject = storedObject("image/jpeg", "known-fal-receipt");
  const effects = effectsFor(t, counts, {
    readFalQueueStatus: async ({ receipt }) => {
      counts.falStatusReads++; assert.equal(receipt.requestId, requestId);
      return { status: "COMPLETED", failed: false };
    },
    copyFalQueueResult: async ({ receipt }) => {
      counts.falResultReads++; counts.storageAttempts++; counts.storageCommits++;
      assert.equal(receipt.requestId, requestId); return receiptObject;
    },
  });
  await processCreativeGenerationVariant({ variantId: row._id, stage: "image_polling" }, "fal-status-owner", effects);
  const copied = await processCreativeGenerationVariant({ variantId: row._id, stage: "image_result_copy" }, "fal-result-owner", effects);
  assert.equal(copied.stage, "clip_submission");
  assert.deepEqual({ submits: counts.falSubmits, status: counts.falStatusReads, results: counts.falResultReads,
    storageAttempts: counts.storageAttempts, storageCommits: counts.storageCommits },
  { submits: 0, status: 1, results: 1, storageAttempts: 1, storageCommits: 1 });
  assert.deepEqual({ claims: counts.mutations["creativeGenerations:claimVariantStage"],
    polls: counts.mutations["creativeGenerations:recordFalPoll"],
    objectWrites: counts.mutations["creativeGenerations:recordFalObjectCopy"] },
  { claims: 2, polls: 1, objectWrites: 1 });
});

test("actual executor reuses the exact Fal receipt after deterministic R2 response loss", async () => {
  const t = convexTest({ schema, modules });
  const { row } = await seedVariant(t, "executor-r2-loss-0001");
  const requestId = await installFalReceipt(t, row);
  const counts = freshCounts();
  const committed = storedObject("image/jpeg", "one-deterministic-object");
  let objectExists = false;
  const effects = effectsFor(t, counts, {
    readFalQueueStatus: async ({ receipt }) => {
      counts.falStatusReads++; assert.equal(receipt.requestId, requestId);
      return { status: "COMPLETED", failed: false };
    },
    copyFalQueueResult: async ({ receipt, r2Key }) => {
      counts.falResultReads++; counts.storageAttempts++;
      assert.equal(receipt.requestId, requestId);
      assert.equal(r2Key, row.imageR2Key);
      if (!objectExists) {
        objectExists = true; counts.storageCommits++;
        throw new Error("R2 response lost after deterministic commit");
      }
      return committed;
    },
  });
  await processCreativeGenerationVariant({ variantId: row._id, stage: "image_polling" }, "r2-status-owner", effects);
  const lost = await processCreativeGenerationVariant({ variantId: row._id, stage: "image_result_copy" }, "r2-loss-owner", effects);
  assert.equal(lost.status, "retrying");
  await t.run((ctx) => ctx.db.patch(row._id, { runnableAt: 0 }));
  const replay = await processCreativeGenerationVariant({ variantId: row._id, stage: "image_result_copy" }, "r2-replay-owner", effects);
  assert.equal(replay.stage, "clip_submission");
  assert.deepEqual({ submits: counts.falSubmits, status: counts.falStatusReads, results: counts.falResultReads,
    storageAttempts: counts.storageAttempts, storageCommits: counts.storageCommits },
  { submits: 0, status: 1, results: 2, storageAttempts: 2, storageCommits: 1 });
  assert.deepEqual({ claims: counts.mutations["creativeGenerations:claimVariantStage"],
    polls: counts.mutations["creativeGenerations:recordFalPoll"],
    failures: counts.mutations["creativeGenerations:recordVariantFailure"],
    objectWrites: counts.mutations["creativeGenerations:recordFalObjectCopy"] },
  { claims: 3, polls: 1, failures: 1, objectWrites: 1 });
});

test("actual executor records TTS headers, cancels the body, and restart is read-only recovery", async () => {
  const t = convexTest({ schema, modules });
  const { row } = await seedVariant(t, "executor-tts-restart-0001");
  await t.run((ctx) => ctx.db.patch(row._id, {
    stage: "tts_reservation", runnableAt: 0,
    imageObject: storedObject("image/jpeg", "tts-image"),
    clipObject: storedObject("video/mp4", "tts-clip"),
  }));
  const counts = freshCounts();
  const requestId = "tts-request-0001";
  const historyItemId = "tts-history-0001";
  const audioObject = storedObject("audio/mpeg", "tts-audio");
  const effects = effectsFor(t, counts, {
    openElevenLabsTts: async ({ text, voiceId, model }) => {
      counts.ttsSubmits++;
      return { receipt: { requestId, voiceId, model, textDigest: row.ttsTextDigest,
        characterCount: text.length, characterCost: 3 }, response: new Response(new Uint8Array([1, 2, 3])) };
    },
    cancelResponseBody: async (response) => { counts.bodyCancels++; await response.body.cancel(); },
    findUniqueTtsHistoryItem: async ({ receipt }) => {
      counts.ttsHistoryReads++; assert.equal(receipt.requestId, requestId); return historyItemId;
    },
    copyTtsHistoryAudio: async ({ historyItemId: id, r2Key }) => {
      counts.ttsAudioReads++; counts.storageAttempts++; counts.storageCommits++;
      assert.equal(id, historyItemId); assert.equal(r2Key, row.audioR2Key); return audioObject;
    },
  });
  await processCreativeGenerationVariant({ variantId: row._id, stage: "tts_reservation" }, "tts-submit-owner", effects);
  const stale = await processCreativeGenerationVariant({ variantId: row._id, stage: "tts_reservation" }, "tts-submit-replay", effects);
  await processCreativeGenerationVariant({ variantId: row._id, stage: "tts_receipt" }, "tts-history-owner", effects);
  const copied = await processCreativeGenerationVariant({ variantId: row._id, stage: "tts_audio_copy" }, "tts-audio-owner", effects);
  assert.equal(stale.state, "stale");
  assert.equal(copied.stage, "assembly");
  assert.deepEqual({ submits: counts.ttsSubmits, cancels: counts.bodyCancels, history: counts.ttsHistoryReads,
    audio: counts.ttsAudioReads, storageAttempts: counts.storageAttempts, storageCommits: counts.storageCommits },
  { submits: 1, cancels: 1, history: 1, audio: 1, storageAttempts: 1, storageCommits: 1 });
  assert.deepEqual({ claims: counts.mutations["creativeGenerations:claimVariantStage"],
    begins: counts.mutations["creativeGenerations:beginProviderSubmission"],
    receipts: counts.mutations["creativeGenerations:recordTtsReceipt"],
    historyWrites: counts.mutations["creativeGenerations:recordTtsHistoryItem"],
    objectWrites: counts.mutations["creativeGenerations:recordTtsObjectCopy"] },
  { claims: 4, begins: 1, receipts: 1, historyWrites: 1, objectWrites: 1 });
});

test("actual executor assembly and final Convex response loss create one output and one review creative", async () => {
  const t = convexTest({ schema, modules });
  const { row } = await seedVariant(t, "executor-assembly-loss-0001");
  await t.run((ctx) => ctx.db.patch(row._id, {
    stage: "assembly", runnableAt: 0,
    clipObject: storedObject("video/mp4", "assembly-clip"),
    audioObject: storedObject("audio/mpeg", "assembly-audio"),
  }));
  const counts = freshCounts();
  const finalObject = storedObject("video/mp4", "one-final-output");
  let loseCompleteResponse = true;
  const effects = effectsFor(t, counts, {
    assemble: async ({ outR2Key, aiLabelRequired }) => {
      counts.assemblyRuns++; counts.storageAttempts++; counts.storageCommits++;
      assert.equal(outR2Key, row.finalR2Key); assert.equal(aiLabelRequired, true);
      return { r2Key: outR2Key, ...finalObject, labelBurned: true, backend: "ffmpeg" };
    },
  }, async (name) => {
    if (name === "creativeGenerations:completeAssembly" && loseCompleteResponse) {
      loseCompleteResponse = false;
      throw new Error("Convex response lost after final commit");
    }
  });
  await assert.rejects(
    () => processCreativeGenerationVariant({ variantId: row._id, stage: "assembly" }, "assembly-loss-owner", effects),
    /Convex response lost after final commit/,
  );
  const replay = await processCreativeGenerationVariant({ variantId: row._id, stage: "assembly" }, "assembly-replay-owner", effects);
  const durable = await t.run((ctx) => ctx.db.get(row._id));
  const creatives = await t.run((ctx) => ctx.db.query("creatives")
    .withIndex("by_generation_variant", (q) => q.eq("generationVariantId", row._id)).collect());
  assert.deepEqual({ replay: replay.state, replayStage: replay.stage, durableStage: durable.stage,
    terminal: durable.terminal, creatives: creatives.length },
  { replay: "stale", replayStage: "review_ready", durableStage: "review_ready", terminal: true, creatives: 1 });
  assert.deepEqual({ assemblyRuns: counts.assemblyRuns, storageAttempts: counts.storageAttempts,
    storageCommits: counts.storageCommits, claims: counts.mutations["creativeGenerations:claimVariantStage"],
    completeWrites: counts.mutations["creativeGenerations:completeAssembly"] },
  { assemblyRuns: 1, storageAttempts: 1, storageCommits: 1, claims: 2, completeWrites: 1 });
});
