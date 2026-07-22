// Server-only second operator action: persist an exact publication authorization, then enqueue
// its durable Trigger handoff. Content approval alone never calls this route.
import { NextResponse } from "next/server";
import { tasks } from "@trigger.dev/sdk/v3";
import type { scheduleApprovedCreative } from "@/src/trigger/content-factory";
import { requireOperator } from "@/src/lib/auth/server";
import { convexClient, api } from "@/src/lib/convexClient";
import type { Id } from "@/convex/_generated/dataModel";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const guard = await requireOperator(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  let body: {
    creativeId?: string; expectedRevision?: number; caption?: string;
    destinations?: Array<{ platform?: string; targetAccount?: string }>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.creativeId !== "string" || !body.creativeId.trim()) {
    return NextResponse.json({ error: "creativeId is required" }, { status: 400 });
  }
  const allowed = new Set(["tiktok", "instagram", "youtube", "facebook"]);
  if (!Number.isInteger(body.expectedRevision) || typeof body.caption !== "string" || !body.caption.trim()
    || !Array.isArray(body.destinations) || !body.destinations.length
    || body.destinations.some((d) => !allowed.has(d.platform ?? "") || typeof d.targetAccount !== "string" || !d.targetAccount.trim())) {
    return NextResponse.json({ error: "expectedRevision, caption, and exact platform target accounts are required" }, { status: 400 });
  }
  const creativeId = body.creativeId.trim() as Id<"creatives">;
  const convex = convexClient();
  let dispatchKey: string;
  try {
    const authorization = await convex.mutation(api.creatives.authorizePublication, {
      creativeId,
      expectedRevision: body.expectedRevision!,
      caption: body.caption.trim(),
      destinations: body.destinations.map((d) => ({
        platform: d.platform as "tiktok" | "instagram" | "youtube" | "facebook",
        targetAccount: d.targetAccount!.trim(),
      })),
      operator: "Daniel",
    });
    dispatchKey = authorization.dispatchKey;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "publication authorization failed" }, { status: 409 });
  }
  if (!process.env.TRIGGER_SECRET_KEY) {
    // The explicitly authorized creative owns a durable dispatch row. Do not lose that intent merely
    // because this server cannot currently contact Trigger.
    return NextResponse.json(
      { ok: false, deferred: true, authorized: true, reason: "publication is authorized and queued; TRIGGER_SECRET_KEY is missing" },
      { status: 202 },
    );
  }
  try {
    const dispatch = await convex.mutation(api.posts.beginDistributionDispatch, { creativeId, dispatchKey });
    if (dispatch.status === "reconcile_required") {
      return NextResponse.json({ ok: false, reconciliationRequired: true, reason: "provider receipt reconciliation is required before any further distribution", creativeId }, { status: 409 });
    }
    if (dispatch.status !== "dispatching") {
      return NextResponse.json({ ok: true, creativeId, runId: dispatch.triggerRunId, reused: true, queued: true });
    }
    const handle = await tasks.trigger<typeof scheduleApprovedCreative>("schedule-approved-creative", {
      creativeId,
      dispatchKey,
    }, { idempotencyKey: dispatchKey, idempotencyKeyTTL: "24w" });
    await convex.mutation(api.posts.recordDistributionDispatch, { creativeId, dispatchKey, triggerRunId: handle.id });
    return NextResponse.json({ ok: true, runId: handle.id, creativeId, queued: true });
  } catch (err) {
    // `beginDistributionDispatch` is idempotent and the Trigger request uses the same key; an
    // unknown response is intentionally left dispatching for the recovery task, never dropped.
    return NextResponse.json(
      { ok: false, deferred: true, error: err instanceof Error ? err.message : "trigger failed; durable recovery will retry" },
      { status: 202 },
    );
  }
}
