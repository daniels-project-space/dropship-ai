import { NextResponse } from "next/server";
import { operatorJwk } from "@/src/lib/auth/jwt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public verification material only; it cannot mint sessions or JWTs. */
export async function GET() {
  try {
    return NextResponse.json({ keys: [operatorJwk()] }, { headers: { "Cache-Control": "public, max-age=300" } });
  } catch {
    return NextResponse.json({ error: "authentication signing is not configured" }, { status: 503 });
  }
}
