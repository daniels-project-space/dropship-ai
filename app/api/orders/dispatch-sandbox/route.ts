// POST /api/orders/dispatch-sandbox — explicitly enqueue one already-approved CJ sandbox action.
// The Trigger payload carries only the action id; immutable customer input stays in Convex until
// the worker has atomically reserved it.
import { NextResponse } from "next/server";
import { tasks } from "@trigger.dev/sdk/v3";
import type { fulfillOrder } from "@/src/trigger/fulfillment";
import { requireOperator } from "@/src/lib/auth/server";
import { convexClient, api } from "@/src/lib/convexClient";
import type { Id } from "@/convex/_generated/dataModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guard = await requireOperator(request);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  let body: { actionId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.actionId !== "string" || !body.actionId.trim()) return NextResponse.json({ error: "actionId is required" }, { status: 400 });
  if (!process.env.TRIGGER_SECRET_KEY) return NextResponse.json({ error: "sandbox dispatch is unavailable until the Trigger runtime is configured" }, { status: 503 });
  try {
    const actionId = body.actionId.trim() as Id<"actions">;
    const action = await convexClient().query(api.actions.get, { actionId });
    if (!action || action.type !== "dispatch_cj_sandbox_order" || action.status !== "approved") {
      return NextResponse.json({ error: "an approved CJ sandbox-dispatch action is required" }, { status: 409 });
    }
    const handle = await tasks.trigger<typeof fulfillOrder>("fulfill-order", { actionId: body.actionId.trim() }, {
      idempotencyKey: `cj-sandbox-dispatch:${body.actionId.trim()}`,
      idempotencyKeyTTL: "24w",
    });
    return NextResponse.json({ ok: true, mode: "sandbox", actionId: body.actionId.trim(), runId: handle.id, isSandbox: 1, payType: 3, zeroCharge: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "sandbox dispatch could not be enqueued" }, { status: 502 });
  }
}
