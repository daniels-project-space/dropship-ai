import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createGeneratePost } from "../app/api/generate/route.ts";
import { presentCreativeGenerationSuccess } from "../src/lib/creativeGenerationPresentation.ts";
import {
  FAL_RESULT_METADATA_MAX_BYTES, FAL_STATUS_METADATA_MAX_BYTES, FAL_SUBMIT_METADATA_MAX_BYTES,
  FalSubmissionAmbiguousError, copyFalQueueResult, readFalQueueStatus, submitFalQueue,
} from "../src/lib/gen/fal.ts";
import {
  ELEVEN_HISTORY_MAX_PAGES, ELEVEN_HISTORY_PAGE_MAX_BYTES, findUniqueTtsHistoryItem,
} from "../src/lib/gen/tts.ts";

function overflowStream(maxBytes, onCancel = () => undefined) {
  let emitted = false;
  return new ReadableStream({
    pull(controller) {
      if (!emitted) { emitted = true; controller.enqueue(new Uint8Array(maxBytes)); }
      else controller.enqueue(new Uint8Array([0x20]));
    },
    cancel() { onCancel(); },
  });
}

function exactHistoryItem(receipt, text, id = "history-exact") {
  return { history_item_id: id, request_id: receipt.requestId, voice_id: receipt.voiceId,
    model_id: receipt.model, text, source: "TTS", date_unix: 2_000_000_000 };
}

test("chunked generation request overflow returns 413 before Convex or Trigger work", async () => {
  let authorizations = 0; let bodyCancelled = 0; let convexClients = 0; let triggers = 0;
  const handler = createGeneratePost({
    authorize: async () => { authorizations++; return { ok: true }; },
    getConvex: () => { convexClients++; throw new Error("durable work must not start"); },
    trigger: async () => { triggers++; throw new Error("provider work must not start"); },
    triggerConfigured: () => true,
  });
  const request = new Request("https://fixture.example/api/generate", {
    method: "POST", headers: { "content-type": "application/json" },
    body: overflowStream(16 * 1024, () => bodyCancelled++), duplex: "half",
  });
  const response = await handler(request);
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "request body is too large" });
  assert.deepEqual({ authorizations, bodyCancelled, convexClients, triggers },
    { authorizations: 1, bodyCancelled: 1, convexClients: 0, triggers: 0 });
});

test("successful UI states are distinct and unknown success never claims queue acceptance", () => {
  assert.equal(presentCreativeGenerationSuccess("intent-1234567890", "queued"), "Batch intent-12345 queued");
  assert.equal(presentCreativeGenerationSuccess("intent-1234567890", "in_flight"), "Batch intent-12345 saved · handoff in flight");
  assert.equal(presentCreativeGenerationSuccess("intent-1234567890", "deferred"), "Batch intent-12345 saved · handoff deferred");
  const unknown = presentCreativeGenerationSuccess("intent-1234567890", "accepted-ish");
  assert.equal(unknown, "Batch intent-12345 saved · handoff status unavailable");
  assert.equal(unknown.includes("queued"), false);
});

test("Fal submit/status/result metadata are independently stream-bounded", async () => {
  let submitCancelled = 0;
  await assert.rejects(() => submitFalQueue({
    model: "fal-ai/flux/schnell", input: { prompt: "fixture" }, apiKey: "fixture",
    fetchImpl: async () => new Response(overflowStream(FAL_SUBMIT_METADATA_MAX_BYTES, () => submitCancelled++), { status: 200 }),
  }), FalSubmissionAmbiguousError);
  assert.equal(submitCancelled, 1);
  await assert.rejects(() => submitFalQueue({
    model: "fal-ai/flux/schnell", input: { prompt: "fixture" }, apiKey: "fixture",
    fetchImpl: async () => new Response("{malformed", { status: 200 }),
  }), FalSubmissionAmbiguousError);

  const receipt = { requestId: "fal-request-0002", model: "fal-ai/flux/schnell",
    statusUrl: "https://queue.fal.run/fal-ai/flux/schnell/requests/fal-request-0002/status",
    resultUrl: "https://queue.fal.run/fal-ai/flux/schnell/requests/fal-request-0002/response" };
  let statusCancelled = 0;
  await assert.rejects(() => readFalQueueStatus({ receipt, apiKey: "fixture",
    fetchImpl: async () => new Response(overflowStream(FAL_STATUS_METADATA_MAX_BYTES, () => statusCancelled++), { status: 200 }),
  }), /exceeds/);
  assert.equal(statusCancelled, 1);

  let resultCancelled = 0; let mediaReads = 0; let storageWrites = 0;
  await assert.rejects(() => copyFalQueueResult({
    kind: "image", receipt, apiKey: "fixture", r2Key: "creatives/generations/intent/v0/image.jpg",
    fetchImpl: async (url) => {
      if (url === receipt.resultUrl) return new Response(overflowStream(FAL_RESULT_METADATA_MAX_BYTES, () => resultCancelled++), { status: 200 });
      mediaReads++; return new Response();
    },
    putObject: async () => { storageWrites++; throw new Error("must not write"); },
  }), /exceeds/);
  assert.deepEqual({ resultCancelled, mediaReads, storageWrites }, { resultCancelled: 1, mediaReads: 0, storageWrites: 0 });
});

test("ElevenLabs exact history receipt can be recovered uniquely from the second bounded page", async () => {
  const text = "second page receipt";
  const receipt = { requestId: "tts-request-second-page", voiceId: "voice-1", model: "model-1",
    textDigest: createHash("sha256").update(text).digest("hex"), characterCount: text.length };
  const urls = [];
  const id = await findUniqueTtsHistoryItem({ receipt, text, createdAt: 2_000_000_000_000, apiKey: "fixture",
    fetchImpl: async (url) => {
      urls.push(new URL(url));
      if (urls.length === 1) return Response.json({ history: [{ ...exactHistoryItem(receipt, "other", "history-first") }],
        has_more: true, last_history_item_id: "history-first", scanned_until: 1_999_999_999 });
      return Response.json({ history: [exactHistoryItem(receipt, text, "history-second")],
        has_more: false, last_history_item_id: "history-second", scanned_until: 1_999_999_998 });
    } });
  assert.equal(id, "history-second");
  assert.equal(urls.length, 2);
  assert.equal(urls[0].searchParams.has("start_after_history_item_id"), false);
  assert.equal(urls[1].searchParams.get("start_after_history_item_id"), "history-first");
});

test("ElevenLabs history traversal has bounded exhaustion and exact duplicate/conflict handling", async () => {
  const text = "bounded history";
  const receipt = { requestId: "tts-request-bounded", voiceId: "voice-1", model: "model-1",
    textDigest: createHash("sha256").update(text).digest("hex"), characterCount: text.length };
  let pages = 0;
  await assert.rejects(() => findUniqueTtsHistoryItem({ receipt, text, createdAt: 2_000_000_000_000, apiKey: "fixture",
    fetchImpl: async () => { pages++; return Response.json({ history: [], has_more: true,
      last_history_item_id: `cursor-${pages}`, scanned_until: 1_999_999_999 - pages }); } }), /not_uniquely/);
  assert.equal(pages, ELEVEN_HISTORY_MAX_PAGES);

  let duplicatePage = 0;
  const deduped = await findUniqueTtsHistoryItem({ receipt, text, createdAt: 2_000_000_000_000, apiKey: "fixture",
    fetchImpl: async () => {
      duplicatePage++;
      return Response.json({ history: [exactHistoryItem(receipt, text, "history-duplicate")],
        has_more: duplicatePage === 1, last_history_item_id: `duplicate-cursor-${duplicatePage}`,
        scanned_until: 1_999_999_999 - duplicatePage });
    } });
  assert.equal(deduped, "history-duplicate");

  let conflictPage = 0;
  await assert.rejects(() => findUniqueTtsHistoryItem({ receipt, text, createdAt: 2_000_000_000_000, apiKey: "fixture",
    fetchImpl: async () => {
      conflictPage++;
      const item = exactHistoryItem(receipt, conflictPage === 1 ? text : "conflicting text", "history-conflict");
      return Response.json({ history: [item], has_more: conflictPage === 1,
        last_history_item_id: `conflict-cursor-${conflictPage}`, scanned_until: 1_999_999_999 - conflictPage });
    } }), /duplicate_conflict/);
});

test("ElevenLabs history page overflow is cancelled before parsing or pagination", async () => {
  const text = "oversized history";
  const receipt = { requestId: "tts-request-oversized", voiceId: "voice-1", model: "model-1",
    textDigest: createHash("sha256").update(text).digest("hex"), characterCount: text.length };
  let calls = 0; let cancelled = 0;
  await assert.rejects(() => findUniqueTtsHistoryItem({ receipt, text, createdAt: Date.now(), apiKey: "fixture",
    fetchImpl: async () => { calls++; return new Response(overflowStream(ELEVEN_HISTORY_PAGE_MAX_BYTES, () => cancelled++), { status: 200 }); } }), /exceeds/);
  assert.deepEqual({ calls, cancelled }, { calls: 1, cancelled: 1 });
});
