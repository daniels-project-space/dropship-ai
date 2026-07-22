import { NextResponse } from "next/server";
import { mintOperatorJwt } from "@/src/lib/auth/jwt";
import { requireOperator } from "@/src/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const guard = await requireOperator(request, { csrf: false });
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  try {
    return NextResponse.json({ token: mintOperatorJwt() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "authentication signing is not configured" }, { status: 503 });
  }
}
