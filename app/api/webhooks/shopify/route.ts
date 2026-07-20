// POST /api/webhooks/shopify — signed Shopify order mirror. The delivery receipt and order
// update are atomic in Convex, so retries are idempotent. It never triggers CJ automatically.
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
  let payload: {
    id?: number | string; order_id?: number | string; admin_graphql_api_id?: string;
    total_price?: string; fulfillment_status?: string | null; status?: string | null; created_at?: string;
  };
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
    });
    return NextResponse.json({ ok: true, topic, duplicate: result.duplicate, fulfillment: "not-triggered" });
  } catch {
    // A non-2xx tells Shopify to retry an uncommitted local mutation. No supplier call exists here.
    return NextResponse.json({ error: "local webhook processing failed" }, { status: 503 });
  }
}
