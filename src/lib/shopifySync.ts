// Read-only Shopify → Convex sync (Phase 2a). Pulls products + last-60-day orders via the Admin
// GraphQL API and idempotently upserts them into Convex as REAL (sample:false) rows. NO fulfillment
// / CJ side effects — this only mirrors store state so the dashboard shows real numbers.
//
// Maps:
//   Shopify product.status (ACTIVE|ARCHIVED|DRAFT) → products enum (active|archived|draft).
//   Shopify displayFulfillmentStatus              → orders enum (received|shipped|...).
import { convexClient, api } from "./convexClient";
import { getShop, listProducts, listOrders, type ShopifyClientConfig } from "./shopify";
import type { Id } from "../../convex/_generated/dataModel";
import { assertShopifyIdentity, normalizeShopifyDomain } from "./shopifyIdentity";

type ProductStatus = "draft" | "active" | "archived" | "killed";
function mapProductStatus(s: "ACTIVE" | "ARCHIVED" | "DRAFT"): ProductStatus {
  switch (s) {
    case "ACTIVE":
      return "active";
    case "ARCHIVED":
      return "archived";
    case "DRAFT":
    default:
      return "draft";
  }
}

type Fulfillment = "received" | "sent_to_cj" | "shipped" | "delivered" | "error";
function mapFulfillment(displayStatus: string): Fulfillment {
  return displayStatus.toUpperCase() === "FULFILLED" ? "shipped" : "received";
}

export interface SyncResult {
  productCount: number;
  orderCount: number;
  lastSyncedAt: number;
}

export function boundedShopifySinceDays(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 1), 60);
}

/** Run the read-only products+orders sync for a site using an already-resolved config. */
export async function syncShopify(
  siteId: string,
  cfg: ShopifyClientConfig,
  { sinceDays = 60 }: { sinceDays?: number } = {},
): Promise<SyncResult> {
  const convex = convexClient();
  const sid = siteId as Id<"sites">;
  const boundedSinceDays = boundedShopifySinceDays(sinceDays);

  // Identity/currency verification is deliberately first. A mismatch reaches no Convex writer,
  // while a legacy valid site gets currency + recurring-access proof before order economics.
  const shop = await getShop(cfg);
  assertShopifyIdentity(cfg.shop, shop.myshopifyDomain, shop.currencyCode);
  await convex.mutation(api.sites.verifyConnectedStore, {
    siteId: sid,
    shopifyDomain: normalizeShopifyDomain(cfg.shop),
    storeCurrency: shop.currencyCode,
  });

  const [products, orders] = await Promise.all([
    listProducts(cfg, { limit: 250 }),
    listOrders(cfg, { sinceDays: boundedSinceDays, limit: 250 }),
  ]);

  if (products.length) {
    await convex.mutation(api.products.upsertFromShopify, {
      siteId: sid,
      products: products.map((p) => ({
        shopifyProductId: p.id,
        title: p.title,
        priceUsd: p.priceUsd,
        status: mapProductStatus(p.status),
        imageUrl: p.imageUrl ?? undefined,
      })),
    });
  }

  if (orders.length) {
    await convex.mutation(api.orders.upsertFromShopify, {
      siteId: sid,
      orders: orders.map((o) => ({
        shopifyOrderId: o.id,
        currencyCode: o.currencyCode,
        currentTotal: o.currentTotal,
        financialStatus: o.financialStatus,
        test: o.test,
        cancelled: o.cancelled,
        creditAdjustmentState: o.creditAdjustmentState,
        fulfillmentStatus: mapFulfillment(o.displayFulfillmentStatus),
        createdAt: o.createdAt,
      })),
    });
  }

  return { productCount: products.length, orderCount: orders.length, lastSyncedAt: Date.now() };
}
