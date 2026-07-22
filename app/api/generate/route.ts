// Operator intake commits one Convex intent plus K immutable variants before Trigger handoff.
import { NextResponse } from "next/server";
import { tasks } from "@trigger.dev/sdk/v3";
import type { contentFactory } from "@/src/trigger/content-factory";
import { requireOperator } from "@/src/lib/auth/server";
import { convexClient, api } from "@/src/lib/convexClient";
import type { Id } from "@/convex/_generated/dataModel";
import {
  creativeGenerationInputDigest, generationHandoffKey, normalizeCreativeGenerationInput,
  validateCallerGenerationIdentity, validateControlPlaneIdentity,
} from "@/src/lib/creativeGeneration";
import { FAL_CLIP_MODEL, FAL_IMAGE_MODEL } from "@/src/lib/gen/fal";
import { ELEVEN_MODEL, ELEVEN_VOICE_ID } from "@/src/lib/gen/tts";
import { BodyLimitExceededError, readRequestBodyBounded } from "@/src/lib/boundedBody";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 16 * 1024;

type GenerateRouteDependencies = {
  authorize: typeof requireOperator;
  getConvex: typeof convexClient;
  trigger: typeof tasks.trigger;
  triggerConfigured: () => boolean;
};

export function createGeneratePost(overrides: Partial<GenerateRouteDependencies> = {}) {
  const dependencies: GenerateRouteDependencies = {
    authorize: requireOperator,
    getConvex: convexClient,
    trigger: tasks.trigger,
    triggerConfigured: () => !!(process.env.TRIGGER_SECRET_KEY || process.env.TRIGGER_ACCESS_TOKEN),
    ...overrides,
  };
  return (req: Request) => handleGeneratePost(req, dependencies);
}

async function handleGeneratePost(req: Request, dependencies: GenerateRouteDependencies) {
  const guard = await dependencies.authorize(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  let raw: unknown;
  try {
    const body = await readRequestBodyBounded(req, MAX_BODY_BYTES, "generation request");
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    if (error instanceof BodyLimitExceededError) {
      return NextResponse.json({ error: "request body is too large" }, { status: 413 });
    }
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  let input: ReturnType<typeof normalizeCreativeGenerationInput>;
  let identity: ReturnType<typeof validateCallerGenerationIdentity>;
  try {
    input = normalizeCreativeGenerationInput(raw);
    const body = raw as Record<string, unknown>;
    identity = validateCallerGenerationIdentity(body.requestId, body.inputDigest);
    if (creativeGenerationInputDigest(input) !== identity.inputDigest) throw new Error("inputDigest does not match the exact normalized input");
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "invalid generation request" }, { status: 400 });
  }

  const convex = dependencies.getConvex();
  try {
    const intent: any = await convex.mutation(api.creativeGenerations.createOrReuseIntent, {
      siteId: input.siteId as Id<"sites">,
      productId: input.productId ? input.productId as Id<"products"> : undefined,
      callerRequestId: identity.requestId,
      normalizedInputDigest: identity.inputDigest,
      requestedVariants: input.variants,
      scenePrompt: input.scenePrompt,
      hooks: input.hooks,
      imageModel: FAL_IMAGE_MODEL,
      clipModel: FAL_CLIP_MODEL,
      ttsModel: ELEVEN_MODEL,
      voiceId: ELEVEN_VOICE_ID,
    });
    const intentId = intent.intentId as Id<"creativeGenerationIntents">;
    if (!dependencies.triggerConfigured()) {
      return NextResponse.json({ ok: true, intentId, requestId: identity.requestId, state: "deferred", queued: false, durable: true, reused: intent.reused }, { status: 202 });
    }
    const claim: any = await convex.mutation(api.creativeGenerations.claimIntentHandoff, { intentId });
    if (claim.state === "dispatched") {
      const runId = validateControlPlaneIdentity(claim.triggerRunId, "Trigger run ID");
      return NextResponse.json({ ok: true, intentId, requestId: identity.requestId, state: "queued", queued: true, durable: true, reused: true, runId }, { status: 202 });
    }
    if (claim.state === "busy") {
      return NextResponse.json({ ok: true, intentId, requestId: identity.requestId, state: "in_flight", queued: false, durable: true, reused: intent.reused }, { status: 202 });
    }
    if (claim.state !== "dispatch") {
      return NextResponse.json({ ok: true, intentId, requestId: identity.requestId, state: "deferred", queued: false, durable: true, reused: intent.reused }, { status: 202 });
    }
    try {
      const handle = await dependencies.trigger<typeof contentFactory>("content-factory", { intentId }, {
        idempotencyKey: generationHandoffKey(intentId, claim.generation), idempotencyKeyTTL: "24w",
      });
      const runId = validateControlPlaneIdentity(handle.id, "Trigger run ID");
      await convex.mutation(api.creativeGenerations.recordIntentHandoff, { intentId, generation: claim.generation, triggerRunId: runId });
      return NextResponse.json({ ok: true, intentId, requestId: identity.requestId, state: "queued", queued: true, durable: true, reused: intent.reused, runId }, { status: 202 });
    } catch {
      // Trigger may have accepted the deterministic handoff. The Convex lease remains due and
      // the recovery sweep reuses the exact idempotency key.
      return NextResponse.json({ ok: true, intentId, requestId: identity.requestId, state: "deferred", queued: false, durable: true, reused: intent.reused }, { status: 202 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "generation intake failed";
    const conflict = /already used|digest mismatch|different immutable input/i.test(message);
    return NextResponse.json({ error: message }, { status: conflict ? 409 : 422 });
  }
}

export const POST = createGeneratePost();
