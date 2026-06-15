// ElevenLabs text-to-speech adapter — voiceover for product-first creatives.
//
// Key: vault `elevenlabs` service, key `ELEVENLABS_API_KEY` (verified present 2026-06-14).
// Output MP3 is uploaded to R2 via storage.putObject; returns the R2 key.
//
// NOTE on disclosure: a SYNTHETIC VOICE is itself an AI-generated asset. Any creative that uses
// TTS voiceover MUST carry aiLabelRequired:true so the assembler burns the on-screen label.
import { getKey } from "../vault";
import { putObject } from "../storage";

const ELEVEN_BASE = "https://api.elevenlabs.io/v1";
// Default voice: "Rachel" (stable public default). Override per-brand via env.
const DEFAULT_VOICE = process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM";
const MODEL = process.env.ELEVENLABS_MODEL ?? "eleven_turbo_v2_5"; // cheapest quality tier

export type TtsResult = { r2Key: string; bytes: number; voiceId: string; costNote: string };

/** Synthesize `text` to MP3, upload to R2, return the key. */
export async function tts(text: string, r2Key: string, voiceId = DEFAULT_VOICE): Promise<TtsResult> {
  const key = await getKey("elevenlabs", "ELEVENLABS_API_KEY");
  if (!key) throw new Error("tts: ELEVENLABS_API_KEY missing from vault `elevenlabs` service");

  const res = await fetch(`${ELEVEN_BASE}/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": key,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: MODEL,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`tts: ElevenLabs HTTP ${res.status} ${body.slice(0, 240)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await putObject(r2Key, buf, "audio/mpeg");
  return {
    r2Key,
    bytes: buf.byteLength,
    voiceId,
    costNote: `eleven_turbo ≈ $0.00003/char (~$${((text.length * 0.00003)).toFixed(4)} for this line)`,
  };
}
