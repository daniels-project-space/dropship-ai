// Server-only route: on creative approval, enqueue the schedule-approved-creative Trigger task,
// which passes the AI-label gate and distributes (Ayrshare fan-out or semi-manual post rows).
import { NextResponse } from "next/server";
import { tasks } from "@trigger.dev/sdk/v3";
import type { scheduleApprovedCreative } from "@/src/trigger/content-factory";
import { withTriggerAuth } from "@/src/lib/triggerAuth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { creativeId?: string; caption?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const creativeId = body.creativeId;
  if (!creativeId) {
    return NextResponse.json({ error: "creativeId is required" }, { status: 400 });
  }
  try {
    const handle = await withTriggerAuth(() =>
      tasks.trigger<typeof scheduleApprovedCreative>("schedule-approved-creative", {
        creativeId,
        ...(body.caption !== undefined ? { caption: body.caption } : {}),
      }),
    );
    if (!handle) {
      // Approval still succeeds in Convex; distribution is deferred until Trigger is configured.
      return NextResponse.json(
        { ok: false, deferred: true, reason: "trigger not configured (project key unavailable to server)" },
        { status: 202 },
      );
    }
    return NextResponse.json({ ok: true, runId: handle.id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "trigger failed" },
      { status: 500 },
    );
  }
}
