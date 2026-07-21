// POST /api/cj/connect — exchange an operator-supplied CJ authorization code server-side.
// The returned credential pair is atomically persisted by the scoped control-plane writer and
// never appears in this response, Convex, Trigger, audit data, or browser state.
import { NextResponse } from "next/server";
import { requireOperator } from "@/src/lib/auth/server";
import { persistAuthorizationCodeExchange } from "@/src/lib/cj";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guard = await requireOperator(request);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  let body: { authorizationCode?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.authorizationCode !== "string" || !body.authorizationCode.trim()) {
    return NextResponse.json({ error: "authorizationCode is required" }, { status: 400 });
  }
  try {
    await persistAuthorizationCodeExchange(body.authorizationCode.trim());
    return NextResponse.json({ connected: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "CJ authorization-code exchange failed" }, { status: 502 });
  }
}
