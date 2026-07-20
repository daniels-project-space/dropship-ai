import { NextResponse } from "next/server";
import { createOperatorSession, OPERATOR_SESSION_COOKIE } from "@/src/lib/auth/session";
import { operatorPassphraseMatches } from "@/src/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { operatorToken?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!operatorPassphraseMatches(body.operatorToken)) {
    return NextResponse.json({ error: "invalid operator credentials" }, { status: 401 });
  }
  const secret = process.env.DROPSHIP_AI_SESSION_SECRET;
  if (!secret) return NextResponse.json({ error: "authentication is not configured" }, { status: 503 });

  const response = NextResponse.json({ ok: true });
  response.cookies.set(OPERATOR_SESSION_COOKIE, await createOperatorSession(secret), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 8 * 60 * 60,
    priority: "high",
  });
  return response;
}
