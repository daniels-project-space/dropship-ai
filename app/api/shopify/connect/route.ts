// POST /api/shopify/connect — first recurring-access connection. The site is unchanged until the
// submitted token validates the store and the deterministic vault reference resolves to the same
// token. One Convex mutation then stores identity, USD currency, verification time, and reference.
import { NextResponse } from "next/server";
import { getShop } from "@/src/lib/shopify";
import { verifyShopifyVaultToken } from "@/src/lib/shopifyAuth";
import { syncShopify } from "@/src/lib/shopifySync";
import { convexClient, api } from "@/src/lib/convexClient";
import type { Id } from "@/convex/_generated/dataModel";
import { requireOperator } from "@/src/lib/auth/server";
import { assertShopifyIdentity, isMyshopifyDomain, normalizeShopifyDomain, vaultRefForDomain } from "@/src/lib/shopifyIdentity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guard = await requireOperator(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  let body: { siteId?: string; shopifyDomain?: string; accessToken?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { siteId, accessToken } = body;
  if (!siteId || !body.shopifyDomain || !accessToken) {
    return NextResponse.json(
      { error: "siteId, shopifyDomain and accessToken are all required" },
      { status: 400 },
    );
  }
  const shopifyDomain = normalizeShopifyDomain(body.shopifyDomain);
  if (!isMyshopifyDomain(shopifyDomain)) {
    return NextResponse.json(
      { error: "shopifyDomain must be a *.myshopify.com domain" },
      { status: 400 },
    );
  }

  // 1. Validate the token against the live store.
  let shop;
  try {
    shop = await getShop({ shop: shopifyDomain, accessToken });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Shopify token validation failed" },
      { status: 400 },
    );
  }
  try {
    assertShopifyIdentity(shopifyDomain, shop.myshopifyDomain, shop.currencyCode);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Shopify identity verification failed" }, { status: shop.currencyCode === "USD" ? 400 : 409 });
  }

  // A successful one-time provider read is not a recurring connection. Resolve the exact
  // deterministic reference first and compare fixed-size token digests in constant time.
  const durableToken = await verifyShopifyVaultToken(shopifyDomain, accessToken);
  if (!durableToken) {
    return NextResponse.json({
      connected: false,
      state: "vault_setup_required",
      error: `Recurring access is not configured. Store the same token at ${vaultRefForDomain(shopifyDomain)} and retry; the site was not changed.`,
    }, { status: 409 });
  }

  const convex = convexClient();
  const sid = siteId as Id<"sites">;

  // Identity/currency/reference are one transaction. The token value never enters Convex.
  try {
    await convex.mutation(api.sites.connectStore, { siteId: sid, shopifyDomain, storeCurrency: shop.currencyCode });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed to persist connection" },
      { status: 500 },
    );
  }

  // Initial sync uses the already-proved vault value, not a one-time request-token bypass.
  try {
    const cfg = { shop: shopifyDomain, accessToken: durableToken };
    const result = await syncShopify(siteId, cfg, { sinceDays: 60 });
    return NextResponse.json({
      ok: true,
      shop: { name: shop.name, domain: shop.myshopifyDomain },
      currency: shop.currencyCode,
      productCount: result.productCount,
      orderCount: result.orderCount,
      lastSyncedAt: result.lastSyncedAt,
      recurringAccess: "verified",
    });
  } catch (err) {
    // Connection persisted but sync failed — surface it so the operator can retry "Sync now".
    return NextResponse.json(
      {
        ok: true,
        connected: true,
        recurringAccess: "verified",
        shop: { name: shop.name, domain: shop.myshopifyDomain },
        currency: shop.currencyCode,
        syncError: err instanceof Error ? err.message : "initial sync failed",
      },
      { status: 207 },
    );
  }
}
