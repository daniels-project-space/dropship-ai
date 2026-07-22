// Operator intake commits one Convex intent plus K immutable variants before Trigger handoff.
import { NextResponse } from "next/server";
import { tasks } from "@trigger.dev/sdk/v3";
import type { contentFactory } from "@/src/trigger/content-factory";
import { requireOperator } from "@/src/lib/auth/server";
import { convexClient, api } from "@/src/lib/convexClient";
import type { Id } from "@/convex/_generated/dataModel";
import {
  creativeGenerationInputDigest, generationHandoffKey, normalizeCreativeGenerationInput,
  validateCallerGenerationIdentity,
} from "@/src/lib/creativeGeneration";
import { FAL_CLIP_MODEL, FAL_IMAGE_MODEL } from "@/src/lib/gen/fal";
import { ELEVEN_MODEL, ELEVEN_VOICE_ID } from "@/src/lib/gen/tts";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 16 * 1024;

export async function POST(req: Request) {
  const guard = await requireOperator(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return NextResponse.json({ error: "request body is too large" }, { status: 413 });

  let raw: unknown;
  try {
    const text = await req.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return NextResponse.json({ error: "request body is too large" }, { status: 413 });
    raw = JSON.parse(text);
  } catch {
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

  const convex = convexClient();
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
    if (!process.env.TRIGGER_SECRET_KEY && !process.env.TRIGGER_ACCESS_TOKEN) {
      return NextResponse.json({ ok: true, intentId, requestId: identity.requestId, state: "deferred", queued: false, durable: true, reused: intent.reused }, { status: 202 });
    }
    const claim: any = await convex.mutation(api.creativeGenerations.claimIntentHandoff, { intentId });
    if (claim.state === "dispatched" || claim.state === "busy") {
      return NextResponse.json({ ok: true, intentId, requestId: identity.requestId, state: "queued", queued: true, durable: true, reused: true, runId: claim.triggerRunId }, { status: 202 });
    }
    try {
      const handle = await tasks.trigger<typeof contentFactory>("content-factory", { intentId }, {
        idempotencyKey: generationHandoffKey(intentId, claim.generation), idempotencyKeyTTL: "24w",
      });
      await convex.mutation(api.creativeGenerations.recordIntentHandoff, { intentId, generation: claim.generation, triggerRunId: handle.id });
      return NextResponse.json({ ok: true, intentId, requestId: identity.requestId, state: "queued", queued: true, durable: true, reused: intent.reused, runId: handle.id }, { status: 202 });
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
