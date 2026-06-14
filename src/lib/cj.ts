// CJ Dropshipping adapter (API v2.0). VERIFIED endpoints.
// createOrderV2 with payType:3 = create-only (no auto-payment) — order is created in CJ but
// NOT paid, so nothing irreversible happens until a separate pay step. Tracking does NOT come
// back in the create response; it arrives later via the async ORDER webhook (parseOrderWebhook).
//
// Token: vault service "cj" (key CJ_ACCESS_TOKEN) if present, else process.env.CJ_ACCESS_TOKEN.
// NOTE: as of 2026-06-14 the "cj" vault service does NOT exist — token must be supplied via env
// until it is added to the vault.
import { getKey } from "./vault";

const CJ_BASE = "https://developers.cjdropshipping.com/api2.0/v1";

export async function getAccessToken(): Promise<string> {
  const fromVault = await getKey("cj", "CJ_ACCESS_TOKEN").catch(() => null);
  const token = fromVault ?? process.env.CJ_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "cj: no access token — add CJ_ACCESS_TOKEN to vault service 'cj' or set process.env.CJ_ACCESS_TOKEN",
    );
  }
  return token;
}

async function cjFetch<T>(path: string, body: unknown, token?: string): Promise<T> {
  const accessToken = token ?? (await getAccessToken());
  const res = await fetch(`${CJ_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CJ-Access-Token": accessToken,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const json = (await res.json()) as { code?: number; result?: boolean; message?: string; data?: T };
  if (!res.ok || json.result === false) {
    throw new Error(`cj ${path} failed: HTTP ${res.status} ${json.message ?? ""}`);
  }
  return json.data as T;
}

export interface CjOrderLine {
  vid: string; // CJ variant id
  quantity: number;
}

export interface CreateOrderInput {
  orderNumber: string; // your Shopify order id / external ref
  shippingZip: string;
  shippingCountryCode: string;
  shippingCountry: string;
  shippingProvince: string;
  shippingCity: string;
  shippingAddress: string;
  shippingCustomerName: string;
  shippingPhone: string;
  logisticName?: string;
  fromCountryCode?: string; // "US" to prefer US warehouse
  products: CjOrderLine[];
}

export interface CreateOrderResult {
  orderId: string;
  orderNumber: string;
}

/** Create-only order (payType:3). Returns CJ orderId; no tracking yet. */
export async function createOrder(input: CreateOrderInput, token?: string): Promise<CreateOrderResult> {
  const data = await cjFetch<{ orderId: string }>(
    "/shopping/order/createOrderV2",
    {
      orderNumber: input.orderNumber,
      shippingZip: input.shippingZip,
      shippingCountryCode: input.shippingCountryCode,
      shippingCountry: input.shippingCountry,
      shippingProvince: input.shippingProvince,
      shippingCity: input.shippingCity,
      shippingAddress: input.shippingAddress,
      shippingCustomerName: input.shippingCustomerName,
      shippingPhone: input.shippingPhone,
      logisticName: input.logisticName,
      fromCountryCode: input.fromCountryCode,
      payType: 3, // create-only, no payment
      products: input.products,
    },
    token,
  );
  return { orderId: data.orderId, orderNumber: input.orderNumber };
}

export interface CjProductQuery {
  pageNum?: number;
  pageSize?: number;
  productNameEn?: string;
  categoryId?: string;
}

/** Query the CJ catalog. Thin pass-through of /product/list. */
export async function queryProducts(q: CjProductQuery, token?: string): Promise<unknown> {
  return cjFetch<unknown>("/product/list", q, token);
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
  // CJ wraps the event body under `data` in some webhook versions.
  const d = (typeof p.data === "object" && p.data ? p.data : p) as Record<string, unknown>;
  const str = (k: string): string | undefined => {
    const val = d[k];
    return typeof val === "string" ? val : undefined;
  };
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
