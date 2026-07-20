import { timingSafeEqual } from "node:crypto";
import { OPERATOR_SESSION_COOKIE, verifyOperatorSession } from "./session";

type Guard = { ok: true } | { ok: false; status: 401 | 403; error: string };

function cookieValue(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  return header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function operatorPassphraseMatches(candidate: unknown): boolean {
  const expected = process.env.DROPSHIP_AI_OPERATOR_TOKEN;
  if (!expected || typeof candidate !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function requireOperator(request: Request, options: { csrf?: boolean } = {}): Promise<Guard> {
  const secret = process.env.DROPSHIP_AI_SESSION_SECRET;
  const session = cookieValue(request.headers.get("cookie"), OPERATOR_SESSION_COOKIE);
  if (!secret || !(await verifyOperatorSession(session, secret))) {
    return { ok: false, status: 401, error: "authentication required" };
  }
  if (options.csrf !== false && !["GET", "HEAD", "OPTIONS"].includes(request.method) && !sameOrigin(request)) {
    return { ok: false, status: 403, error: "cross-site request denied" };
  }
  return { ok: true };
}
