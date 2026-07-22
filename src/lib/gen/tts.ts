// Receipt-first ElevenLabs adapter. Logging/history must remain enabled: recovery is read-only
// and never creates a second billed sample after a request may have reached ElevenLabs.
import { getKey } from "../vault";
import { putDeterministicObject, type StoredObjectReceipt } from "../storage";
import { stableSha256 } from "../cjOrder";
import { readJsonResponseBounded, readResponseBodyBounded } from "../boundedBody";

const ELEVEN_BASE = "https://api.elevenlabs.io/v1";
export const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM";
export const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL ?? "eleven_turbo_v2_5";
export const ELEVEN_HISTORY_PAGE_SIZE = 100;
export const ELEVEN_HISTORY_MAX_PAGES = 4;
export const ELEVEN_HISTORY_MAX_ITEMS = ELEVEN_HISTORY_PAGE_SIZE * ELEVEN_HISTORY_MAX_PAGES;
// A history page contains at most 100 metadata records; audio is fetched separately.
export const ELEVEN_HISTORY_PAGE_MAX_BYTES = 1024 * 1024;

export type TtsProviderReceipt = {
  requestId: string;
  voiceId: string;
  model: string;
  textDigest: string;
  characterCount: number;
  characterCost?: number;
};

export class TtsSubmissionAmbiguousError extends Error {
  constructor() { super("ElevenLabs submission has no durable recoverable receipt"); this.name = "TtsSubmissionAmbiguousError"; }
}

export class TtsDefinitiveSubmissionError extends Error {
  constructor(public readonly status: number) { super(`ElevenLabs rejected TTS with HTTP ${status}`); this.name = "TtsDefinitiveSubmissionError"; }
}

export async function getElevenLabsApiKey(): Promise<string> {
  const key = await getKey("elevenlabs", "ELEVENLABS_API_KEY");
  if (!key) throw new Error("elevenlabs_key_unavailable");
  return key;
}

export async function openElevenLabsTts(args: {
  text: string;
  voiceId: string;
  model: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<{ receipt: TtsProviderReceipt; response: Response }> {
  let response: Response;
  try {
    response = await (args.fetchImpl ?? fetch)(`${ELEVEN_BASE}/text-to-speech/${encodeURIComponent(args.voiceId)}`, {
      method: "POST",
      headers: { "xi-api-key": args.apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      // enable_logging intentionally remains true/default. Zero-retention mode makes automatic
      // history reconciliation impossible and is not compatible with this workflow.
      body: JSON.stringify({ text: args.text, model_id: args.model, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    });
  } catch {
    throw new TtsSubmissionAmbiguousError();
  }
  if (!response.ok) {
    if (response.status >= 500 || response.status === 408 || response.status === 429) throw new TtsSubmissionAmbiguousError();
    throw new TtsDefinitiveSubmissionError(response.status);
  }
  const requestId = response.headers.get("request-id")?.trim();
  if (!requestId || requestId.length > 200) throw new TtsSubmissionAmbiguousError();
  const rawCost = response.headers.get("character-cost");
  const parsedCost = rawCost === null ? undefined : Number(rawCost);
  return {
    receipt: {
      requestId, voiceId: args.voiceId, model: args.model, textDigest: stableSha256(args.text),
      characterCount: args.text.length,
      ...(parsedCost !== undefined && Number.isFinite(parsedCost) && parsedCost >= 0 ? { characterCost: parsedCost } : {}),
    },
    response,
  };
}

export async function findUniqueTtsHistoryItem(args: {
  receipt: TtsProviderReceipt;
  text: string;
  createdAt: number;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  if (stableSha256(args.text) !== args.receipt.textDigest) throw new Error("tts_history_input_mismatch");
  if (!Number.isSafeInteger(args.createdAt) || args.createdAt < 0) throw new Error("tts_history_creation_time_invalid");
  const windowStart = Math.max(0, Math.floor(args.createdAt / 1_000) - 60);
  const fetcher = args.fetchImpl ?? fetch;
  const seen = new Map<string, string>();
  const matchingIds = new Set<string>();
  let cursor: string | undefined;
  let totalItems = 0;
  let exhausted = false;

  for (let page = 0; page < ELEVEN_HISTORY_MAX_PAGES; page++) {
    const query = new URLSearchParams({
      page_size: String(ELEVEN_HISTORY_PAGE_SIZE), voice_id: args.receipt.voiceId,
      model_id: args.receipt.model, source: "TTS", date_after_unix: String(windowStart),
      sort_direction: "desc", ...(cursor ? { start_after_history_item_id: cursor } : {}),
    });
    const response = await fetcher(`${ELEVEN_BASE}/history?${query}`, { headers: { "xi-api-key": args.apiKey } });
    if (!response.ok) throw new Error(`elevenlabs_history_http_${response.status}`);
    const body = await readJsonResponseBounded<{
      history?: unknown; has_more?: unknown; last_history_item_id?: unknown; scanned_until?: unknown;
    }>(response, ELEVEN_HISTORY_PAGE_MAX_BYTES, "ElevenLabs history metadata");
    if (!Array.isArray(body.history) || body.history.length > ELEVEN_HISTORY_PAGE_SIZE
      || typeof body.has_more !== "boolean"
      || (body.last_history_item_id !== null && typeof body.last_history_item_id !== "string")
      || (body.scanned_until !== null && body.scanned_until !== undefined && !Number.isSafeInteger(body.scanned_until))) {
      throw new Error("elevenlabs_history_page_invalid");
    }
    totalItems += body.history.length;
    if (totalItems > ELEVEN_HISTORY_MAX_ITEMS) throw new Error("elevenlabs_history_item_limit_exceeded");

    for (const value of body.history) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("elevenlabs_history_item_invalid");
      const item = value as Record<string, unknown>;
      const id = item.history_item_id;
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error("elevenlabs_history_item_invalid");
      const fingerprint = stableSha256(JSON.stringify({
        requestId: item.request_id, voiceId: item.voice_id, model: item.model_id,
        text: item.text, source: item.source,
      }));
      const prior = seen.get(id);
      if (prior && prior !== fingerprint) throw new Error("elevenlabs_history_duplicate_conflict");
      if (prior) continue;
      seen.set(id, fingerprint);
      if (item.request_id === args.receipt.requestId && item.voice_id === args.receipt.voiceId
        && item.model_id === args.receipt.model && item.source === "TTS"
        && typeof item.text === "string" && stableSha256(item.text) === args.receipt.textDigest) {
        matchingIds.add(id);
      }
    }

    if (matchingIds.size > 1) throw new Error("elevenlabs_history_not_uniquely_recoverable");
    if (!body.has_more || (typeof body.scanned_until === "number" && body.scanned_until < windowStart)) {
      exhausted = true;
      break;
    }
    const nextCursor = body.last_history_item_id;
    if (typeof nextCursor !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(nextCursor)
      || nextCursor === cursor) throw new Error("elevenlabs_history_cursor_invalid");
    cursor = nextCursor;
  }

  if (!exhausted || matchingIds.size !== 1) throw new Error("elevenlabs_history_not_uniquely_recoverable");
  return [...matchingIds][0];
}

export async function copyTtsHistoryAudio(args: {
  historyItemId: string;
  apiKey: string;
  r2Key: string;
  fetchImpl?: typeof fetch;
  putObject?: typeof putDeterministicObject;
}): Promise<StoredObjectReceipt> {
  if (!args.historyItemId || args.historyItemId.length > 200) throw new Error("elevenlabs_history_id_invalid");
  const response = await (args.fetchImpl ?? fetch)(`${ELEVEN_BASE}/history/${encodeURIComponent(args.historyItemId)}/audio`, { headers: { "xi-api-key": args.apiKey, Accept: "audio/mpeg" } });
  if (!response.ok) throw new Error(`elevenlabs_history_audio_http_${response.status}`);
  if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "audio/mpeg") throw new Error("elevenlabs_audio_type_invalid");
  const maxBytes = 20 * 1024 * 1024;
  const body = await readResponseBodyBounded(response, maxBytes, "ElevenLabs history audio");
  return (args.putObject ?? putDeterministicObject)(args.r2Key, body, "audio/mpeg", maxBytes);
}
