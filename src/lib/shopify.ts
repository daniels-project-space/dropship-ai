// Shopify Admin GraphQL client (API 2026-01). Thin typed wrapper — calls are stubbed/minimal
// but compile-clean. Token: vault per-site "SHOPIFY_ADMIN_TOKEN" or process.env fallback.
// NOTE: as of 2026-06-14 no "shopify" vault service exists — pass the token explicitly or set env.
import { assertLiveEffectsEnabled, sandboxShopAllowed } from "./effects";
const API_VERSION = "2026-01";

export interface ShopifyClientConfig {
  shop: string; // "<store>.myshopify.com"
  accessToken: string;
}

function endpoint(shop: string): string {
  return `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
}

export interface GraphQLResult<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export async function graphql<T = unknown>(
  cfg: ShopifyClientConfig,
  queryStr: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(endpoint(cfg.shop), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": cfg.accessToken,
    },
    body: JSON.stringify({ query: queryStr, variables: variables ?? {} }),
    cache: "no-store",
  });
  const json = (await res.json()) as GraphQLResult<T>;
  if (json.errors?.length) {
    throw new Error(`shopify graphql error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  return json.data as T;
}

// ── READ functions (Phase 2a — read-only store sync) ─────────────────────────

const SHOP_QUERY = /* GraphQL */ `
  query shop {
    shop { name myshopifyDomain currencyCode }
  }
`;

export interface ShopInfo {
  name: string;
  myshopifyDomain: string;
  currencyCode: string;
}

/** Fetch the store identity. Doubles as a token VALIDATOR — a bad token throws here. */
export async function getShop(cfg: ShopifyClientConfig): Promise<ShopInfo> {
  const data = await graphql<{ shop: ShopInfo }>(cfg, SHOP_QUERY);
  if (!data?.shop) throw new Error("shopify: shop query returned no data (token may lack read_products scope)");
  return data.shop;
}

const PRODUCTS_QUERY = /* GraphQL */ `
  query products($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        status
        featuredImage { url }
        variants(first: 1) { nodes { price } }
      }
    }
  }
`;

export interface ShopifyProduct {
  id: string; // GraphQL gid, e.g. "gid://shopify/Product/123"
  title: string;
  handle: string;
  status: "ACTIVE" | "ARCHIVED" | "DRAFT";
  imageUrl: string | null;
  priceUsd: number; // first variant price (0 when no variant/price)
}

/**
 * List products with cursor pagination up to `limit` (hard-capped at 250 to stay polite).
 * Pulls 50 per page. priceUsd is the first variant's price parsed to a number.
 */
export async function listProducts(
  cfg: ShopifyClientConfig,
  { limit = 250 }: { limit?: number } = {},
): Promise<ShopifyProduct[]> {
  const cap = Math.min(limit, 250);
  const out: ShopifyProduct[] = [];
  let after: string | null = null;
  while (out.length < cap) {
    const pageSize = Math.min(50, cap - out.length);
    const data: {
      products: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          title: string;
          handle: string;
          status: "ACTIVE" | "ARCHIVED" | "DRAFT";
          featuredImage: { url: string } | null;
          variants: { nodes: Array<{ price: string }> };
        }>;
      };
    } = await graphql(cfg, PRODUCTS_QUERY, { first: pageSize, after });
    for (const n of data.products.nodes) {
      out.push({
        id: n.id,
        title: n.title,
        handle: n.handle,
        status: n.status,
        imageUrl: n.featuredImage?.url ?? null,
        priceUsd: Number(n.variants.nodes[0]?.price ?? 0) || 0,
      });
    }
    if (!data.products.pageInfo.hasNextPage) break;
    after = data.products.pageInfo.endCursor;
    if (!after) break;
  }
  return out.slice(0, cap);
}

const ORDERS_QUERY = /* GraphQL */ `
  query orders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        createdAt
        displayFulfillmentStatus
        totalPriceSet { shopMoney { amount } }
        lineItems(first: 50) {
          nodes { quantity product { id } }
        }
      }
    }
  }
`;

export interface ShopifyOrderLine {
  productId: string | null;
  quantity: number;
}

export interface ShopifyOrder {
  id: string; // gid
  name: string; // "#1001"
  createdAt: number; // ms epoch
  displayFulfillmentStatus: string; // FULFILLED | UNFULFILLED | PARTIALLY_FULFILLED | ...
  totalUsd: number;
  lineItems: ShopifyOrderLine[];
}

/**
 * List orders created in the trailing `sinceDays` window (default 60). NOTE: the `read_orders`
 * scope only exposes the **last 60 days** of orders by default — older history needs Shopify's
 * `read_all_orders` protected scope (app approval). 60 days is the safe default. Cursor-paginated,
 * 50 per page, capped at 250 orders.
 */
export async function listOrders(
  cfg: ShopifyClientConfig,
  { sinceDays = 60, limit = 250 }: { sinceDays?: number; limit?: number } = {},
): Promise<ShopifyOrder[]> {
  const cap = Math.min(limit, 250);
  const sinceIso = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const queryFilter = `created_at:>=${sinceIso}`;
  const out: ShopifyOrder[] = [];
  let after: string | null = null;
  while (out.length < cap) {
    const pageSize = Math.min(50, cap - out.length);
    const data: {
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          name: string;
          createdAt: string;
          displayFulfillmentStatus: string;
          totalPriceSet: { shopMoney: { amount: string } };
          lineItems: { nodes: Array<{ quantity: number; product: { id: string } | null }> };
        }>;
      };
    } = await graphql(cfg, ORDERS_QUERY, { first: pageSize, after, query: queryFilter });
    for (const n of data.orders.nodes) {
      out.push({
        id: n.id,
        name: n.name,
        createdAt: Date.parse(n.createdAt),
        displayFulfillmentStatus: n.displayFulfillmentStatus,
        totalUsd: Number(n.totalPriceSet?.shopMoney?.amount ?? 0) || 0,
        lineItems: n.lineItems.nodes.map((li) => ({
          productId: li.product?.id ?? null,
          quantity: li.quantity,
        })),
      });
    }
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
    if (!after) break;
  }
  return out.slice(0, cap);
}

const PRODUCT_CREATE = /* GraphQL */ `
  mutation productCreate($input: ProductInput!) {
    productCreate(input: $input) {
      product { id title handle }
      userErrors { field message }
    }
  }
`;

export interface ProductCreateInput {
  title: string;
  descriptionHtml?: string;
  vendor?: string;
  status?: "ACTIVE" | "DRAFT";
}

export async function productCreate(
  cfg: ShopifyClientConfig,
  input: ProductCreateInput,
): Promise<{ id: string; title: string; handle: string }> {
  const data = await graphql<{
    productCreate: { product: { id: string; title: string; handle: string } | null; userErrors: Array<{ message: string }> };
  }>(cfg, PRODUCT_CREATE, { input });
  const { product, userErrors } = data.productCreate;
  if (userErrors.length || !product) {
    throw new Error(`productCreate failed: ${userErrors.map((e) => e.message).join("; ") || "no product"}`);
  }
  return product;
}

const PAGE_CREATE = /* GraphQL */ `
  mutation pageCreate($page: PageCreateInput!) {
    pageCreate(page: $page) {
      page { id title handle }
      userErrors { field message }
    }
  }
`;

export interface PageCreateInput {
  title: string;
  body?: string;
}

export async function pageCreate(
  cfg: ShopifyClientConfig,
  page: PageCreateInput,
): Promise<{ id: string; title: string; handle: string }> {
  const data = await graphql<{
    pageCreate: { page: { id: string; title: string; handle: string } | null; userErrors: Array<{ message: string }> };
  }>(cfg, PAGE_CREATE, { page });
  const { page: created, userErrors } = data.pageCreate;
  if (userErrors.length || !created) {
    throw new Error(`pageCreate failed: ${userErrors.map((e) => e.message).join("; ") || "no page"}`);
  }
  return created;
}

// ── Zero-charge sandbox checkout ────────────────────────────────────────────
// A draft is intentionally NOT completed and its invoice is never sent. It exercises the
// merchant's Draft Orders scope/checkout configuration without creating a payable order,
// reserving inventory, notifying a customer, or invoking fulfillment.
const DRAFT_ORDER_CREATE = /* GraphQL */ `
  mutation draftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id name invoiceUrl status totalPriceSet { shopMoney { amount currencyCode } } }
      userErrors { field message }
    }
  }
`;

export interface ZeroChargeDraftCheckoutInput {
  /** Stable caller-generated trace id. It is stored on the draft for manual reconciliation. */
  traceId: string;
}

export interface ZeroChargeDraftCheckout {
  id: string;
  name: string;
  invoiceUrl: string | null;
  totalAmount: string;
  currencyCode: string;
}

/**
 * Create a $0, non-shippable custom line item for a development-store checkout trace.
 * Never call draftOrderInvoiceSend or draftOrderComplete from this control plane: either action
 * turns this isolated trace into a customer/order side effect.
 */
export async function createZeroChargeDraftCheckout(
  cfg: ShopifyClientConfig,
  input: ZeroChargeDraftCheckoutInput,
): Promise<ZeroChargeDraftCheckout> {
  if (!input.traceId.trim()) throw new Error("shopify sandbox checkout: traceId is required");
  if (!sandboxShopAllowed(cfg.shop)) {
    throw new Error("shopify sandbox checkout is disabled or this shop is not allowlisted");
  }
  const data = await graphql<{
    draftOrderCreate: {
      draftOrder: {
        id: string;
        name: string;
        invoiceUrl: string | null;
        status: string;
        totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
      } | null;
      userErrors: Array<{ message: string }>;
    };
  }>(cfg, DRAFT_ORDER_CREATE, {
    input: {
      // A custom $0 line avoids inventory reservation and makes the no-charge property explicit.
      lineItems: [{
        title: "JARVIS sandbox checkout verification — no fulfillment",
        quantity: 1,
        originalUnitPrice: "0.00",
        requiresShipping: false,
        taxable: false,
      }],
      customAttributes: [
        { key: "jarvis_mode", value: "sandbox" },
        { key: "jarvis_trace_id", value: input.traceId },
        { key: "fulfillment", value: "disabled" },
      ],
      note: `JARVIS zero-charge sandbox trace ${input.traceId}. Do not invoice or complete.`,
      tags: ["jarvis-sandbox", "zero-charge", "do-not-complete"],
    },
  });
  const { draftOrder, userErrors } = data.draftOrderCreate;
  if (userErrors.length || !draftOrder) {
    throw new Error(`draftOrderCreate failed: ${userErrors.map((e) => e.message).join("; ") || "no draft order"}`);
  }
  if (Number(draftOrder.totalPriceSet.shopMoney.amount) !== 0) {
    throw new Error("sandbox checkout invariant failed: draft order total is not zero");
  }
  return {
    id: draftOrder.id,
    name: draftOrder.name,
    invoiceUrl: draftOrder.invoiceUrl,
    totalAmount: draftOrder.totalPriceSet.shopMoney.amount,
    currencyCode: draftOrder.totalPriceSet.shopMoney.currencyCode,
  };
}

const FULFILLMENT_TRACKING_UPDATE = /* GraphQL */ `
  mutation fulfillmentTrackingInfoUpdate($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!, $notifyCustomer: Boolean) {
    fulfillmentTrackingInfoUpdate(
      fulfillmentId: $fulfillmentId
      trackingInfoInput: $trackingInfoInput
      notifyCustomer: $notifyCustomer
    ) {
      fulfillment { id status }
      userErrors { field message }
    }
  }
`;

export interface TrackingInfo {
  number: string;
  url?: string;
  company?: string;
}

export async function fulfillmentTrackingInfoUpdate(
  cfg: ShopifyClientConfig,
  fulfillmentId: string,
  tracking: TrackingInfo,
  notifyCustomer = true,
): Promise<{ id: string; status: string }> {
  // Keep this provider mutation closed even if a future caller bypasses the webhook worker.
  assertLiveEffectsEnabled("live");
  const data = await graphql<{
    fulfillmentTrackingInfoUpdate: { fulfillment: { id: string; status: string } | null; userErrors: Array<{ message: string }> };
  }>(cfg, FULFILLMENT_TRACKING_UPDATE, {
    fulfillmentId,
    trackingInfoInput: { number: tracking.number, url: tracking.url, company: tracking.company },
    notifyCustomer,
  });
  const { fulfillment, userErrors } = data.fulfillmentTrackingInfoUpdate;
  if (userErrors.length || !fulfillment) {
    throw new Error(`fulfillmentTrackingInfoUpdate failed: ${userErrors.map((e) => e.message).join("; ") || "no fulfillment"}`);
  }
  return fulfillment;
}
