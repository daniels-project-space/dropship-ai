// POST /api/cj/connect — independent-account API-key setup. The API key is used only for CJ's
// official token endpoint; the returned openId/token bundle is atomically persisted by the
// scoped control-plane writer and never appears in browser, Convex, Trigger, audit, or log data.
import { NextResponse } from "next/server";
import { requireOperator } from "@/src/lib/auth/server";
import { persistIndependentAccountConnection } from "@/src/lib/cj";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guard = await requireOperator(request);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  let body: { apiKey?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.apiKey !== "string" || !body.apiKey.trim() || body.apiKey.length > 200) {
    return NextResponse.json({ error: "apiKey is required and must be at most 200 characters" }, { status: 400 });
  }
  try {
    await persistIndependentAccountConnection(body.apiKey.trim());
    return NextResponse.json({ connected: true });
  } catch {
    // Provider and writer errors are deliberately not reflected: either could echo identity or
    // credential material. The operator gets a stable state and can inspect redacted telemetry.
    return NextResponse.json({ connected: false, state: "credential_bundle_not_persisted", error: "CJ connection failed before a complete durable credential bundle was confirmed" }, { status: 502 });
  }
}
