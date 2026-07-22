// Server-only CJ Dropshipping API v2 adapter. Product, variant, and inventory calls here are
// read-only. The only write-capable function remains createOrder(), which deliberately uses
// payType:3 (create-only) and is isolated in the fulfilment worker.
import { assertCjTokenBundleWriterConfigured, getKey, replaceCjTokenBundleAtomically } from "./vault";
import { CjStagingFailureError } from "./cjStagingState";
import { CjTokenCoordinator, type CjTokenBundle, type RotatedCjTokenPair } from "./cjTokenRotation";
import { selectCjOpenId } from "./cjOpenId";

const CJ_BASE = "https://developers.cjdropshipping.com/api2.0/v1";

async function readTokenBundle(): Promise<CjTokenBundle> {
  const [vaultOpenId, vaultAccess, vaultRefresh, vaultAccessExpiry, vaultRefreshExpiry] = await Promise.all([
    getKey("cj", "CJ_OPEN_ID").catch(() => null),
    getKey("cj", "CJ_ACCESS_TOKEN").catch(() => null),
    getKey("cj", "CJ_REFRESH_TOKEN").catch(() => null),
    getKey("cj", "CJ_ACCESS_TOKEN_EXPIRY_DATE").catch(() => null),
    getKey("cj", "CJ_REFRESH_TOKEN_EXPIRY_DATE").catch(() => null),
  ]);
  const accessToken = vaultAccess ?? process.env.CJ_ACCESS_TOKEN;
  const refreshToken = vaultRefresh ?? process.env.CJ_REFRESH_TOKEN;
  const openId = selectCjOpenId(vaultOpenId, process.env.CJ_OPEN_ID);
  if (!accessToken) throw new Error("cj: no access token — add CJ_ACCESS_TOKEN to the server vault/control plane");
  if (!openId) throw new Error("cj: no openId — reconnect the independent account so CJ_OPEN_ID is retained atomically");
  return {
    openId,
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(vaultAccessExpiry ?? process.env.CJ_ACCESS_TOKEN_EXPIRY_DATE ? { accessTokenExpiryDate: vaultAccessExpiry ?? process.env.CJ_ACCESS_TOKEN_EXPIRY_DATE } : {}),
    ...(vaultRefreshExpiry ?? process.env.CJ_REFRESH_TOKEN_EXPIRY_DATE ? { refreshTokenExpiryDate: vaultRefreshExpiry ?? process.env.CJ_REFRESH_TOKEN_EXPIRY_DATE } : {}),
  };
}

let tokenCoordinator: CjTokenCoordinator | null = null;

function cjTokens(): CjTokenCoordinator {
  if (!tokenCoordinator) {
    tokenCoordinator = new CjTokenCoordinator(
      { read: readTokenBundle, replace: replaceCjTokenBundleAtomically },
      refreshAccessToken,
      getIndependentAccountTokenBundle,
    );
  }
  return tokenCoordinator;
}

export async function getAccessToken(): Promise<string> {
  return cjTokens().getAccessToken();
}

export class CjApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "CjApiError";
  }
}

/**
 * Closed set of provider responses that prove CJ rejected this create before accepting it.
 * Transport failures, throttling, conflicts, and every untyped error deliberately have no
 * member here: after the provider fence those cases must be read-reconciled, never retried.
 */
export type CjDefinitiveSandboxOrderRejection =
  | "invalid_request"
  | "invalid_credentials"
  | "sandbox_not_permitted"
  | "provider_resource_missing"
  | "invalid_order";

export function definitiveSandboxCjWriteRejection(error: unknown): CjDefinitiveSandboxOrderRejection | null {
  if (!(error instanceof CjApiError)) return null;
  switch (error.status) {
    case 400: return "invalid_request";
    case 401: return "invalid_credentials";
    case 403: return "sandbox_not_permitted";
    case 404: return "provider_resource_missing";
    case 422: return "invalid_order";
    default: return null;
  }
}

export function isAmbiguousCjWriteError(error: unknown): boolean {
  return definitiveSandboxCjWriteRejection(error) === null;
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

export interface CjAccessTokens extends RotatedCjTokenPair {
  openId: string;
}

type CjTokenResponseData = {
  openId?: unknown;
  accessToken: string;
  accessTokenExpiryDate?: string;
  refreshToken: string;
  refreshTokenExpiryDate?: string;
  createDate?: string;
}

/** Exchange a CJ refresh token. CJ omits openId; the coordinator retains the durable value. */
export async function refreshAccessToken(refreshToken: string): Promise<RotatedCjTokenPair> {
  if (!refreshToken) throw new Error("cj: refreshToken is required");
  // This endpoint authenticates with the refresh token in the body, not CJ-Access-Token.
  const res = await fetch(`${CJ_BASE}/authentication/refreshAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
    cache: "no-store",
  });
  const json = (await res.json()) as { result?: boolean; success?: boolean; message?: string; data?: RotatedCjTokenPair };
  if (!res.ok || json.result === false || json.success === false || !json.data?.accessToken || !json.data.refreshToken) {
    throw new Error(`cj /authentication/refreshAccessToken failed: HTTP ${res.status} invalid response`);
  }
  return json.data;
}

function exactOpenId(raw: string, parsed: CjTokenResponseData): string | null {
  const matches = [...raw.matchAll(/"openId"\s*:\s*(?:"([0-9]{1,20})"|([0-9]{1,20}))/g)];
  if (matches.length !== 1 || (typeof parsed.openId !== "number" && typeof parsed.openId !== "string")) return null;
  return matches[0][1] ?? matches[0][2] ?? null;
}

/** Parse the official independent-account response while preserving a potentially 20-digit Long. */
export function parseIndependentAccountTokenResponse(raw: string, status: number): CjAccessTokens {
  let json: { result?: boolean; success?: boolean; data?: CjTokenResponseData };
  try {
    json = JSON.parse(raw) as typeof json;
  } catch {
    throw new Error(`cj /authentication/getAccessToken failed: HTTP ${status} invalid response`);
  }
  const data = json.data;
  const openId = data ? exactOpenId(raw, data) : null;
  if (status < 200 || status >= 300 || json.result !== true || json.success !== true || !data
    || !openId || typeof data.accessToken !== "string" || !data.accessToken
    || typeof data.refreshToken !== "string" || !data.refreshToken) {
    throw new Error(`cj /authentication/getAccessToken failed: HTTP ${status} invalid response`);
  }
  return {
    openId,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    ...(typeof data.accessTokenExpiryDate === "string" ? { accessTokenExpiryDate: data.accessTokenExpiryDate } : {}),
    ...(typeof data.refreshTokenExpiryDate === "string" ? { refreshTokenExpiryDate: data.refreshTokenExpiryDate } : {}),
    ...(typeof data.createDate === "string" ? { createDate: data.createDate } : {}),
  };
}

/** Independent-account API-key flow from CJ's official authentication contract. */
export async function getIndependentAccountTokenBundle(apiKey: string): Promise<CjAccessTokens> {
  if (!apiKey.trim() || apiKey.length > 200) throw new Error("cj: apiKey is required and must be at most 200 characters");
  const res = await fetch(`${CJ_BASE}/authentication/getAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
    cache: "no-store",
  });
  return parseIndependentAccountTokenResponse(await res.text(), res.status);
}

/**
 * CJ rotates refresh tokens. The coordinator first persists the entire returned pair with an
 * atomic compare-and-swap and only then replaces this process's token cache.
 */
export async function refreshCurrentAccessToken(): Promise<string> {
  assertCjTokenBundleWriterConfigured();
  return cjTokens().refreshAccessToken();
}

/** Operator-controlled initial CJ connection. It never returns any account identity or credential. */
export async function persistIndependentAccountConnection(apiKey: string): Promise<void> {
  assertCjTokenBundleWriterConfigured();
  await cjTokens().connectApiKey(apiKey);
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
    throw new CjStagingFailureError("permanent", "invalid_verified_lineage");
  }
  try {
    const data = await cjFetch<Array<{ logisticName?: unknown; logisticPrice?: unknown }>>("/logistic/freightCalculate", {
      body: { startCountryCode: fromCountryCode, endCountryCode: destinationCountryCode, zip: input.shippingZip || undefined, products: input.products },
      token,
    });
    return data.flatMap((candidate) => {
      const logisticName = typeof candidate.logisticName === "string" ? candidate.logisticName.trim() : "";
      const logisticPriceUsd = typeof candidate.logisticPrice === "number" ? candidate.logisticPrice : Number(candidate.logisticPrice);
      return logisticName && Number.isFinite(logisticPriceUsd) && logisticPriceUsd >= 0 ? [{ logisticName, logisticPriceUsd }] : [];
    });
  } catch (error) {
    // Classify only typed local/provider status, never an untrusted provider message.
    if (error instanceof CjStagingFailureError) throw error;
    if (error instanceof CjApiError) {
      if (error.status === 429) throw new CjStagingFailureError("retryable", "provider_rate_limited");
      if (error.status >= 500) throw new CjStagingFailureError("retryable", "provider_unavailable");
      throw new CjStagingFailureError("permanent", "invalid_or_unbound_input");
    }
    if (error instanceof TypeError) throw new CjStagingFailureError("retryable", "network_unavailable");
    throw new CjStagingFailureError("permanent", "configuration_unavailable");
  }
}

/** Deterministic policy over actual CJ quote rows; it never invents a carrier or warehouse. */
export function selectVerifiedCjFreight(quotes: CjFreightQuote[]): CjFreightQuote {
  const valid = quotes.filter((quote) => quote.logisticName.trim() && Number.isFinite(quote.logisticPriceUsd) && quote.logisticPriceUsd >= 0);
  if (!valid.length) throw new CjStagingFailureError("permanent", "invalid_or_unbound_input");
  return [...valid].sort((a, b) => a.logisticPriceUsd - b.logisticPriceUsd || a.logisticName.localeCompare(b.logisticName))[0];
}

/** @deprecated All supplier writes are sandbox-only. Use createSandboxOrder. */
export const createOrder = createSandboxOrder;

export interface CjOrderLookup {
  orderId: string;
  orderNumber: string;
  /** Canonical provider identity persisted across the Convex boundary. */
  isSandbox: 1;
}

/** CJ accepts the custom order number as `orderId` for this lookup. */
export async function getSandboxOrderByOrderNumber(orderNumber: string, token?: string): Promise<CjOrderLookup | null> {
  try {
    const data = await cjFetch<{ orderId?: string; orderNum?: string; orderNumber?: string; isSandbox?: number | boolean }>("/shopping/order/getOrderDetail", {
      method: "GET", token, query: { orderId: orderNumber },
    });
    // A lookup request is not provider evidence. CJ must echo one of its canonical identity
    // fields exactly; falling back to the requested value could incorrectly settle a write.
    const actualOrderNumber = data.orderNumber ?? data.orderNum;
    if (!data.orderId || actualOrderNumber !== orderNumber) return null;
    if (data.isSandbox !== 1 && data.isSandbox !== true) throw new Error("CJ reconciliation found a non-sandbox order");
    // CJ has emitted both `true` and `1`; normalize the adapter boundary so storage and every
    // reconciliation receipt have one exact identity.
    return { orderId: data.orderId, orderNumber: actualOrderNumber, isSandbox: 1 };
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
