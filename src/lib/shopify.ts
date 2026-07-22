// Shopify Admin GraphQL client pinned to stable API 2026-01. Shopify supports this version until
// 2027-01-16; retaining the fixture-proven contract is safer than an unverified quarterly bump.
// Recurring tokens resolve only through each site's server-side vault reference.
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

export type ShopifyBoundedRead<T> = { items: T[]; complete: boolean };

/**
 * List products with cursor pagination up to `limit` (hard-capped at 250 to stay polite).
 * Pulls 50 per page. priceUsd is the first variant's price parsed to a number.
 */
export async function listProductsWithCoverage(
  cfg: ShopifyClientConfig,
  { limit = 250 }: { limit?: number } = {},
): Promise<ShopifyBoundedRead<ShopifyProduct>> {
  const cap = Math.min(limit, 250);
  const out: ShopifyProduct[] = [];
  let after: string | null = null;
  let hasMore = false;
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
    hasMore = data.products.pageInfo.hasNextPage;
    if (!hasMore) break;
    after = data.products.pageInfo.endCursor;
    if (!after) break;
  }
  return { items: out.slice(0, cap), complete: !hasMore };
}

export async function listProducts(
  cfg: ShopifyClientConfig,
  options: { limit?: number } = {},
): Promise<ShopifyProduct[]> {
  return (await listProductsWithCoverage(cfg, options)).items;
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
        displayFinancialStatus
        test
        cancelledAt
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        refunds { id }
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
  currencyCode: string;
  currentTotal: number;
  financialStatus: string;
  test: boolean;
  cancelled: boolean;
  creditAdjustmentState: "none" | "partial" | "full";
  lineItems: ShopifyOrderLine[];
}

/**
 * List orders from an exact cutoff, or a trailing `sinceDays` window for standalone callers.
 * Snapshot orchestration always supplies the durable Convex-owned cutoff. NOTE: the `read_orders`
 * scope only exposes the **last 60 days** of orders by default — older history needs Shopify's
 * `read_all_orders` protected scope (app approval). 60 days is the safe default. Cursor-paginated,
 * 50 per page, capped at 250 orders.
 */
export async function listOrdersWithCoverage(
  cfg: ShopifyClientConfig,
  { createdAtMin, sinceDays = 60, limit = 250 }: { createdAtMin?: number; sinceDays?: number; limit?: number } = {},
): Promise<ShopifyBoundedRead<ShopifyOrder>> {
  const cap = Math.min(limit, 250);
  const cutoff = createdAtMin ?? Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(cutoff)) throw new Error("Shopify order cutoff is invalid");
  const sinceIso = new Date(cutoff).toISOString();
  const queryFilter = `created_at:>=${sinceIso}`;
  const out: ShopifyOrder[] = [];
  let after: string | null = null;
  let hasMore = false;
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
          displayFinancialStatus: string | null;
          test: boolean;
          cancelledAt: string | null;
          currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
          refunds: Array<{ id: string }>;
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
        currencyCode: n.currentTotalPriceSet.shopMoney.currencyCode,
        currentTotal: Number(n.currentTotalPriceSet.shopMoney.amount),
        financialStatus: n.displayFinancialStatus ?? "UNKNOWN",
        test: n.test,
        cancelled: n.cancelledAt !== null,
        creditAdjustmentState: n.displayFinancialStatus === "REFUNDED" ? "full"
          : n.displayFinancialStatus === "PARTIALLY_REFUNDED" || n.refunds.length ? "partial" : "none",
        lineItems: n.lineItems.nodes.map((li) => ({
          productId: li.product?.id ?? null,
          quantity: li.quantity,
        })),
      });
    }
    hasMore = data.orders.pageInfo.hasNextPage;
    if (!hasMore) break;
    after = data.orders.pageInfo.endCursor;
    if (!after) break;
  }
  return { items: out.slice(0, cap), complete: !hasMore };
}

export async function listOrders(
  cfg: ShopifyClientConfig,
  options: { createdAtMin?: number; sinceDays?: number; limit?: number } = {},
): Promise<ShopifyOrder[]> {
  return (await listOrdersWithCoverage(cfg, options)).items;
}

const PRODUCT_CREATE = /* GraphQL */ `
  mutation productCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
    productCreate(product: $product, media: $media) {
      product { id title handle media(first: 1) { nodes { mediaContentType } } variants(first: 1) { nodes { id } } }
      userErrors { field message }
    }
  }
`;

export interface ProductCreateInput {
  title: string;
  descriptionHtml?: string;
  vendor?: string;
  /** Server-derived only. Shopify's initial variant gets this exact approved sell price. */
  priceUsd: number;
  /** Server-derived CJ VID, retained as Shopify SKU for exact order-lineage mapping. */
  cjVariantId: string;
  /** Exact HTTPS media URL from immutable CJ evidence. */
  mediaUrl: string;
}

const PRODUCT_VARIANTS_BULK_UPDATE = /* GraphQL */ `
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price sku }
      userErrors { field message }
    }
  }
`;

export async function productCreate(
  cfg: ShopifyClientConfig,
  input: ProductCreateInput,
): Promise<{ id: string; title: string; handle: string; variantId: string }> {
  if (!Number.isFinite(input.priceUsd) || input.priceUsd <= 0) throw new Error("productCreate requires a positive verified price");
  if (!input.cjVariantId.trim()) throw new Error("productCreate requires an exact CJ variant");
  try {
    const mediaUrl = new URL(input.mediaUrl);
    if (mediaUrl.protocol !== "https:") throw new Error("not HTTPS");
  } catch {
    throw new Error("productCreate requires verified HTTPS media");
  }
  const data = await graphql<{
    productCreate: { product: { id: string; title: string; handle: string; media: { nodes: Array<{ mediaContentType: string }> }; variants: { nodes: Array<{ id: string }> } } | null; userErrors: Array<{ message: string }> };
  }>(cfg, PRODUCT_CREATE, {
    product: { title: input.title, ...(input.descriptionHtml ? { descriptionHtml: input.descriptionHtml } : {}), ...(input.vendor ? { vendor: input.vendor } : {}), status: "DRAFT" },
    media: [{ originalSource: input.mediaUrl, mediaContentType: "IMAGE" }],
  });
  const { product, userErrors } = data.productCreate;
  const variantId = product?.variants.nodes[0]?.id;
  if (userErrors.length || !product || !variantId || !product.media.nodes.some((media) => media.mediaContentType === "IMAGE")) {
    throw new Error(`productCreate failed: ${userErrors.map((e) => e.message).join("; ") || "no product"}`);
  }
  const variants = await graphql<{
    productVariantsBulkUpdate: { productVariants: Array<{ id: string; price: string; sku: string | null }>; userErrors: Array<{ message: string }> };
  }>(cfg, PRODUCT_VARIANTS_BULK_UPDATE, {
    productId: product.id,
    variants: [{ id: variantId, price: input.priceUsd.toFixed(2), sku: input.cjVariantId }],
  });
  const updatedVariant = variants.productVariantsBulkUpdate.productVariants.find((candidate) => candidate.id === variantId);
  if (variants.productVariantsBulkUpdate.userErrors.length || !updatedVariant
    || Number(updatedVariant.price) !== Number(input.priceUsd.toFixed(2)) || updatedVariant.sku !== input.cjVariantId) {
    throw new Error(`productVariantsBulkUpdate failed: ${variants.productVariantsBulkUpdate.userErrors.map((e) => e.message).join("; ") || "exact price/variant was not returned"}`);
  }
  return { id: product.id, title: product.title, handle: product.handle, variantId };
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
