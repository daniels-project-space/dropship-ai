// POST /api/shopify/import-draft — create exactly one Shopify DRAFT from an approved sourced
// candidate. It never creates ACTIVE products, variants, orders, or supplier requests.
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireOperator } from "@/src/lib/auth/server";
import { convexClient, api } from "@/src/lib/convexClient";
import { resolveShopifyConfig } from "@/src/lib/shopifyAuth";
import { productCreate } from "@/src/lib/shopify";
import { executeApprovedShopifyDraftImport } from "@/src/lib/shopifyDraftImportExecutor";
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
  const result = await executeApprovedShopifyDraftImport({
    // All configuration and input reads happen before reservation. These failures cannot have
    // crossed Shopify's provider boundary.
    preflight: async () => {
      const product = await convex.query(api.products.get, { productId });
      if (!product || product.siteId !== siteId) throw new Error("product was not found for this site");
      return { product, config: await resolveShopifyConfig(siteId) };
    },
    reserve: () => convex.mutation(api.products.reserveApprovedShopifyDraftImport, { siteId, productId, actionId, traceId }),
    createDraft: (config, product) => productCreate(config, { title: product.title }),
    complete: async (shopifyProductId, shopifyVariantId) => {
      await convex.mutation(api.products.completeApprovedShopifyDraftImport, { siteId, productId, actionId, traceId, shopifyProductId, shopifyVariantId });
    },
    markAmbiguous: async (error) => {
      await convex.mutation(api.products.markApprovedShopifyDraftImportAmbiguous, { siteId, productId, actionId, traceId, error });
    },
  });
  return NextResponse.json({ ...result, published: false }, { status: result.ok ? 200 : 409 });
}
