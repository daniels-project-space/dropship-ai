// Server-only route: enqueue the content-factory Trigger task from the Creative Studio UI.
// Uses the Trigger SDK's tasks.trigger (no client bundle leakage; runs in the Node runtime).
//
// Auth: this is an internal operator console. The route resolves the project-scoped Trigger
// key from the server environment or vault, and returns 503 when neither is available.
import { NextResponse } from "next/server";
import { tasks } from "@trigger.dev/sdk/v3";
import type { contentFactory } from "@/src/trigger/content-factory";
import { withTriggerAuth } from "@/src/lib/triggerAuth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { siteId?: string; productId?: string; variants?: number; scenePrompt?: string; hooks?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const siteId = body.siteId;
  if (!siteId) {
    return NextResponse.json({ error: "siteId is required" }, { status: 400 });
  }
  try {
    const handle = await withTriggerAuth(() =>
      tasks.trigger<typeof contentFactory>("content-factory", {
        siteId,
        variants: body.variants ?? 3,
        ...(body.productId !== undefined ? { productId: body.productId } : {}),
        ...(body.scenePrompt !== undefined ? { scenePrompt: body.scenePrompt } : {}),
        ...(body.hooks !== undefined ? { hooks: body.hooks } : {}),
      }),
    );
    if (!handle) {
      return NextResponse.json(
        { error: "trigger not configured (project key unavailable to server)" },
        { status: 503 },
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
