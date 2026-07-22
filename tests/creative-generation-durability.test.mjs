import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import "./helpers/unref-long-convex-timers.mjs";
import { convexTest } from "convex-test";
import schemaModule from "../convex/schema.ts";
import apiModule from "../convex/_generated/api.js";
import { creativeGenerationInputDigest, generationHandoffKey } from "../src/lib/creativeGeneration.ts";
import {
  copyFalQueueResult, FalSubmissionAmbiguousError, readFalQueueStatus, submitFalQueue,
} from "../src/lib/gen/fal.ts";
import {
  copyTtsHistoryAudio, findUniqueTtsHistoryItem, openElevenLabsTts, TtsSubmissionAmbiguousError,
} from "../src/lib/gen/tts.ts";

const modules = {
  "../convex/creativeGenerations.ts": () => import("../convex/creativeGenerations.ts"),
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
};
const schema = schemaModule.default ?? schemaModule;
const { api } = apiModule;
const service = (t) => t.withIdentity({ subject: "dropship-ai:service" });
const operator = (t) => t.withIdentity({ subject: "dropship-ai:operator" });
const object = (contentType, fill) => ({ contentType, bytes: 100, sha256: fill.repeat(64) });

async function seedIntent(t, requestId = "generation-request-0001") {
  const siteId = await t.run((ctx) => ctx.db.insert("sites", { name: requestId, niche: "test", status: "active", minKitPriceUsd: 40, minBlendedMarginPct: 70, distributionMode: "semi_manual", createdAt: 1 }));
  const normalized = { siteId, productId: null, variants: 3, scenePrompt: "product on a table", hooks: ["one", "two", "three"] };
  const args = {
    siteId, callerRequestId: requestId, normalizedInputDigest: creativeGenerationInputDigest(normalized),
    requestedVariants: 3, scenePrompt: normalized.scenePrompt, hooks: normalized.hooks,
    imageModel: "fal-ai/flux/schnell", clipModel: "fal-ai/kling-video/v1/standard/image-to-video",
    ttsModel: "eleven_turbo_v2_5", voiceId: "voice-1",
  };
  const intent = await service(t).mutation(api.creativeGenerations.createOrReuseIntent, args);
  const variants = await t.run((ctx) => ctx.db.query("creativeGenerationVariants").withIndex("by_intent_index", (q) => q.eq("intentId", intent.intentId)).collect());
  return { siteId, args, intent, variants };
}

async function claim(t, variantId, expectedStage, owner) {
  return service(t).mutation(api.creativeGenerations.claimVariantStage, { variantId, expectedStage, owner, leaseMs: 60_000 });
}

test("intake commit precedes a reclaimable deterministic Trigger handoff and changed request facts fail closed", async () => {
  const t = convexTest({ schema, modules });
  const seeded = await seedIntent(t);
  assert.equal(seeded.variants.length, 3, "all children must exist in the intake transaction");
  assert.deepEqual(seeded.variants.map((row) => row.stage), ["image_submission", "image_submission", "image_submission"]);
  const first = await service(t).mutation(api.creativeGenerations.claimIntentHandoff, { intentId: seeded.intent.intentId });
  assert.equal(first.state, "dispatch");
  const lostResponseReplay = await service(t).mutation(api.creativeGenerations.claimIntentHandoff, { intentId: seeded.intent.intentId });
  assert.equal(lostResponseReplay.state, "busy");
  await t.run((ctx) => ctx.db.patch(seeded.intent.intentId, { handoffLeaseExpiresAt: 0, handoffDueAt: 0 }));
  const reclaimed = await service(t).mutation(api.creativeGenerations.claimIntentHandoff, { intentId: seeded.intent.intentId });
  assert.equal(generationHandoffKey(seeded.intent.intentId, reclaimed.generation), generationHandoffKey(seeded.intent.intentId, first.generation));
  await service(t).mutation(api.creativeGenerations.recordIntentHandoff, { intentId: seeded.intent.intentId, generation: reclaimed.generation, triggerRunId: "run-one" });
  assert.equal((await service(t).mutation(api.creativeGenerations.createOrReuseIntent, seeded.args)).intentId, seeded.intent.intentId);
  await assert.rejects(() => service(t).mutation(api.creativeGenerations.createOrReuseIntent, { ...seeded.args, imageModel: "fal-ai/flux/dev" }), /different immutable input/);
  await assert.rejects(() => service(t).mutation(api.creativeGenerations.createOrReuseIntent, { ...seeded.args, normalizedInputDigest: "f".repeat(64), scenePrompt: "changed" }), /digest|different immutable input/);
});

test("concurrent variant claims have one owner; fal submit loss needs attention while a captured request resumes by polling", async () => {
  const t = convexTest({ schema, modules });
  const { variants } = await seedIntent(t, "generation-request-0002");
  const races = await Promise.all([claim(t, variants[0]._id, "image_submission", "run-a"), claim(t, variants[0]._id, "image_submission", "run-b")]);
  assert.deepEqual(races.map((row) => row.state).sort(), ["busy", "claimed"]);
  const winner = races.find((row) => row.state === "claimed");
  await service(t).mutation(api.creativeGenerations.beginProviderSubmission, { variantId: variants[0]._id, expectedStage: "image_submission", leaseGeneration: winner.leaseGeneration });
  await t.run((ctx) => ctx.db.patch(variants[0]._id, { leaseExpiresAt: 0, runnableAt: 0 }));
  assert.equal((await claim(t, variants[0]._id, "image_submission", "restart")).state, "needs_attention", "a lost fal submit receipt must never submit again");

  const second = await claim(t, variants[1]._id, "image_submission", "submitter");
  await service(t).mutation(api.creativeGenerations.beginProviderSubmission, { variantId: variants[1]._id, expectedStage: "image_submission", leaseGeneration: second.leaseGeneration });
  const requestId = "req-00000001";
  const root = `https://queue.fal.run/fal-ai/flux/schnell/requests/${requestId}`;
  await service(t).mutation(api.creativeGenerations.recordFalSubmission, { variantId: variants[1]._id, kind: "image", leaseGeneration: second.leaseGeneration, requestId, model: "fal-ai/flux/schnell", statusUrl: `${root}/status`, resultUrl: `${root}/response` });
  const restarted = await claim(t, variants[1]._id, "image_polling", "different-process");
  assert.equal(restarted.state, "claimed");
  await service(t).mutation(api.creativeGenerations.recordFalPoll, { variantId: variants[1]._id, kind: "image", leaseGeneration: restarted.leaseGeneration, requestId, status: "COMPLETED" });
  assert.equal((await t.run((ctx) => ctx.db.get(variants[1]._id))).stage, "image_result_copy");
});

test("queue completion plus R2 response loss reuses the object, and ElevenLabs header/body boundaries never rebill", async () => {
  const falReceipt = {
    requestId: "req-00000002", model: "fal-ai/flux/schnell",
    statusUrl: "https://queue.fal.run/fal-ai/flux/schnell/requests/req-00000002/status",
    resultUrl: "https://queue.fal.run/fal-ai/flux/schnell/requests/req-00000002/response",
  };
  let providerSubmits = 0;
  await assert.rejects(() => submitFalQueue({ model: falReceipt.model, input: { prompt: "fixture" }, apiKey: "fixture", fetchImpl: async () => { providerSubmits++; throw new Error("response lost"); } }), FalSubmissionAmbiguousError);
  assert.equal(providerSubmits, 1);
  const status = await readFalQueueStatus({ receipt: falReceipt, apiKey: "fixture", fetchImpl: async () => Response.json({ request_id: falReceipt.requestId, status: "COMPLETED" }) });
  assert.deepEqual(status, { status: "COMPLETED", failed: false });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const stored = new Map(); let losePutResponse = true;
  const putObject = async (key, body, contentType) => {
    const sha256 = createHash("sha256").update(body).digest("hex");
    const prior = stored.get(key);
    if (prior && (prior.sha256 !== sha256 || prior.contentType !== contentType)) throw new Error("conflict");
    const receipt = { key, contentType, bytes: body.byteLength, sha256, reused: !!prior };
    stored.set(key, receipt);
    if (losePutResponse) { losePutResponse = false; throw new Error("R2 response lost after commit"); }
    return receipt;
  };
  const falFetch = async (url) => url === falReceipt.resultUrl
    ? Response.json({ images: [{ url: "https://v3.fal.media/files/fixture/image.jpg" }] })
    : new Response(jpeg, { headers: { "content-type": "image/jpeg" } });
  await assert.rejects(() => copyFalQueueResult({ kind: "image", receipt: falReceipt, apiKey: "fixture", r2Key: "creatives/generations/intent/v0/image.jpg", fetchImpl: falFetch, putObject }), /response lost/);
  const replay = await copyFalQueueResult({ kind: "image", receipt: falReceipt, apiKey: "fixture", r2Key: "creatives/generations/intent/v0/image.jpg", fetchImpl: falFetch, putObject });
  assert.equal(replay.reused, true);

  const erroredBody = new ReadableStream({ start(controller) { controller.error(new Error("body lost")); } });
  const opened = await openElevenLabsTts({ text: "hello", voiceId: "voice-1", model: "model-1", apiKey: "fixture", fetchImpl: async () => new Response(erroredBody, { status: 200, headers: { "content-type": "audio/mpeg", "request-id": "tts-request-1", "character-cost": "5" } }) });
  assert.equal(opened.receipt.requestId, "tts-request-1", "headers are a receipt before body consumption");
  await assert.rejects(() => opened.response.arrayBuffer(), /body lost/);
  await assert.rejects(() => openElevenLabsTts({ text: "hello", voiceId: "voice-1", model: "model-1", apiKey: "fixture", fetchImpl: async () => { throw new Error("lost before headers"); } }), TtsSubmissionAmbiguousError);
});

test("TTS restart uses one exact history item and audio copy; missing headers become terminal attention", async () => {
  const t = convexTest({ schema, modules });
  const { variants } = await seedIntent(t, "generation-request-0003");
  await t.run(async (ctx) => {
    await ctx.db.patch(variants[0]._id, { stage: "tts_reservation", runnableAt: 0, imageObject: object("image/jpeg", "a"), clipObject: object("video/mp4", "b") });
    await ctx.db.patch(variants[1]._id, { stage: "tts_reservation", runnableAt: 0, imageObject: object("image/jpeg", "a"), clipObject: object("video/mp4", "b") });
  });
  const headers = await claim(t, variants[0]._id, "tts_reservation", "tts-headers");
  await service(t).mutation(api.creativeGenerations.beginProviderSubmission, { variantId: variants[0]._id, expectedStage: "tts_reservation", leaseGeneration: headers.leaseGeneration });
  await service(t).mutation(api.creativeGenerations.recordTtsReceipt, { variantId: variants[0]._id, leaseGeneration: headers.leaseGeneration, requestId: "tts-request-2", voiceId: "voice-1", model: "eleven_turbo_v2_5", textDigest: variants[0].ttsTextDigest, characterCost: 3, characterCount: variants[0].hook.length });
  const historyClaim = await claim(t, variants[0]._id, "tts_receipt", "tts-restart");
  await service(t).mutation(api.creativeGenerations.recordTtsHistoryItem, { variantId: variants[0]._id, leaseGeneration: historyClaim.leaseGeneration, requestId: "tts-request-2", historyItemId: "history-2" });
  const audioClaim = await claim(t, variants[0]._id, "tts_audio_copy", "audio-restart");
  await service(t).mutation(api.creativeGenerations.recordTtsObjectCopy, { variantId: variants[0]._id, leaseGeneration: audioClaim.leaseGeneration, requestId: "tts-request-2", historyItemId: "history-2", object: object("audio/mpeg", "c") });
  assert.equal((await t.run((ctx) => ctx.db.get(variants[0]._id))).stage, "assembly");

  const beforeHeaders = await claim(t, variants[1]._id, "tts_reservation", "tts-no-headers");
  await service(t).mutation(api.creativeGenerations.beginProviderSubmission, { variantId: variants[1]._id, expectedStage: "tts_reservation", leaseGeneration: beforeHeaders.leaseGeneration });
  await t.run((ctx) => ctx.db.patch(variants[1]._id, { leaseExpiresAt: 0, runnableAt: 0 }));
  assert.equal((await claim(t, variants[1]._id, "tts_reservation", "tts-no-header-restart")).state, "needs_attention");

  const text = "hello history";
  const receipt = { requestId: "tts-history-request", voiceId: "voice-1", model: "model-1", textDigest: createHash("sha256").update(text).digest("hex"), characterCount: text.length };
  const historyItemId = await findUniqueTtsHistoryItem({ receipt, text, createdAt: Date.now(), apiKey: "fixture", fetchImpl: async () => Response.json({ history: [{ history_item_id: "history-exact", request_id: receipt.requestId, voice_id: receipt.voiceId, model_id: receipt.model, text, source: "TTS" }] }) });
  assert.equal(historyItemId, "history-exact");
  const mp3 = Buffer.from("ID3fixture");
  const copied = await copyTtsHistoryAudio({ historyItemId, apiKey: "fixture", r2Key: "creatives/generations/intent/v0/voice.mp3", fetchImpl: async () => new Response(mp3, { headers: { "content-type": "audio/mpeg" } }), putObject: async (key, body, contentType) => ({ key, contentType, bytes: body.byteLength, sha256: createHash("sha256").update(body).digest("hex"), reused: false }) });
  assert.equal(copied.contentType, "audio/mpeg");
});

test("assembly response loss and duplicate final write converge once; mixed outcomes remain visibly non-successful", async () => {
  const t = convexTest({ schema, modules });
  const { intent, variants } = await seedIntent(t, "generation-request-0004");
  await t.run((ctx) => ctx.db.patch(variants[0]._id, { stage: "assembly", runnableAt: 0, clipObject: object("video/mp4", "b"), audioObject: object("audio/mpeg", "c") }));
  const firstAssembly = await claim(t, variants[0]._id, "assembly", "assembler-lost-response");
  // The deterministic R2 PUT committed, but its process response was lost before Convex completion.
  await t.run((ctx) => ctx.db.patch(variants[0]._id, { leaseExpiresAt: 0, runnableAt: 0 }));
  const replayAssembly = await claim(t, variants[0]._id, "assembly", "assembler-replay");
  const finalObject = object("video/mp4", "d");
  const completed = await service(t).mutation(api.creativeGenerations.completeAssembly, { variantId: variants[0]._id, leaseGeneration: replayAssembly.leaseGeneration, object: finalObject, labelBurned: true });
  const duplicate = await service(t).mutation(api.creativeGenerations.completeAssembly, { variantId: variants[0]._id, leaseGeneration: replayAssembly.leaseGeneration, object: finalObject, labelBurned: true });
  assert.equal(duplicate.creativeId, completed.creativeId);
  assert.equal(await t.run((ctx) => ctx.db.query("creatives").withIndex("by_generation_variant", (q) => q.eq("generationVariantId", variants[0]._id)).collect().then((rows) => rows.length)), 1);

  const failed = await claim(t, variants[1]._id, "image_submission", "known-pre-submit-failure");
  await service(t).mutation(api.creativeGenerations.recordVariantFailure, { variantId: variants[1]._id, expectedStage: "image_submission", leaseGeneration: failed.leaseGeneration, kind: "definitive", errorCode: "configuration_rejected" });
  const ambiguous = await claim(t, variants[2]._id, "image_submission", "ambiguous-submit");
  await service(t).mutation(api.creativeGenerations.beginProviderSubmission, { variantId: variants[2]._id, expectedStage: "image_submission", leaseGeneration: ambiguous.leaseGeneration });
  await service(t).mutation(api.creativeGenerations.recordVariantFailure, { variantId: variants[2]._id, expectedStage: "image_submission", leaseGeneration: ambiguous.leaseGeneration, kind: "ambiguous", errorCode: "fal_submission_receipt_ambiguous" });
  const projection = (await operator(t).query(api.creativeGenerations.listOperatorProjection, { siteId: variants[0].siteId, limit: 10 }))[0];
  assert.deepEqual({ requested: projection.requested, ready: projection.ready, failed: projection.failed, attention: projection.needsAttention, status: projection.status }, { requested: 3, ready: 1, failed: 1, attention: 1, status: "needs_attention" });
  assert.equal(JSON.stringify(projection).includes("product on a table"), false, "operator projection and public payloads omit prompts");
  const retried = await operator(t).mutation(api.creativeGenerations.retryFailedVariant, { variantId: variants[1]._id });
  assert.equal(retried.stage, "image_submission");
  await assert.rejects(() => operator(t).mutation(api.creativeGenerations.retryFailedVariant, { variantId: variants[2]._id }), /proven pre-submission/);
  assert.equal(firstAssembly.state, "claimed");
});

test("source contract has every durable stage, queue-only fal, bounded sweeps, and ID-only Trigger payloads", async () => {
  const [schemaSource, triggerSource, falSource, routeSource, migration] = await Promise.all([
    fs.readFile(new URL("../convex/schema.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/trigger/content-factory.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/lib/gen/fal.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../app/api/generate/route.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../docs/migrations/20260722-durable-creative-generation.md", import.meta.url), "utf8"),
  ]);
  for (const stage of ["image_submission", "image_polling", "image_result_copy", "clip_submission", "clip_polling", "clip_result_copy", "tts_reservation", "tts_receipt", "tts_audio_copy", "assembly", "review_ready", "failed", "needs_attention"]) {
    assert.equal(schemaSource.includes(`\"${stage}\"`), true, `${stage} must be durable`);
  }
  assert.equal(falSource.includes("https://fal.run"), false);
  assert.equal(falSource.includes("https://queue.fal.run"), true);
  assert.equal(triggerSource.includes("for (let i = 0; i < K"), false, "the sequential variant loop must stay deleted");
  assert.match(triggerSource, /listDueVariants, \{ limit, now:/);
  assert.match(triggerSource, /listDueVariantsForIntent/);
  assert.match(triggerSource, /\{ variantId: row\.variantId, stage: row\.stage \}/);
  assert.equal(/tasks\.trigger[^\n]+(?:prompt|hook|credential|apiKey)/i.test(triggerSource), false);
  for (const required of ["requestId", "inputDigest", "normalizeCreativeGenerationInput", "claimIntentHandoff", "idempotencyKey"]) assert.equal(routeSource.includes(required), true);
  assert.match(migration, /zero-retention mode.*incompatible/is);
});
