// Read-only Shopify → Convex sync (Phase 2a). Pulls products + last-60-day orders via the Admin
// GraphQL API and idempotently upserts them into Convex as REAL (sample:false) rows. NO fulfillment
// / CJ side effects — this only mirrors store state so the dashboard shows real numbers.
//
// Maps:
//   Shopify product.status (ACTIVE|ARCHIVED|DRAFT) → products enum (active|archived|draft).
//   Shopify displayFulfillmentStatus              → orders enum (received|shipped|...).
import { convexClient, api } from "./convexClient";
import { randomUUID } from "node:crypto";
import { getShop, listProductsWithCoverage, listOrdersWithCoverage, type ShopifyClientConfig } from "./shopify";
import type { Id } from "../../convex/_generated/dataModel";
import { assertShopifyIdentity, normalizeShopifyDomain } from "./shopifyIdentity";
import { SHOPIFY_ECONOMICS_CANONICAL_SINCE_DAYS } from "./shopifySyncState";

type ProductStatus = "draft" | "active" | "archived";
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

type Fulfillment = "received" | "shipped";
function mapFulfillment(displayStatus: string): Fulfillment {
  return displayStatus.toUpperCase() === "FULFILLED" ? "shipped" : "received";
}

export interface SyncResult {
  productCount: number;
  orderCount: number;
  lastSyncedAt: number;
  economicsSync: "current" | "incomplete";
}

export function boundedShopifySinceDays(value: number): number {
  if (!Number.isFinite(value)) throw new Error("invalid Shopify sync coverage window");
  return Math.min(Math.max(Math.trunc(value), 1), SHOPIFY_ECONOMICS_CANONICAL_SINCE_DAYS);
}

type ShopifySyncDependencies = {
  client?: ReturnType<typeof convexClient>;
  createAttemptId?: () => string;
  readShop?: typeof getShop;
  readProducts?: typeof listProductsWithCoverage;
  readOrders?: typeof listOrdersWithCoverage;
};

/** Run the read-only products+orders sync after durably recording the attempt. */
export async function syncShopify(
  siteId: string,
  config: ShopifyClientConfig | (() => Promise<ShopifyClientConfig>),
  { sinceDays = 60 }: { sinceDays?: number } = {},
  dependencies: ShopifySyncDependencies = {},
): Promise<SyncResult> {
  const convex = dependencies.client ?? convexClient();
  const sid = siteId as Id<"sites">;
  const boundedSinceDays = boundedShopifySinceDays(sinceDays);

  const attemptId = (dependencies.createAttemptId ?? randomUUID)();
  const attempt = await convex.mutation(api.sites.beginEconomicsSync, {
    siteId: sid, attemptId, sinceDays: boundedSinceDays,
  });
  let observedProductCount = 0;
  let observedOrderCount = 0;

  try {
    // Resolve recurring vault access only after the durable attempt begins, so missing/failed
    // credential resolution is visible as a failed latest attempt too.
    const cfg = typeof config === "function" ? await config() : config;
    // Identity is a prerequisite read, but it is not economics success. Any failure after the
    // durable attempt begins records a failed latest attempt without erasing prior success.
    const shop = await (dependencies.readShop ?? getShop)(cfg);
    assertShopifyIdentity(cfg.shop, shop.myshopifyDomain, shop.currencyCode);
    await convex.mutation(api.sites.verifyConnectedStore, {
      siteId: sid,
      shopifyDomain: normalizeShopifyDomain(cfg.shop),
      storeCurrency: shop.currencyCode,
    });

    const [productRead, orderRead] = await Promise.all([
      (dependencies.readProducts ?? listProductsWithCoverage)(cfg, { limit: 250 }),
      (dependencies.readOrders ?? listOrdersWithCoverage)(cfg, { createdAtMin: attempt.orderCutoffAt, limit: 250 }),
    ]);
    const products = productRead.items;
    const orders = orderRead.items;
    observedProductCount = products.length;
    observedOrderCount = orders.length;

    // No mirror mutation is reachable until both reads prove complete canonical coverage.
    if (!productRead.complete || !orderRead.complete || boundedSinceDays !== SHOPIFY_ECONOMICS_CANONICAL_SINCE_DAYS) {
      const incomplete = await convex.mutation(api.sites.markEconomicsSyncNotCurrent, {
        siteId: sid, attemptId, status: "incomplete",
        reason: boundedSinceDays !== SHOPIFY_ECONOMICS_CANONICAL_SINCE_DAYS
          ? "noncanonical_window"
          : !productRead.complete ? "product_truncation" : "order_truncation",
      });
      return {
        productCount: products.length,
        orderCount: orders.length,
        lastSyncedAt: incomplete.finishedAt,
        economicsSync: "incomplete",
      };
    }

    const committed = await convex.mutation(api.sites.commitEconomicsSnapshot, {
      siteId: sid,
      attemptId,
      products: products.map((p) => ({
        shopifyProductId: p.id, title: p.title, priceUsd: p.priceUsd,
        status: mapProductStatus(p.status), imageUrl: p.imageUrl ?? undefined,
      })),
      orders: orders.map((o) => ({
        shopifyOrderId: o.id, currencyCode: o.currencyCode, currentTotal: o.currentTotal,
        financialStatus: o.financialStatus, test: o.test, cancelled: o.cancelled,
        creditAdjustmentState: o.creditAdjustmentState,
        fulfillmentStatus: mapFulfillment(o.displayFulfillmentStatus), createdAt: o.createdAt,
      })),
    });
    return {
      productCount: committed.productCount,
      orderCount: committed.orderCount,
      lastSyncedAt: committed.finishedAt,
      economicsSync: committed.status,
    };
  } catch (error) {
    const marked = await convex.mutation(api.sites.markEconomicsSyncNotCurrent, {
      siteId: sid, attemptId, status: "failed", reason: "provider_or_commit_failure",
    });
    if (marked.attemptMatched && marked.status === "incomplete") {
      return {
        productCount: observedProductCount,
        orderCount: observedOrderCount,
        lastSyncedAt: marked.finishedAt,
        economicsSync: "incomplete",
      };
    }
    throw error;
  }
}
