import { NextResponse, type NextRequest } from "next/server";
import { OPERATOR_SESSION_COOKIE, verifyOperatorSession } from "@/src/lib/auth/session";

const PUBLIC_API_PREFIXES = ["/api/auth/login", "/api/auth/jwks", "/api/auth/token", "/api/webhooks/"];

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (pathname === "/login" || PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return NextResponse.next();
  const secret = process.env.DROPSHIP_AI_SESSION_SECRET;
  const session = request.cookies.get(OPERATOR_SESSION_COOKIE)?.value;
  if (secret && await verifyOperatorSession(session, secret)) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "authentication required" }, { status: 401 });
  const url = new URL("/login", request.url);
  url.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"] };
