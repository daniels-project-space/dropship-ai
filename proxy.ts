import { NextResponse, type NextRequest } from "next/server";
import { OPERATOR_SESSION_COOKIE } from "@/src/lib/auth/session";

const PUBLIC_API_PREFIXES = ["/api/auth/login", "/api/auth/jwks", "/api/auth/token", "/api/webhooks/"];

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (pathname === "/login" || PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return NextResponse.next();
  if (request.cookies.has(OPERATOR_SESSION_COOKIE)) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "authentication required" }, { status: 401 });
  const url = new URL("/login", request.url);
  url.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"] };
