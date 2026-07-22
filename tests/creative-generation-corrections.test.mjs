import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import "./helpers/unref-long-convex-timers.mjs";
import { convexTest } from "convex-test";
import schemaModule from "../convex/schema.ts";
import apiModule from "../convex/_generated/api.js";
import { createGeneratePost } from "../app/api/generate/route.ts";
import { readResponseBodyBounded } from "../src/lib/boundedBody.ts";
import {
  creativeGenerationInputDigest,
  normalizeCreativeGenerationInput,
} from "../src/lib/creativeGeneration.ts";
import {
  confirmPendingCreativeRequest,
  getOrCreatePendingCreativeRequest,
} from "../src/lib/creativeRequestIdentity.ts";
import { copyFalQueueResult } from "../src/lib/gen/fal.ts";
import { copyTtsHistoryAudio } from "../src/lib/gen/tts.ts";
import {
  processCreativeGenerationVariant,
  runContentFactory,
} from "../src/trigger/content-factory.ts";

const modules = {
  "../convex/creativeGenerations.ts": () => import("../convex/creativeGenerations.ts"),
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
};
const schema = schemaModule.default ?? schemaModule;
const { api } = apiModule;
const service = (t) => t.withIdentity({ subject: "dropship-ai:service" });

async function seedIntent(t, requestId, variants = 3) {
  const siteId = await t.run((ctx) => ctx.db.insert("sites", {
    name: requestId, niche: "test", status: "active", minKitPriceUsd: 40,
    minBlendedMarginPct: 70, distributionMode: "semi_manual", createdAt: 1,
  }));
  const normalized = {
    siteId, productId: null, variants, scenePrompt: "fixture product on a table",
    hooks: ["one", "two", "three"].slice(0, variants),
  };
  const args = {
    siteId, callerRequestId: requestId, normalizedInputDigest: creativeGenerationInputDigest(normalized),
    requestedVariants: variants, scenePrompt: normalized.scenePrompt, hooks: normalized.hooks,
    imageModel: "fal-ai/flux/schnell", clipModel: "fal-ai/kling-video/v1/standard/image-to-video",
    ttsModel: "eleven_turbo_v2_5", voiceId: "voice-1",
  };
  const intent = await service(t).mutation(api.creativeGenerations.createOrReuseIntent, args);
  const rows = await t.run((ctx) => ctx.db.query("creativeGenerationVariants")
    .withIndex("by_intent_index", (q) => q.eq("intentId", intent.intentId)).collect());
  return { siteId, normalized, args, intent, rows };
}

test("explicit due cutoffs advance cached discovery without a write and claims reject caller-clock authority", async () => {
  const t = convexTest({ schema, modules });
  const seeded = await seedIntent(t, "due-cutoff-request-0001", 1);
  const early = 1_900_000_000_000;
  const late = early + 60_000;
  await t.run(async (ctx) => {
    await ctx.db.patch(seeded.intent.intentId, { handoffDueAt: late });
    await ctx.db.patch(seeded.rows[0]._id, { runnableAt: late });
  });

  assert.deepEqual(await service(t).query(api.creativeGenerations.listDueIntentHandoffs, { now: early, limit: 10 }), []);
  assert.deepEqual(await service(t).query(api.creativeGenerations.listDueVariants, { now: early, limit: 10 }), []);
  // No database write occurs between the early and later query arguments.
  assert.equal((await service(t).query(api.creativeGenerations.listDueIntentHandoffs, { now: late, limit: 10 }))[0].intentId, seeded.intent.intentId);
  assert.equal((await service(t).query(api.creativeGenerations.listDueVariants, { now: late, limit: 10 }))[0].variantId, seeded.rows[0]._id);

  assert.equal((await service(t).mutation(api.creativeGenerations.claimIntentHandoff, { intentId: seeded.intent.intentId })).state, "not_due");
  assert.equal((await service(t).mutation(api.creativeGenerations.claimVariantStage, {
    variantId: seeded.rows[0]._id, expectedStage: "image_submission", owner: "run-not-due", leaseMs: 60_000,
  })).state, "not_due");
  await assert.rejects(() => service(t).query(api.creativeGenerations.listDueVariants, { now: 1, limit: 10 }), /cutoff/);
  await assert.rejects(() => service(t).mutation(api.creativeGenerations.claimVariantStage, {
    variantId: seeded.rows[0]._id, expectedStage: "image_submission", owner: "x".repeat(201), leaseMs: 60_000,
  }), /owner/);
  await assert.rejects(() => service(t).mutation(api.creativeGenerations.claimVariantStage, {
    variantId: seeded.rows[0]._id, expectedStage: "image_submission", owner: "run-valid", leaseMs: 999,
  }), /lease duration/);

  const source = await fs.readFile(new URL("../convex/creativeGenerations.ts", import.meta.url), "utf8");
  for (const [name, next] of [["listDueIntentHandoffs", "listDueVariants"], ["listDueVariants", "listDueVariantsForIntent"]]) {
    const body = source.slice(source.indexOf(`export const ${name}`), source.indexOf(`export const ${next}`));
    assert.equal(body.includes("Date.now()"), false, `${name} must use only its explicit cutoff`);
  }
});

test("generate route preserves one intent and one Trigger submission across loss, busy replay, and dispatched replay", async () => {
  const t = convexTest({ schema, modules });
  const siteId = await t.run((ctx) => ctx.db.insert("sites", {
    name: "route fixture", niche: "test", status: "active", minKitPriceUsd: 40,
    minBlendedMarginPct: 70, distributionMode: "semi_manual", createdAt: 1,
  }));
  const normalized = normalizeCreativeGenerationInput({ siteId, variants: 3 });
  const body = {
    ...normalized, requestId: "route-replay-request-0001",
    inputDigest: creativeGenerationInputDigest(normalized),
  };
  let triggerCalls = 0;
  const handler = createGeneratePost({
    authorize: async () => ({ ok: true }),
    getConvex: () => service(t),
    triggerConfigured: () => true,
    trigger: async () => { triggerCalls++; throw new Error("Trigger response lost after acceptance"); },
  });
  const request = () => new Request("https://fixture.example/api/generate", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  const lost = await handler(request()).then((r) => r.json());
  assert.deepEqual({ state: lost.state, queued: lost.queued, runId: lost.runId }, { state: "deferred", queued: false, runId: undefined });
  const busy = await handler(request()).then((r) => r.json());
  assert.deepEqual({ state: busy.state, queued: busy.queued, runId: busy.runId }, { state: "in_flight", queued: false, runId: undefined });
  assert.equal(triggerCalls, 1);

  const intent = await t.run((ctx) => ctx.db.query("creativeGenerationIntents").withIndex("by_request_id", (q) => q.eq("callerRequestId", body.requestId)).unique());
  await service(t).mutation(api.creativeGenerations.recordIntentHandoff, {
    intentId: intent._id, generation: intent.handoffGeneration, triggerRunId: "run_known_0001",
  });
  const dispatched = await handler(request()).then((r) => r.json());
  assert.deepEqual({ state: dispatched.state, queued: dispatched.queued, runId: dispatched.runId }, { state: "queued", queued: true, runId: "run_known_0001" });
  assert.equal(triggerCalls, 1);
  assert.equal(await t.run((ctx) => ctx.db.query("creativeGenerationIntents").collect().then((rows) => rows.length)), 1);
});

test("browser request identity survives reload, changes only with facts, and fails closed on malformed storage", () => {
  class MemoryStorage {
    values = new Map();
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
    setItem(key, value) { this.values.set(key, value); }
    removeItem(key) { this.values.delete(key); }
  }
  const storage = new MemoryStorage();
  const input = normalizeCreativeGenerationInput({ siteId: "site-browser-0001", variants: 3 });
  let generated = 0;
  const first = getOrCreatePendingCreativeRequest(storage, input, () => `request-reload-${++generated}-0000`);
  const afterReload = getOrCreatePendingCreativeRequest(storage, input, () => `request-reload-${++generated}-0000`);
  assert.equal(afterReload.requestId, first.requestId);
  assert.equal(generated, 1);

  const changed = normalizeCreativeGenerationInput({ siteId: input.siteId, variants: 2 });
  const replacement = getOrCreatePendingCreativeRequest(storage, changed, () => `request-reload-${++generated}-0000`);
  assert.notEqual(replacement.requestId, first.requestId);
  const otherSite = normalizeCreativeGenerationInput({ siteId: "site-browser-0002", variants: 3 });
  assert.notEqual(getOrCreatePendingCreativeRequest(storage, otherSite, () => `request-reload-${++generated}-0000`).requestId, replacement.requestId);

  confirmPendingCreativeRequest(storage, { ...replacement, requestId: "different-request-0000" });
  assert.equal(getOrCreatePendingCreativeRequest(storage, changed, () => "must-not-run-0000").requestId, replacement.requestId);
  confirmPendingCreativeRequest(storage, replacement);
  assert.notEqual(getOrCreatePendingCreativeRequest(storage, changed, () => "confirmed-new-request-0000").requestId, replacement.requestId);

  const malformedSite = "site-browser-malformed";
  storage.setItem(`dropship-ai:creative-generation:pending:${encodeURIComponent(malformedSite)}`, "{bad-json");
  assert.throws(() => getOrCreatePendingCreativeRequest(storage, normalizeCreativeGenerationInput({ siteId: malformedSite }), () => "unsafe-new-request-0000"), /not submitted/);
});

test("successful cross-stage mutations reset failure budgets while same-stage failures stay bounded", async () => {
  const t = convexTest({ schema, modules });
  const { rows } = await seedIntent(t, "stage-budget-request-0001", 1);
  const variantId = rows[0]._id;
  await t.run((ctx) => ctx.db.patch(variantId, { failureCount: 2, lastErrorCode: "old_stage_error" }));
  let claim = await service(t).mutation(api.creativeGenerations.claimVariantStage, { variantId, expectedStage: "image_submission", owner: "stage-submit", leaseMs: 60_000 });
  await service(t).mutation(api.creativeGenerations.beginProviderSubmission, { variantId, expectedStage: "image_submission", leaseGeneration: claim.leaseGeneration });
  const requestId = "request-00000001";
  const root = `https://queue.fal.run/fal-ai/flux/schnell/requests/${requestId}`;
  await service(t).mutation(api.creativeGenerations.recordFalSubmission, {
    variantId, kind: "image", leaseGeneration: claim.leaseGeneration, requestId, model: "fal-ai/flux/schnell",
    statusUrl: `${root}/status`, resultUrl: `${root}/response`,
  });
  let row = await t.run((ctx) => ctx.db.get(variantId));
  assert.deepEqual({ stage: row.stage, failures: row.failureCount, error: row.lastErrorCode }, { stage: "image_polling", failures: 0, error: undefined });

  for (let attempt = 1; attempt <= 3; attempt++) {
    await t.run((ctx) => ctx.db.patch(variantId, { runnableAt: 0, leaseExpiresAt: undefined }));
    claim = await service(t).mutation(api.creativeGenerations.claimVariantStage, { variantId, expectedStage: "image_polling", owner: `poll-retry-${attempt}`, leaseMs: 60_000 });
    const failure = await service(t).mutation(api.creativeGenerations.recordVariantFailure, {
      variantId, expectedStage: "image_polling", leaseGeneration: claim.leaseGeneration,
      kind: "retryable_safe", errorCode: "poll_transport_error",
    });
    assert.equal(failure.failureCount, attempt);
  }
  row = await t.run((ctx) => ctx.db.get(variantId));
  assert.equal(row.stage, "failed");

  await t.run((ctx) => ctx.db.patch(variantId, {
    stage: "image_polling", terminal: false, failureCount: 2, lastErrorCode: "stale_poll_error",
    runnableAt: 0, leaseOwner: undefined, leaseExpiresAt: undefined, completedAt: undefined,
  }));
  claim = await service(t).mutation(api.creativeGenerations.claimVariantStage, { variantId, expectedStage: "image_polling", owner: "poll-completed", leaseMs: 60_000 });
  await service(t).mutation(api.creativeGenerations.recordFalPoll, { variantId, kind: "image", leaseGeneration: claim.leaseGeneration, requestId, status: "COMPLETED" });
  row = await t.run((ctx) => ctx.db.get(variantId));
  assert.deepEqual({ stage: row.stage, failures: row.failureCount, error: row.lastErrorCode }, { stage: "image_result_copy", failures: 0, error: undefined });

  await t.run((ctx) => ctx.db.patch(variantId, { failureCount: 2, lastErrorCode: "stale_result_copy_error", runnableAt: 0 }));
  claim = await service(t).mutation(api.creativeGenerations.claimVariantStage, { variantId, expectedStage: "image_result_copy", owner: "result-copy", leaseMs: 60_000 });
  await service(t).mutation(api.creativeGenerations.recordFalObjectCopy, {
    variantId, kind: "image", leaseGeneration: claim.leaseGeneration, requestId,
    object: { contentType: "image/jpeg", bytes: 4, sha256: "a".repeat(64) },
  });
  row = await t.run((ctx) => ctx.db.get(variantId));
  assert.deepEqual({ stage: row.stage, failures: row.failureCount, error: row.lastErrorCode }, { stage: "clip_submission", failures: 0, error: undefined });

  await t.run((ctx) => ctx.db.patch(variantId, {
    stage: "tts_reservation", failureCount: 2, lastErrorCode: "stale_copy_error", runnableAt: 0,
    leaseOwner: undefined, leaseExpiresAt: undefined, submissionStartedStage: undefined,
  }));
  claim = await service(t).mutation(api.creativeGenerations.claimVariantStage, { variantId, expectedStage: "tts_reservation", owner: "tts-submit", leaseMs: 60_000 });
  await service(t).mutation(api.creativeGenerations.beginProviderSubmission, { variantId, expectedStage: "tts_reservation", leaseGeneration: claim.leaseGeneration });
  await service(t).mutation(api.creativeGenerations.recordTtsReceipt, {
    variantId, leaseGeneration: claim.leaseGeneration, requestId: "tts_request_0001", voiceId: "voice-1",
    model: "eleven_turbo_v2_5", textDigest: row.ttsTextDigest, characterCount: row.hook.length,
  });
  row = await t.run((ctx) => ctx.db.get(variantId));
  assert.deepEqual({ stage: row.stage, failures: row.failureCount, error: row.lastErrorCode }, { stage: "tts_receipt", failures: 0, error: undefined });
  await t.run((ctx) => ctx.db.patch(variantId, { failureCount: 2, lastErrorCode: "stale_history_error", runnableAt: 0 }));
  claim = await service(t).mutation(api.creativeGenerations.claimVariantStage, { variantId, expectedStage: "tts_receipt", owner: "tts-history", leaseMs: 60_000 });
  await service(t).mutation(api.creativeGenerations.recordTtsHistoryItem, {
    variantId, leaseGeneration: claim.leaseGeneration, requestId: "tts_request_0001", historyItemId: "history_item_0001",
  });
  row = await t.run((ctx) => ctx.db.get(variantId));
  assert.deepEqual({ stage: row.stage, failures: row.failureCount, error: row.lastErrorCode }, { stage: "tts_audio_copy", failures: 0, error: undefined });
});

function oversizedMediaStream(maxBytes, onCancel) {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent === 0) {
        const first = new Uint8Array(maxBytes);
        first.set([0xff, 0xd8, 0xff]);
        controller.enqueue(first);
        sent++;
      } else {
        controller.enqueue(new Uint8Array([1]));
      }
    },
    cancel() { onCancel(); },
  });
}

test("bounded readers accept exact bodies and reject chunked Fal/ElevenLabs overflow before any writer", async () => {
  assert.deepEqual(await readResponseBodyBounded(new Response(new Uint8Array([1, 2, 3, 4]), {
    headers: { "content-length": "4" },
  }), 4), Buffer.from([1, 2, 3, 4]));
  await assert.rejects(() => readResponseBodyBounded(new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-length": "3" },
  }), 2), /exceeds/);

  const imageLimit = 20 * 1024 * 1024;
  let falWrites = 0; let falCancelled = 0;
  const receipt = {
    requestId: "request-00000002", model: "fal-ai/flux/schnell",
    statusUrl: "https://queue.fal.run/fal-ai/flux/schnell/requests/request-00000002/status",
    resultUrl: "https://queue.fal.run/fal-ai/flux/schnell/requests/request-00000002/response",
  };
  await assert.rejects(() => copyFalQueueResult({
    kind: "image", receipt, apiKey: "fixture", r2Key: "creatives/generations/intent/v0/image.jpg",
    fetchImpl: async (url) => url === receipt.resultUrl
      ? Response.json({ images: [{ url: "https://fal.media/files/fixture/image.jpg" }] })
      : new Response(oversizedMediaStream(imageLimit, () => falCancelled++), { headers: { "content-type": "image/jpeg" } }),
    putObject: async () => { falWrites++; throw new Error("writer must not run"); },
  }), /exceeds/);
  assert.deepEqual({ falWrites, falCancelled }, { falWrites: 0, falCancelled: 1 });

  let ttsWrites = 0; let ttsCancelled = 0;
  await assert.rejects(() => copyTtsHistoryAudio({
    historyItemId: "history_item_oversized", apiKey: "fixture", r2Key: "creatives/generations/intent/v0/voice.mp3",
    fetchImpl: async () => new Response(oversizedMediaStream(imageLimit, () => ttsCancelled++), { headers: { "content-type": "audio/mpeg" } }),
    putObject: async () => { ttsWrites++; throw new Error("writer must not run"); },
  }), /exceeds/);
  assert.deepEqual({ ttsWrites, ttsCancelled }, { ttsWrites: 0, ttsCancelled: 1 });

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  let normalWrites = 0;
  const normal = await copyFalQueueResult({
    kind: "image", receipt, apiKey: "fixture", r2Key: "creatives/generations/intent/v0/image.jpg",
    fetchImpl: async (url) => url === receipt.resultUrl
      ? Response.json({ images: [{ url: "https://fal.media/files/fixture/image.jpg" }] })
      : new Response(jpeg, { headers: { "content-type": "image/jpeg" } }),
    putObject: async (key, body, contentType) => {
      normalWrites++;
      return { key, contentType, bytes: body.byteLength, sha256: createHash("sha256").update(body).digest("hex"), reused: false };
    },
  });
  assert.equal(normal.bytes, jpeg.byteLength);
  assert.equal(normalWrites, 1);
});

test("TTS executor cancels the initial body after its durable receipt and never bills twice", async () => {
  let providerSubmissions = 0; let arrayBufferCalls = 0; let cancels = 0; let durableStage = "tts_reservation";
  const body = oversizedMediaStream(20 * 1024 * 1024, () => cancels++);
  const response = new Response(body, { headers: { "content-type": "audio/mpeg" } });
  response.arrayBuffer = async () => { arrayBufferCalls++; throw new Error("must not buffer initial TTS audio"); };
  const row = {
    _id: "variant_tts_0001", stage: "tts_reservation", leaseGeneration: 1, hook: "hello",
    voiceId: "voice-1", ttsModel: "eleven_turbo_v2_5", ttsTextDigest: createHash("sha256").update("hello").digest("hex"),
  };
  const mutations = [];
  const convex = {
    mutation: async (_reference, args) => {
      mutations.push(args);
      if ("owner" in args) {
        return durableStage === "tts_reservation"
          ? { state: "claimed", leaseGeneration: 2, variant: row }
          : { state: "stale", stage: durableStage };
      }
      if ("requestId" in args && "voiceId" in args) durableStage = "tts_receipt";
      return { stage: durableStage };
    },
  };
  const overrides = {
    convex,
    getElevenLabsApiKey: async () => "fixture",
    openElevenLabsTts: async () => {
      providerSubmissions++;
      return {
        receipt: { requestId: "tts_request_0002", voiceId: row.voiceId, model: row.ttsModel, textDigest: row.ttsTextDigest, characterCount: row.hook.length },
        response,
      };
    },
  };
  assert.equal((await processCreativeGenerationVariant({ variantId: row._id, stage: "tts_reservation" }, "run_tts_0001", overrides)).stage, "tts_receipt");
  assert.deepEqual({ providerSubmissions, arrayBufferCalls, cancels }, { providerSubmissions: 1, arrayBufferCalls: 0, cancels: 1 });
  assert.equal(mutations.some((args) => "object" in args), false, "the initial response cannot reach a storage receipt");
  assert.equal((await processCreativeGenerationVariant({ variantId: row._id, stage: "tts_reservation" }, "run_tts_0002", overrides)).state, "stale");
  assert.equal(providerSubmissions, 1);
});

test("immediate content handoff dispatches only the accepted intent despite older unrelated due work", async () => {
  const t = convexTest({ schema, modules });
  const older = await seedIntent(t, "intent-scope-request-old", 3);
  const target = await seedIntent(t, "intent-scope-request-new", 2);
  const now = Date.now();
  await t.run(async (ctx) => {
    for (const row of older.rows) await ctx.db.patch(row._id, { runnableAt: now - 60_000 });
    for (const row of target.rows) await ctx.db.patch(row._id, { runnableAt: now - 1_000 });
  });
  const triggered = [];
  const result = await runContentFactory({ intentId: target.intent.intentId }, {
    convex: service(t), now,
    trigger: async (_task, payload) => { triggered.push(payload.variantId); return { id: `run_${triggered.length}` }; },
  });
  assert.equal(result.dispatchedVariants, 2);
  assert.deepEqual(new Set(triggered), new Set(target.rows.map((row) => row._id)));
  assert.equal(triggered.some((id) => older.rows.some((row) => row._id === id)), false);
  await assert.rejects(() => runContentFactory({ intentId: "bad/intent" }, { convex: service(t), now, trigger: async () => ({ id: "never" }) }), /identity/);
});
