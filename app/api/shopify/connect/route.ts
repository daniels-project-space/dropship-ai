// POST /api/shopify/connect — first-connect flow (Phase 2a, read-only).
//  Body: { siteId, shopifyDomain, accessToken }
//  1. Validate the token by fetching the shop (getShop throws on a bad/under-scoped token).
//  2. Persist site.shopifyDomain + flip the site real (sites.connectStore) and register the
//     siteSecrets vaultRef pointer ("shopify/<KEY>") so recurring syncs can find the token.
//  3. Run an initial read-only sync (products + last-60d orders) using the request token directly.
//  Returns { shop, productCount, orderCount, currency }.
//
// The access token is used from the request for THIS call only. For recurring sync the operator
// must store the same token in the vault: service "shopify", key = derived from the domain
// (e.g. calm-collar.myshopify.com → "CALM_COLLAR"). See vaultRefForDomain().
import { NextResponse } from "next/server";
import { getShop } from "@/src/lib/shopify";
import { resolveShopifyConfig, vaultRefForDomain, SHOPIFY_TOKEN_KEY } from "@/src/lib/shopifyAuth";
import { syncShopify } from "@/src/lib/shopifySync";
import { convexClient, api } from "@/src/lib/convexClient";
import type { Id } from "@/convex/_generated/dataModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeDomain(raw: string): string {
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return d;
}

export async function POST(req: Request) {
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
  const shopifyDomain = normalizeDomain(body.shopifyDomain);
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopifyDomain)) {
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

  const convex = convexClient();
  const sid = siteId as Id<"sites">;

  // 2. Persist connection state + the vaultRef pointer (NOT the token value).
  try {
    await convex.mutation(api.sites.connectStore, { siteId: sid, shopifyDomain });
    await convex.mutation(api.siteSecrets.upsertRef, {
      siteId: sid,
      key: SHOPIFY_TOKEN_KEY,
      vaultRef: vaultRefForDomain(shopifyDomain),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed to persist connection" },
      { status: 500 },
    );
  }

  // 3. Initial read-only sync using the request token (override — vault not required yet).
  try {
    const cfg = await resolveShopifyConfig(siteId, accessToken);
    const result = await syncShopify(siteId, cfg, { sinceDays: 60 });
    return NextResponse.json({
      ok: true,
      shop: { name: shop.name, domain: shop.myshopifyDomain },
      currency: shop.currencyCode,
      productCount: result.productCount,
      orderCount: result.orderCount,
      lastSyncedAt: result.lastSyncedAt,
      vaultRef: vaultRefForDomain(shopifyDomain),
    });
  } catch (err) {
    // Connection persisted but sync failed — surface it so the operator can retry "Sync now".
    return NextResponse.json(
      {
        ok: true,
        connected: true,
        shop: { name: shop.name, domain: shop.myshopifyDomain },
        currency: shop.currencyCode,
        syncError: err instanceof Error ? err.message : "initial sync failed",
      },
      { status: 207 },
    );
  }
}
