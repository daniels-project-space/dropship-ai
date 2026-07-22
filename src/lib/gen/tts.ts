// Receipt-first ElevenLabs adapter. Logging/history must remain enabled: recovery is read-only
// and never creates a second billed sample after a request may have reached ElevenLabs.
import { getKey } from "../vault";
import { putDeterministicObject, type StoredObjectReceipt } from "../storage";
import { stableSha256 } from "../cjOrder";

const ELEVEN_BASE = "https://api.elevenlabs.io/v1";
export const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM";
export const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL ?? "eleven_turbo_v2_5";

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
  const query = new URLSearchParams({
    page_size: "100", voice_id: args.receipt.voiceId, model_id: args.receipt.model, source: "TTS",
    date_after_unix: String(Math.max(0, Math.floor(args.createdAt / 1_000) - 60)), sort_direction: "desc",
  });
  const response = await (args.fetchImpl ?? fetch)(`${ELEVEN_BASE}/history?${query}`, { headers: { "xi-api-key": args.apiKey } });
  if (!response.ok) throw new Error(`elevenlabs_history_http_${response.status}`);
  const body = await response.json() as { history?: Array<{ history_item_id?: unknown; request_id?: unknown; voice_id?: unknown; model_id?: unknown; text?: unknown; source?: unknown }> };
  const matches = (body.history ?? []).filter((item) => item.request_id === args.receipt.requestId
    && item.voice_id === args.receipt.voiceId && item.model_id === args.receipt.model && item.source === "TTS"
    && typeof item.text === "string" && stableSha256(item.text) === args.receipt.textDigest
    && typeof item.history_item_id === "string" && item.history_item_id.length > 0 && item.history_item_id.length <= 200);
  if (matches.length !== 1) throw new Error("elevenlabs_history_not_uniquely_recoverable");
  return matches[0].history_item_id as string;
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
  return (args.putObject ?? putDeterministicObject)(args.r2Key, Buffer.from(await response.arrayBuffer()), "audio/mpeg", 20 * 1024 * 1024);
}
