// POST /api/shopify/import-draft — create exactly one Shopify DRAFT from an approved sourced
// candidate. It never creates ACTIVE products, variants, orders, or supplier requests.
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireOperator } from "@/src/lib/auth/server";
import { convexClient, api } from "@/src/lib/convexClient";
import { resolveShopifyConfig } from "@/src/lib/shopifyAuth";
import { productCreate } from "@/src/lib/shopify";
import type { Id } from "@/convex/_generated/dataModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guard = await requireOperator(request);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  let body: { siteId?: unknown; productId?: unknown; actionId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.siteId !== "string" || typeof body.productId !== "string" || typeof body.actionId !== "string") {
    return NextResponse.json({ error: "siteId, productId, and actionId are required" }, { status: 400 });
  }
  const siteId = body.siteId as Id<"sites">;
  const productId = body.productId as Id<"products">;
  const actionId = body.actionId as Id<"actions">;
  const traceId = randomUUID();
  const convex = convexClient();
  try {
    const reserved = await convex.mutation(api.products.reserveApprovedShopifyDraftImport, { siteId, productId, actionId, traceId });
    if (reserved.status === "already_created") return NextResponse.json({ ok: true, reused: true, shopifyProductId: reserved.shopifyProductId, published: false });
    const product = await convex.query(api.products.get, { productId });
    if (!product || product.siteId !== siteId) throw new Error("product was not found for this site");
    const created = await productCreate(await resolveShopifyConfig(body.siteId), { title: product.title });
    await convex.mutation(api.products.completeApprovedShopifyDraftImport, {
      siteId, productId, actionId, traceId, shopifyProductId: created.id,
    });
    return NextResponse.json({ ok: true, shopifyProductId: created.id, title: created.title, status: "DRAFT", published: false });
  } catch (error) {
    // Once a provider request was reserved, never retry it automatically: Shopify may have
    // created the draft just before an ambiguous network failure.
    try {
      await convex.mutation(api.products.markApprovedShopifyDraftImportAmbiguous, {
        siteId, productId, actionId, traceId, error: error instanceof Error ? error.message : "Shopify draft import failed",
      });
    } catch {
      // A reservation failure has no provider side effect; preserve its original error.
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Shopify draft import failed", reconcileRequired: true }, { status: 409 });
  }
}
