// POST /api/webhooks/shopify — signed, bounded Shopify intake. The receipt, mirror and optional
// CJ staging intent are one Convex transaction; provider work runs later in a scheduled worker.
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getKey } from "@/src/lib/vault";
import { convexClient, api } from "@/src/lib/convexClient";
import type { Id } from "@/convex/_generated/dataModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function webhookSecret(): Promise<string | null> {
  if (process.env.SHOPIFY_WEBHOOK_SECRET) return process.env.SHOPIFY_WEBHOOK_SECRET;
  return getKey("shopify", "WEBHOOK_SECRET").catch(() => null);
}

export function verifyShopifyHmac(secret: string, rawBody: Buffer, hmacHeader: string): boolean {
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

type FulfillmentStatus = "received" | "sent_to_cj" | "shipped" | "delivered" | "error";
type ShopifyCjLine = { product_id?: unknown; variant_id?: unknown; productId?: unknown; variantId?: unknown; quantity?: unknown };
type ShopifyOrderPayload = {
  id?: number | string; order_id?: number | string; admin_graphql_api_id?: string;
  total_price?: string; fulfillment_status?: string | null; status?: string | null; created_at?: string;
  shipping_address?: { zip?: unknown; country_code?: unknown; country?: unknown; province?: unknown; city?: unknown; address1?: unknown; address2?: unknown; name?: unknown; phone?: unknown } | null;
  line_items?: ShopifyCjLine[];
};

function shopifyGid(kind: "Product" | "ProductVariant", value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return `gid://shopify/${kind}/${value}`;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (new RegExp(`^gid://shopify/${kind}/[0-9]+$`).test(trimmed)) return trimmed;
  return /^[0-9]+$/.test(trimmed) ? `gid://shopify/${kind}/${trimmed}` : null;
}

// Shopify SKU is merchant-editable and cannot identify supplier lineage. Signed product+variant
// IDs are resolved again inside Convex against this site's DRAFT import mapping.
function cjStagingInputFromShopify(payload: ShopifyOrderPayload) {
  const shipping = payload.shipping_address;
  const lines = payload.line_items;
  if (!shipping || !Array.isArray(lines) || lines.length === 0) return null;
  const shopifyLines = lines.map((line) => {
    const quantity = typeof line.quantity === "number" ? line.quantity : Number(line.quantity);
    return { productId: shopifyGid("Product", line.product_id ?? line.productId), variantId: shopifyGid("ProductVariant", line.variant_id ?? line.variantId), quantity };
  });
  if (shopifyLines.some((line) => !line.productId || !line.variantId || !Number.isInteger(line.quantity) || line.quantity < 1)) return null;
  const string = (value: unknown) => typeof value === "string" ? value.trim() : "";
  const address = [string(shipping.address1), string(shipping.address2)].filter(Boolean).join(", ");
  const shippingInput = { shippingZip: string(shipping.zip), shippingCountryCode: string(shipping.country_code), shippingCountry: string(shipping.country), shippingProvince: string(shipping.province), shippingCity: string(shipping.city), shippingAddress: address, shippingCustomerName: string(shipping.name), shippingPhone: string(shipping.phone) };
  return shippingInput.shippingCountryCode && shippingInput.shippingCountry && shippingInput.shippingProvince && shippingInput.shippingCity && shippingInput.shippingAddress && shippingInput.shippingCustomerName ? { shipping: shippingInput, shopifyLines: shopifyLines as Array<{ productId: string; variantId: string; quantity: number }> } : null;
}
function mapTopicToStatus(topic: string, payload: { fulfillment_status?: string | null; status?: string | null }): FulfillmentStatus {
  if (topic === "fulfillments/update") {
    const status = (payload.status ?? "").toLowerCase();
    return status === "success" || status === "delivered" ? "shipped" : "received";
  }
  return (payload.fulfillment_status ?? "").toLowerCase() === "fulfilled" ? "shipped" : "received";
}

export async function POST(req: Request) {
  const secret = await webhookSecret();
  if (!secret) return NextResponse.json({ error: "webhook not configured" }, { status: 401 });

  const raw = Buffer.from(await req.arrayBuffer());
  const hmac = req.headers.get("x-shopify-hmac-sha256") ?? "";
  if (!hmac || !verifyShopifyHmac(secret, raw, hmac)) {
    return NextResponse.json({ error: "invalid HMAC" }, { status: 401 });
  }

  const topic = req.headers.get("x-shopify-topic") ?? "";
  if (topic !== "orders/create" && topic !== "orders/updated" && topic !== "fulfillments/update") {
    return NextResponse.json({ ok: true, ignored: "unsupported topic" });
  }
  const shopDomain = req.headers.get("x-shopify-shop-domain") ?? "";
  let payload: ShopifyOrderPayload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const convex = convexClient();
  const site = await convex.query(api.sites.getByDomain, { shopifyDomain: shopDomain });
  if (!site) return NextResponse.json({ ok: true, ignored: "unknown shop" });

  const numericId = topic === "fulfillments/update" ? payload.order_id : payload.id;
  const shopifyOrderId = payload.admin_graphql_api_id ?? (numericId != null ? `gid://shopify/Order/${numericId}` : null);
  if (!shopifyOrderId) return NextResponse.json({ ok: true, ignored: "no order id" });

  const parsedCreatedAt = payload.created_at ? Date.parse(payload.created_at) : NaN;
  const payloadHash = crypto.createHash("sha256").update(raw).digest("hex");
  // Shopify provides the webhook id. The digest fallback is only for a manually generated test.
  const deliveryId = req.headers.get("x-shopify-webhook-id") ?? `digest:${topic}:${payloadHash}`;
  try {
    const result = await convex.mutation(api.webhooks.recordShopifyOrder, {
      siteId: site._id as Id<"sites">,
      deliveryId,
      topic,
      payloadHash,
      shopifyOrderId,
      totalUsd: Number(payload.total_price ?? 0) || 0,
      fulfillmentStatus: mapTopicToStatus(topic, payload),
      createdAt: Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : Date.now(),
      // PII remains in Convex's intent row. It never becomes part of the webhook response or a
      // Trigger/task payload; the scheduled worker receives the intent ID from its own query.
      stagingInput: topic === "orders/create" ? cjStagingInputFromShopify(payload) ?? undefined : undefined,
    });
    // Shopify gets a 2xx as soon as its signed delivery is durable. Do not make CJ, Trigger, or
    // approval-waitpoint calls here: Shopify retries transport failures and expects this path to
    // finish quickly.
    return NextResponse.json({ ok: true, topic, duplicate: result.duplicate, intake: "durable", cjStaging: result.intentId ? "queued" : "not-eligible" });
  } catch {
    // A non-2xx tells Shopify to retry an uncommitted local mutation. No supplier call exists here.
    return NextResponse.json({ error: "local webhook processing failed" }, { status: 503 });
  }
}
