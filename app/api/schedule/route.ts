// Server-only route: on creative approval, enqueue the schedule-approved-creative Trigger task,
// which passes the AI-label gate and distributes (Ayrshare fan-out or semi-manual post rows).
import { NextResponse } from "next/server";
import { tasks } from "@trigger.dev/sdk/v3";
import type { scheduleApprovedCreative } from "@/src/trigger/content-factory";
import { requireOperator } from "@/src/lib/auth/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const guard = await requireOperator(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  let body: { creativeId?: string; caption?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.creativeId) {
    return NextResponse.json({ error: "creativeId is required" }, { status: 400 });
  }
  if (!process.env.TRIGGER_SECRET_KEY && !process.env.TRIGGER_ACCESS_TOKEN) {
    // Approval still succeeds in Convex; distribution is deferred until Trigger is configured.
    return NextResponse.json(
      { ok: false, deferred: true, reason: "trigger not configured (TRIGGER_SECRET_KEY missing)" },
      { status: 202 },
    );
  }
  try {
    const handle = await tasks.trigger<typeof scheduleApprovedCreative>("schedule-approved-creative", {
      creativeId: body.creativeId,
      caption: body.caption,
    });
    return NextResponse.json({ ok: true, runId: handle.id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "trigger failed" },
      { status: 500 },
    );
  }
}
