// Server-only CJ Dropshipping API v2 adapter. Product, variant, and inventory calls here are
// read-only. The only write-capable function remains createOrder(), which deliberately uses
// payType:3 (create-only) and is isolated in the fulfilment worker.
import { getKey } from "./vault";

const CJ_BASE = "https://developers.cjdropshipping.com/api2.0/v1";

export async function getAccessToken(): Promise<string> {
  const fromVault = await getKey("cj", "CJ_ACCESS_TOKEN").catch(() => null);
  const token = fromVault ?? process.env.CJ_ACCESS_TOKEN;
  if (!token) {
    throw new Error("cj: no access token — add CJ_ACCESS_TOKEN to vault service 'cj' or set process.env.CJ_ACCESS_TOKEN");
  }
  return token;
}

async function cjFetch<T>(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; token?: string; query?: Record<string, string | number | boolean | undefined> } = {},
): Promise<T> {
  const accessToken = options.token ?? (await getAccessToken());
  const url = new URL(`${CJ_BASE}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, {
    method: options.method ?? "POST",
    headers: {
      "Content-Type": "application/json",
      "CJ-Access-Token": accessToken,
    },
    ...(options.method === "GET" ? {} : { body: JSON.stringify(options.body ?? {}) }),
    cache: "no-store",
  });
  type CjResponse = { code?: number; result?: boolean; success?: boolean; message?: string; data?: T };
  let json: CjResponse | null = null;
  try {
    json = (await res.json()) as CjResponse;
  } catch {
    // Preserve the status without attempting to expose an HTML/provider error body.
  }
  if (!res.ok || json?.result === false || json?.success === false || !json) {
    throw new Error(`cj ${path} failed: HTTP ${res.status} ${json?.message ?? "invalid response"}`);
  }
  return json.data as T;
}

export interface CjAccessTokens {
  accessToken: string;
  accessTokenExpiryDate?: string;
  refreshToken: string;
  refreshTokenExpiryDate?: string;
  createDate?: string;
}

/** Exchange a CJ refresh token. Callers must persist tokens only in the server-side vault. */
export async function refreshAccessToken(refreshToken: string): Promise<CjAccessTokens> {
  if (!refreshToken) throw new Error("cj: refreshToken is required");
  // This endpoint authenticates with the refresh token in the body, not CJ-Access-Token.
  const res = await fetch(`${CJ_BASE}/authentication/refreshAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
    cache: "no-store",
  });
  const json = (await res.json()) as { result?: boolean; success?: boolean; message?: string; data?: CjAccessTokens };
  if (!res.ok || json.result === false || json.success === false || !json.data?.accessToken || !json.data.refreshToken) {
    throw new Error(`cj /authentication/refreshAccessToken failed: HTTP ${res.status} ${json.message ?? "invalid response"}`);
  }
  return json.data;
}

export interface CjOrderLine {
  vid: string;
  quantity: number;
}

export interface CreateOrderInput {
  orderNumber: string;
  shippingZip: string;
  shippingCountryCode: string;
  shippingCountry: string;
  shippingProvince: string;
  shippingCity: string;
  shippingAddress: string;
  shippingCustomerName: string;
  shippingPhone: string;
  logisticName?: string;
  fromCountryCode?: string;
  products: CjOrderLine[];
}

export interface CreateOrderResult {
  orderId: string;
  orderNumber: string;
}

/** Create-only order (payType:3). Returns CJ orderId; no tracking is expected here. */
export async function createOrder(input: CreateOrderInput, token?: string): Promise<CreateOrderResult> {
  const data = await cjFetch<{ orderId: string }>("/shopping/order/createOrderV2", {
    body: { ...input, payType: 3 },
    token,
  });
  return { orderId: data.orderId, orderNumber: input.orderNumber };
}

export interface CjProductQuery {
  pageNum?: number;
  pageSize?: number;
  productNameEn?: string;
  categoryId?: string;
}

export interface CjCatalogSearch {
  keyword: string;
  page?: number;
  size?: number;
  countryCode?: string;
}

/** Legacy catalogue list, retained for callers that depend on it. */
export async function queryProducts(q: CjProductQuery, token?: string): Promise<unknown> {
  return cjFetch<unknown>("/product/list", {
    method: "GET",
    query: { pageNum: q.pageNum, pageSize: q.pageSize, productNameEn: q.productNameEn, categoryId: q.categoryId },
    token,
  });
}

/** CJ's current elastic-search catalogue endpoint. */
export async function searchProducts(q: CjCatalogSearch, token?: string): Promise<unknown> {
  if (!q.keyword.trim()) throw new Error("cj: keyword is required");
  return cjFetch<unknown>("/product/listV2", {
    method: "GET",
    token,
    query: { page: q.page ?? 1, size: Math.min(Math.max(q.size ?? 20, 1), 100), keyWord: q.keyword, countryCode: q.countryCode },
  });
}

export async function getProduct(productId: string, token?: string): Promise<unknown> {
  if (!productId) throw new Error("cj: productId is required");
  return cjFetch<unknown>("/product/query", { method: "GET", token, query: { pid: productId } });
}

export async function getVariants(productId: string, countryCode?: string, token?: string): Promise<unknown> {
  if (!productId) throw new Error("cj: productId is required");
  return cjFetch<unknown>("/product/variant/query", { method: "GET", token, query: { pid: productId, countryCode } });
}

export async function getVariant(variantId: string, token?: string): Promise<unknown> {
  if (!variantId) throw new Error("cj: variantId is required");
  return cjFetch<unknown>("/product/variant/queryByVid", { method: "GET", token, query: { vid: variantId, features: "enable_inventory" } });
}

export async function getInventoryByProduct(productId: string, token?: string): Promise<unknown> {
  if (!productId) throw new Error("cj: productId is required");
  return cjFetch<unknown>("/product/stock/getInventoryByPid", { method: "GET", token, query: { pid: productId } });
}

export async function getInventoryByVariant(variantId: string, token?: string): Promise<unknown> {
  if (!variantId) throw new Error("cj: variantId is required");
  return cjFetch<unknown>("/product/stock/queryByVid", { method: "GET", token, query: { vid: variantId } });
}

export interface ParsedTracking {
  cjOrderId?: string;
  orderNumber?: string;
  trackNumber?: string;
  trackingUrl?: string;
  logisticName?: string;
  status?: string;
}

/** Extract tracking fields from a CJ ORDER webhook payload (shape-tolerant). */
export function parseOrderWebhook(payload: unknown): ParsedTracking {
  const p = (payload ?? {}) as Record<string, unknown>;
  const d = (typeof p.data === "object" && p.data ? p.data : p) as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof d[k] === "string" ? d[k] as string : undefined);
  const trackNumber = str("trackNumber") ?? str("trackingNumber");
  return {
    cjOrderId: str("orderId") ?? str("cjOrderId"),
    orderNumber: str("orderNumber"),
    trackNumber,
    trackingUrl: str("trackingUrl") ?? (trackNumber ? `https://t.17track.net/en#nums=${trackNumber}` : undefined),
    logisticName: str("logisticName"),
    status: str("orderStatus") ?? str("status"),
  };
}
