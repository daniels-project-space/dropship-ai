// Server-only CJ Dropshipping API v2 adapter. Product, variant, and inventory calls here are
// read-only. The only write-capable function remains createOrder(), which deliberately uses
// payType:3 (create-only) and is isolated in the fulfilment worker.
import { getKey } from "./vault";

const CJ_BASE = "https://developers.cjdropshipping.com/api2.0/v1";

type CjTokenBundle = { accessToken: string; refreshToken?: string; accessTokenExpiryDate?: string; refreshTokenExpiryDate?: string };
let activeTokens: CjTokenBundle | null = null;
let refreshInFlight: Promise<string> | null = null;

async function readTokenBundle(): Promise<CjTokenBundle> {
  const [vaultAccess, vaultRefresh] = await Promise.all([
    getKey("cj", "CJ_ACCESS_TOKEN").catch(() => null),
    getKey("cj", "CJ_REFRESH_TOKEN").catch(() => null),
  ]);
  const accessToken = vaultAccess ?? process.env.CJ_ACCESS_TOKEN;
  const refreshToken = vaultRefresh ?? process.env.CJ_REFRESH_TOKEN;
  if (!accessToken) throw new Error("cj: no access token — add CJ_ACCESS_TOKEN to the server vault/control plane");
  return { accessToken, refreshToken };
}

export async function getAccessToken(): Promise<string> {
  if (!activeTokens) activeTokens = await readTokenBundle();
  return activeTokens.accessToken;
}

class CjApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "CjApiError";
  }
}

export function isAmbiguousCjWriteError(error: unknown): boolean {
  return error instanceof CjApiError ? error.status >= 500 : true;
}

async function cjFetch<T>(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; token?: string; query?: Record<string, string | number | boolean | undefined> } = {},
): Promise<T> {
  const accessToken = options.token ?? (await getAccessToken());
  try {
    return await cjFetchWithToken<T>(path, options, accessToken);
  } catch (error) {
    // An explicit caller token is never silently replaced. For normal server-controlled calls,
    // one 401 gets a single-flight refresh; the returned pair is assigned atomically in memory.
    if (options.token || !(error instanceof CjApiError) || error.status !== 401) throw error;
    const refreshed = await refreshCurrentAccessToken();
    return cjFetchWithToken<T>(path, options, refreshed);
  }
}

async function cjFetchWithToken<T>(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; token?: string; query?: Record<string, string | number | boolean | undefined> },
  accessToken: string,
): Promise<T> {
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
    throw new CjApiError(res.status, `cj ${path} failed: HTTP ${res.status} ${json?.message ?? "invalid response"}`);
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

/**
 * Refresh is disabled unless the deployment supplies an atomic control-plane token-bundle
 * writer. Keeping a newly issued pair only in process memory loses CJ's rotated refresh token
 * on restart, so that would turn a transient 401 into an unrecoverable outage. This repository
 * has a read-only vault client; fail closed until its writer capability is attached.
 */
export async function refreshCurrentAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    // There is currently no scoped writer in this app. Do this check before contacting CJ: a
    // refresh response invalidates the old refresh token and must be stored atomically with its
    // new access token by the control plane.
    throw new Error("cj: automatic token refresh is blocked: atomic control-plane token-bundle writer is not installed");
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
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
  /** Required by CJ createOrderV2 and copied only from a verified freight preflight. */
  logisticName: string;
  /** Required by CJ createOrderV2 and bound to persisted source warehouse lineage. */
  fromCountryCode: string;
  products: CjOrderLine[];
}

export interface CreateOrderResult {
  orderId: string;
  orderNumber: string;
}

/** Create-only order (payType:3). Returns CJ orderId; no tracking is expected here. */
export async function createSandboxOrder(input: CreateOrderInput, token?: string): Promise<CreateOrderResult> {
  if (!input.orderNumber.startsWith("dsa-sb-")) throw new Error("CJ sandbox orderNumber must use the persisted sandbox identity");
  if (!input.logisticName.trim() || !/^[A-Za-z]{2}$/.test(input.fromCountryCode)) {
    throw new Error("CJ sandbox order requires a verified logisticName and two-letter fromCountryCode");
  }
  const data = await cjFetch<{ orderId: string }>("/shopping/order/createOrderV2", {
    // These are a second, adapter-level boundary in addition to the dispatch mutation below.
    body: { ...input, payType: 3, isSandbox: 1 },
    token,
  });
  return { orderId: data.orderId, orderNumber: input.orderNumber };
}

export interface CjFreightPreflightInput {
  fromCountryCode: string;
  destinationCountryCode: string;
  shippingZip?: string;
  products: CjOrderLine[];
}

export interface CjFreightQuote {
  logisticName: string;
  logisticPriceUsd: number;
}

/**
 * Read-only CJ freight trial. The caller persists the selected result with the order before it
 * can be approved; this helper never creates, reserves, pays for, or confirms an order.
 */
export async function quoteCjFreight(input: CjFreightPreflightInput, token?: string): Promise<CjFreightQuote[]> {
  const fromCountryCode = input.fromCountryCode.trim().toUpperCase();
  const destinationCountryCode = input.destinationCountryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(fromCountryCode) || !/^[A-Z]{2}$/.test(destinationCountryCode) || !input.products.length) {
    throw new Error("CJ freight preflight requires verified two-letter origin/destination and products");
  }
  const data = await cjFetch<Array<{ logisticName?: unknown; logisticPrice?: unknown }>>("/logistic/freightCalculate", {
    body: { startCountryCode: fromCountryCode, endCountryCode: destinationCountryCode, zip: input.shippingZip || undefined, products: input.products },
    token,
  });
  return data.flatMap((candidate) => {
    const logisticName = typeof candidate.logisticName === "string" ? candidate.logisticName.trim() : "";
    const logisticPriceUsd = typeof candidate.logisticPrice === "number" ? candidate.logisticPrice : Number(candidate.logisticPrice);
    return logisticName && Number.isFinite(logisticPriceUsd) && logisticPriceUsd >= 0 ? [{ logisticName, logisticPriceUsd }] : [];
  });
}

/** Deterministic policy over actual CJ quote rows; it never invents a carrier or warehouse. */
export function selectVerifiedCjFreight(quotes: CjFreightQuote[]): CjFreightQuote {
  const valid = quotes.filter((quote) => quote.logisticName.trim() && Number.isFinite(quote.logisticPriceUsd) && quote.logisticPriceUsd >= 0);
  if (!valid.length) throw new Error("CJ freight preflight found no valid logistics route; refresh sourcing or resolve warehouse/logistics with an operator");
  return [...valid].sort((a, b) => a.logisticPriceUsd - b.logisticPriceUsd || a.logisticName.localeCompare(b.logisticName))[0];
}

/** @deprecated All supplier writes are sandbox-only. Use createSandboxOrder. */
export const createOrder = createSandboxOrder;

export interface CjOrderLookup {
  orderId: string;
  orderNumber: string;
  isSandbox: number | boolean | undefined;
}

/** CJ accepts the custom order number as `orderId` for this lookup. */
export async function getSandboxOrderByOrderNumber(orderNumber: string, token?: string): Promise<CjOrderLookup | null> {
  try {
    const data = await cjFetch<{ orderId?: string; orderNum?: string; orderNumber?: string; isSandbox?: number | boolean }>("/shopping/order/getOrderDetail", {
      method: "GET", token, query: { orderId: orderNumber },
    });
    const actualOrderNumber = data.orderNumber ?? data.orderNum ?? orderNumber;
    if (!data.orderId || actualOrderNumber !== orderNumber) return null;
    if (data.isSandbox !== 1 && data.isSandbox !== true) throw new Error("CJ reconciliation found a non-sandbox order");
    return { orderId: data.orderId, orderNumber: actualOrderNumber, isSandbox: data.isSandbox };
  } catch (error) {
    if (error instanceof CjApiError && error.status === 404) return null;
    throw error;
  }
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

/**
 * Product details include variants and their inventories.  Supplying countryCode is important:
 * CJ then returns only variants that have inventory in that country.
 */
export async function getProduct(productId: string, countryCode?: string, token?: string): Promise<unknown> {
  if (!productId) throw new Error("cj: productId is required");
  return cjFetch<unknown>("/product/query", { method: "GET", token, query: { pid: productId, countryCode } });
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
