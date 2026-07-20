// Server-only route: enqueue the content-factory Trigger task from the Creative Studio UI.
// Uses the Trigger SDK's tasks.trigger (no client bundle leakage; runs in the Node runtime).
//
// Auth: this is an internal operator console. The route requires TRIGGER_SECRET_KEY (or
// TRIGGER_ACCESS_TOKEN) to be present in the server env to actually enqueue; if absent it
// returns a 503 with a clear note rather than failing opaquely.
import { NextResponse } from "next/server";
import { tasks } from "@trigger.dev/sdk/v3";
import type { contentFactory } from "@/src/trigger/content-factory";
import { requireOperator } from "@/src/lib/auth/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const guard = await requireOperator(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  let body: { siteId?: string; productId?: string; variants?: number; scenePrompt?: string; hooks?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.siteId) {
    return NextResponse.json({ error: "siteId is required" }, { status: 400 });
  }
  if (!process.env.TRIGGER_SECRET_KEY && !process.env.TRIGGER_ACCESS_TOKEN) {
    return NextResponse.json(
      { error: "trigger not configured (TRIGGER_SECRET_KEY missing on server)" },
      { status: 503 },
    );
  }

  try {
    const handle = await tasks.trigger<typeof contentFactory>("content-factory", {
      siteId: body.siteId,
      productId: body.productId,
      variants: body.variants ?? 3,
      scenePrompt: body.scenePrompt,
      hooks: body.hooks,
    });
    return NextResponse.json({ ok: true, runId: handle.id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "trigger failed" },
      { status: 500 },
    );
  }
}
