import { NextResponse } from "next/server";
import { OPERATOR_SESSION_COOKIE } from "@/src/lib/auth/session";
import { requireOperator } from "@/src/lib/auth/server";

export async function POST(request: Request) {
  const guard = await requireOperator(request);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(OPERATOR_SESSION_COOKIE);
  return response;
}
