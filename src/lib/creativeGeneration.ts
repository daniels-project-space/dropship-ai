import { stableSha256 } from "./cjOrder";

export const DEFAULT_CREATIVE_SCENE =
  "close-up product photography of a textured silicone dog lick mat smeared with creamy peanut " +
  "butter and yogurt, soft natural window light, calm muted palette, shallow depth of field, " +
  "no animals in frame, premium pet-enrichment brand look, vertical 9:16";

export const DEFAULT_CREATIVE_HOOKS = [
  "The 3-minute trick that calms an anxious dog.",
  "Watch this lick mat melt the zoomies away.",
  "Vet-loved enrichment your dog actually slows down for.",
] as const;

export const DEFAULT_CLIP_PROMPT = "gentle slow push-in, subtle texture motion, calm";
export const MAX_CREATIVE_VARIANTS = 3;
export const MAX_STAGE_FAILURES = 3;

export const GENERATION_STAGES = [
  "image_submission",
  "image_polling",
  "image_result_copy",
  "clip_submission",
  "clip_polling",
  "clip_result_copy",
  "tts_reservation",
  "tts_receipt",
  "tts_audio_copy",
  "assembly",
  "review_ready",
  "failed",
  "needs_attention",
] as const;

export type GenerationStage = (typeof GENERATION_STAGES)[number];
export type FalStage = "image" | "clip";
export type FalQueueState = "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";

export type NormalizedCreativeGenerationInput = {
  siteId: string;
  productId: string | null;
  variants: number;
  scenePrompt: string;
  hooks: string[];
};

function cleanBoundedString(value: unknown, name: string, max: number, required = true): string {
  if (typeof value !== "string") {
    if (!required && value === undefined) return "";
    throw new Error(`${name} must be a string`);
  }
  const cleaned = value.normalize("NFC").trim().replace(/\s+/g, " ");
  if (required && !cleaned) throw new Error(`${name} is required`);
  if (cleaned.length > max) throw new Error(`${name} exceeds ${max} characters`);
  return cleaned;
}

/** Normalize and bound every operator-controlled creative fact before durable intake. */
export function normalizeCreativeGenerationInput(value: unknown): NormalizedCreativeGenerationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be an object");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["requestId", "inputDigest", "siteId", "productId", "variants", "scenePrompt", "hooks"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("request body contains unsupported fields");
  const variants = input.variants === undefined ? MAX_CREATIVE_VARIANTS : input.variants;
  if (!Number.isInteger(variants) || (variants as number) < 1 || (variants as number) > MAX_CREATIVE_VARIANTS) {
    throw new Error(`variants must be an integer from 1 to ${MAX_CREATIVE_VARIANTS}`);
  }
  if (input.hooks !== undefined && (!Array.isArray(input.hooks) || input.hooks.length < 1 || input.hooks.length > MAX_CREATIVE_VARIANTS)) {
    throw new Error(`hooks must contain 1 to ${MAX_CREATIVE_VARIANTS} strings`);
  }
  const hooks = (input.hooks === undefined ? [...DEFAULT_CREATIVE_HOOKS] : input.hooks)
    .map((hook, index) => cleanBoundedString(hook, `hooks[${index}]`, 300));
  return {
    siteId: cleanBoundedString(input.siteId, "siteId", 128),
    productId: input.productId === undefined || input.productId === null || input.productId === ""
      ? null
      : cleanBoundedString(input.productId, "productId", 128),
    variants: variants as number,
    scenePrompt: input.scenePrompt === undefined
      ? DEFAULT_CREATIVE_SCENE
      : cleanBoundedString(input.scenePrompt, "scenePrompt", 1_000),
    hooks,
  };
}

export function creativeGenerationInputDigest(input: NormalizedCreativeGenerationInput): string {
  return stableSha256(JSON.stringify({
    siteId: input.siteId,
    productId: input.productId,
    variants: input.variants,
    scenePrompt: input.scenePrompt,
    hooks: input.hooks,
  }));
}

export function validateCallerGenerationIdentity(requestId: unknown, inputDigest: unknown): { requestId: string; inputDigest: string } {
  const stableRequestId = cleanBoundedString(requestId, "requestId", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(stableRequestId)) {
    throw new Error("requestId must be a stable 8-128 character identifier");
  }
  if (typeof inputDigest !== "string" || !/^[a-f0-9]{64}$/.test(inputDigest)) {
    throw new Error("inputDigest must be an exact lowercase SHA-256 digest");
  }
  return { requestId: stableRequestId, inputDigest };
}

export function deterministicGenerationKey(intentId: string, variant: number, asset: "image" | "clip" | "audio" | "final"): string {
  const suffix = asset === "image" ? "image.jpg" : asset === "clip" ? "clip.mp4" : asset === "audio" ? "voice.mp3" : "final.mp4";
  return `creatives/generations/${intentId}/v${variant}/${suffix}`;
}

export function generationHandoffKey(intentId: string, generation: number): string {
  return `creative-generation:${intentId}:handoff:${generation}`;
}

export function generationStageKey(variantId: string, stage: GenerationStage, leaseGeneration: number): string {
  return `creative-generation:${variantId}:${stage}:${leaseGeneration}`;
}

export function isProviderSubmissionStage(stage: GenerationStage): boolean {
  return stage === "image_submission" || stage === "clip_submission" || stage === "tts_reservation";
}

