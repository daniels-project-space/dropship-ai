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
import { assertShopifyIdentity, vaultRefForDomain } from "@/src/lib/shopifyIdentity";
import { parseShopifyConnectRequest } from "@/src/lib/shopifyConnectRequest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guard = await requireOperator(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const body = parseShopifyConnectRequest(rawBody);
  if (!body) return NextResponse.json({ error: "invalid Shopify connect request" }, { status: 400 });
  const { siteId, shopifyDomain, accessToken } = body;

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
    const message = err instanceof Error ? err.message : "failed to persist connection";
    const conflict = /cannot be changed|already connected|already bound|ambiguous/.test(message);
    return NextResponse.json(
      { error: message },
      { status: conflict ? 409 : 500 },
    );
  }

  // Initial sync uses the already-proved vault value, not a one-time request-token bypass.
  try {
    const cfg = { shop: shopifyDomain, accessToken: durableToken };
    const result = await syncShopify(siteId, cfg, { sinceDays: 60 });
    if (result.economicsSync === "incomplete") {
      return NextResponse.json({
        ok: true,
        connected: true,
        recurringAccess: "verified",
        economicsSync: "incomplete",
        shop: { name: shop.name, domain: shop.myshopifyDomain },
        currency: shop.currencyCode,
        productCount: result.productCount,
        orderCount: result.orderCount,
        syncError: "Shopify pagination exceeded the bounded sync cap; economics remain not launch-ready",
      }, { status: 207 });
    }
    return NextResponse.json({
      ok: true,
      shop: { name: shop.name, domain: shop.myshopifyDomain },
      currency: shop.currencyCode,
      productCount: result.productCount,
      orderCount: result.orderCount,
      lastSyncedAt: result.lastSyncedAt,
      recurringAccess: "verified",
      economicsSync: result.economicsSync,
    });
  } catch (err) {
    // Connection persisted but sync failed — surface it so the operator can retry "Sync now".
    return NextResponse.json(
      {
        ok: true,
        connected: true,
        recurringAccess: "verified",
        economicsSync: "failed",
        shop: { name: shop.name, domain: shop.myshopifyDomain },
        currency: shop.currencyCode,
        syncError: err instanceof Error ? err.message : "initial sync failed",
      },
      { status: 207 },
    );
  }
}
