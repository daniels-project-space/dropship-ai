// POST /api/approvals/resolve — resolve the persisted Trigger waitpoint. The task, not this
// browser-facing endpoint, performs the Convex approval transition.
import { NextResponse } from "next/server";
import { wait } from "@trigger.dev/sdk/v3";
import { requireOperator } from "@/src/lib/auth/server";
import { convexClient, api } from "@/src/lib/convexClient";
import type { Id } from "@/convex/_generated/dataModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guard = await requireOperator(request);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  let body: { actionId?: unknown; approved?: unknown; reason?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.actionId !== "string" || typeof body.approved !== "boolean" || (body.reason !== undefined && typeof body.reason !== "string")) {
    return NextResponse.json({ error: "actionId and approved are required" }, { status: 400 });
  }
  if (!process.env.TRIGGER_SECRET_KEY && !process.env.TRIGGER_ACCESS_TOKEN) {
    return NextResponse.json({ error: "approval waitpoint is not configured" }, { status: 503 });
  }
  try {
    const action = await convexClient().query(api.actions.get, { actionId: body.actionId as Id<"actions"> });
    if (!action || action.status !== "pending_approval" || action.riskTier !== "human_gated" || !action.waitpointToken) {
      return NextResponse.json({ error: "action is not awaiting a durable approval waitpoint" }, { status: 409 });
    }
    await wait.completeToken(action.waitpointToken, { approved: body.approved, approver: "Daniel", reason: body.reason });
    return NextResponse.json({ ok: true, actionId: action._id, status: "resolution_requested" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "approval resolution failed" }, { status: 502 });
  }
}
