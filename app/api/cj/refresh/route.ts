// POST /api/cj/refresh — refresh CJ catalogue facts (product, variants, and inventory) without
// writing to CJ, Shopify, or Convex. The caller can use this evidence to request a sourced draft.
import { NextResponse } from "next/server";
import { getInventoryByProduct, getInventoryByVariant, getProduct, getVariant, getVariants } from "@/src/lib/cj";
import { requireOperator } from "@/src/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guard = await requireOperator(request);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  let body: { productId?: unknown; variantId?: unknown; countryCode?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.productId !== "string" || !body.productId.trim()) return NextResponse.json({ error: "productId is required" }, { status: 400 });
  if (body.variantId !== undefined && (typeof body.variantId !== "string" || !body.variantId.trim())) return NextResponse.json({ error: "variantId must be a non-empty string" }, { status: 400 });
  if (body.countryCode !== undefined && (typeof body.countryCode !== "string" || !/^[A-Za-z]{2}$/.test(body.countryCode))) return NextResponse.json({ error: "countryCode must be a two-letter code" }, { status: 400 });
  try {
    const productId = body.productId.trim();
    const variantId = typeof body.variantId === "string" ? body.variantId.trim() : undefined;
    const [product, variants, inventory, variant, variantInventory] = await Promise.all([
      getProduct(productId),
      getVariants(productId, typeof body.countryCode === "string" ? body.countryCode.toUpperCase() : undefined),
      getInventoryByProduct(productId),
      variantId ? getVariant(variantId) : Promise.resolve(undefined),
      variantId ? getInventoryByVariant(variantId) : Promise.resolve(undefined),
    ]);
    return NextResponse.json({ refreshedAt: Date.now(), product, variants, inventory, variant, variantInventory });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "CJ refresh failed" }, { status: 502 });
  }
}
