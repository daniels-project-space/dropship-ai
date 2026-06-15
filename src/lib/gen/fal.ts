// fal.ai generation adapter — product-first imagery + short B-roll clips.
//
// PRODUCT-FIRST DOCTRINE (locked, do not relitigate): the hero asset must be the PRODUCT
// (lick/snuffle mat ASMR, freeze-mold pour, hands-only demo, before/after). AI-generated
// dog footage is uncanny-valley poison as a hero — only ever a brief stylized supporting
// b-roll. `falProductImage`/`falProductClip` are the hero generators; `falBrollClip` is the
// supporting-only path and is hard-flagged aiGenerated:true so the assembler burns the label.
//
// Keys: vault `fal` service, key `FAL_KEY` (verified present 2026-06-14). Outputs land in R2
// via storage.putObject; the function returns the R2 key (never a hosted fal URL — those expire).
import { getKey } from "../vault";
import { putObject } from "../storage";

const FAL_BASE = "https://fal.run";

// Product-first models. Flux for stills; Kling/Veo for short motion. Overridable via env for
// cost tuning without a redeploy (e.g. swap kling-video for a cheaper preview model in dev).
const MODEL_IMAGE = process.env.FAL_MODEL_IMAGE ?? "fal-ai/flux/schnell";
const MODEL_CLIP = process.env.FAL_MODEL_CLIP ?? "fal-ai/kling-video/v1/standard/image-to-video";

export type FalResult = { r2Key: string; bytes: number; model: string; costNote: string };

async function falKey(): Promise<string> {
  const k = await getKey("fal", "FAL_KEY");
  if (!k) throw new Error("fal: FAL_KEY missing from vault `fal` service");
  return k;
}

/** Low-level fal.run call. Returns the first output media URL the model emits. */
async function falRun(model: string, input: Record<string, unknown>): Promise<string> {
  const key = await falKey();
  const res = await fetch(`${FAL_BASE}/${model}`, {
    method: "POST",
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`fal ${model} failed: HTTP ${res.status} ${body.slice(0, 240)}`);
  }
  const json = (await res.json()) as {
    images?: Array<{ url: string }>;
    video?: { url: string };
    image?: { url: string };
  };
  const url = json.images?.[0]?.url ?? json.video?.url ?? json.image?.url;
  if (!url) throw new Error(`fal ${model}: no media URL in response`);
  return url;
}

async function fetchToR2(url: string, r2Key: string, contentType: string): Promise<number> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fal: download of output failed HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await putObject(r2Key, buf, contentType);
  return buf.byteLength;
}

/**
 * Product-first hero STILL (Flux). `prompt` should describe the PRODUCT in scene — never a
 * realistic dog as the subject. The caller owns prompt discipline; this adapter does not
 * synthesize animal footage.
 */
export async function falProductImage(
  prompt: string,
  r2Key: string,
  opts?: { width?: number; height?: number },
): Promise<FalResult> {
  const url = await falRun(MODEL_IMAGE, {
    prompt,
    image_size: opts?.width && opts?.height
      ? { width: opts.width, height: opts.height }
      : "portrait_16_9", // 9:16-leaning vertical for Reels/Shorts/TikTok
    num_images: 1,
  });
  const bytes = await fetchToR2(url, r2Key, "image/jpeg");
  return { r2Key, bytes, model: MODEL_IMAGE, costNote: "flux-schnell ≈ $0.003/img" };
}

/**
 * Product-first hero CLIP — image-to-video from a product still, so motion stays anchored to a
 * REAL product frame (mat texture, pour, spread). `imageUrl` should be a presigned R2 URL of a
 * product still (or a fal still URL within the same run).
 */
export async function falProductClip(
  imageUrl: string,
  prompt: string,
  r2Key: string,
): Promise<FalResult> {
  const url = await falRun(MODEL_CLIP, {
    image_url: imageUrl,
    prompt,
    duration: "5",
    aspect_ratio: "9:16",
  });
  const bytes = await fetchToR2(url, r2Key, "video/mp4");
  return { r2Key, bytes, model: MODEL_CLIP, costNote: "kling-std 5s ≈ $0.10/clip" };
}

/**
 * Supporting-only stylized B-roll (e.g. a brief animated dog). HARD-FLAGGED ai: callers MUST
 * persist the creative with aiGenerated:true + aiLabelRequired:true. Never use as a hero frame.
 */
export async function falBrollClip(prompt: string, r2Key: string): Promise<FalResult & { aiGenerated: true }> {
  const url = await falRun(MODEL_CLIP, {
    prompt: `stylized illustrated supporting b-roll, clearly non-photoreal: ${prompt}`,
    duration: "5",
    aspect_ratio: "9:16",
  });
  const bytes = await fetchToR2(url, r2Key, "video/mp4");
  return { r2Key, bytes, model: MODEL_CLIP, costNote: "kling-std 5s ≈ $0.10/clip", aiGenerated: true };
}
