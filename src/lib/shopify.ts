// Shopify Admin GraphQL client (API 2026-01). Thin typed wrapper — calls are stubbed/minimal
// but compile-clean. Token: vault per-site "SHOPIFY_ADMIN_TOKEN" or process.env fallback.
// NOTE: as of 2026-06-14 no "shopify" vault service exists — pass the token explicitly or set env.
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
