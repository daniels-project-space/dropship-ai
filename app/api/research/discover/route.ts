// POST /api/research/discover — server-only market-evidence search. It never creates a catalog
// record; the separate sourced-draft mutation enforces verified economics before local write.
import { NextResponse } from "next/server";
import { discoverProducts, type DiscoverySource } from "@/src/lib/discovery";
import { requireOperator } from "@/src/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guard = await requireOperator(request);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  let body: { query?: unknown; country?: unknown; limit?: unknown; sources?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.query !== "string" || !body.query.trim()) return NextResponse.json({ error: "query is required" }, { status: 400 });
  if (body.country !== undefined && (typeof body.country !== "string" || !/^[A-Za-z]{2}$/.test(body.country))) {
    return NextResponse.json({ error: "country must be a two-letter code" }, { status: 400 });
  }
  if (body.limit !== undefined && (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 50)) {
    return NextResponse.json({ error: "limit must be an integer between 1 and 50" }, { status: 400 });
  }
  const sources = body.sources === undefined ? undefined : Array.isArray(body.sources) && body.sources.every((source) => source === "kelkoo" || source === "jina")
    ? body.sources as DiscoverySource[]
    : null;
  if (sources === null) return NextResponse.json({ error: "sources must contain only kelkoo and/or jina" }, { status: 400 });
  try {
    return NextResponse.json(await discoverProducts({ query: body.query, country: body.country as string | undefined, limit: body.limit as number | undefined, sources }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "discovery failed" }, { status: 502 });
  }
}
