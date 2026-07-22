// POST /api/cj/refresh — read CJ catalogue facts, parse and persist their decision-relevant
// lineage in Convex. It never writes to CJ or Shopify.
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getInventoryByProduct, getInventoryByVariant, getProduct, getVariant, getVariants } from "@/src/lib/cj";
import { requireOperator } from "@/src/lib/auth/server";
import { parseCjEvidence } from "@/src/lib/cjEvidence";
import { convexClient, api } from "@/src/lib/convexClient";
import type { Id } from "@/convex/_generated/dataModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guard = await requireOperator(request);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  let body: { siteId?: unknown; productId?: unknown; variantId?: unknown; countryCode?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.siteId !== "string" || !body.siteId.trim()) return NextResponse.json({ error: "siteId is required" }, { status: 400 });
  if (typeof body.productId !== "string" || !body.productId.trim()) return NextResponse.json({ error: "productId is required" }, { status: 400 });
  if (typeof body.variantId !== "string" || !body.variantId.trim()) return NextResponse.json({ error: "variantId is required" }, { status: 400 });
  if (body.countryCode !== undefined && (typeof body.countryCode !== "string" || !/^[A-Za-z]{2}$/.test(body.countryCode))) return NextResponse.json({ error: "countryCode must be a two-letter code" }, { status: 400 });
  try {
    const productId = body.productId.trim();
    const variantId = body.variantId.trim();
    const [product, variants, inventory, variant, variantInventory] = await Promise.all([
      getProduct(productId),
      getVariants(productId, typeof body.countryCode === "string" ? body.countryCode.toUpperCase() : undefined),
      getInventoryByProduct(productId),
      getVariant(variantId),
      getInventoryByVariant(variantId),
    ]);
    const readAt = Date.now();
    const evidence = parseCjEvidence({ productId, variantId, product, variants, inventory, variant, variantInventory });
    const persisted = await convexClient().mutation(api.products.recordCjEvidence, {
      siteId: body.siteId.trim() as Id<"sites">,
      ...evidence,
      traceId: randomUUID(),
      readAt,
    });
    return NextResponse.json({ refreshedAt: readAt, evidence: { ...evidence, evidenceId: persisted.evidenceId, traceId: persisted.traceId } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "CJ refresh failed" }, { status: 502 });
  }
}
