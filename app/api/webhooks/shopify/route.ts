// POST /api/webhooks/shopify — inbound Shopify webhook (Phase 2a: built but DORMANT).
//
// Activated later, once webhooks are registered in Shopify and SHOPIFY_WEBHOOK_SECRET is in place
// (env or vault service "shopify" key "WEBHOOK_SECRET"). Until the secret exists, every request is
// rejected 401 — it ships safe.
//
// Verifies the HMAC over the RAW body, resolves the site by the X-Shopify-Shop-Domain header, and
// upserts the single order for topics orders/create, orders/updated, fulfillments/update. Responds
// 200 quickly. It performs NO CJ/fulfillment action (that's Phase 2b).
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

function verifyHmac(secret: string, rawBody: string, hmacHeader: string): boolean {
  const digest = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false; // length mismatch → not equal
  }
}

type FulfillmentStatus = "received" | "sent_to_cj" | "shipped" | "delivered" | "error";
function mapTopicToStatus(topic: string, payload: { fulfillment_status?: string | null; status?: string | null }): FulfillmentStatus {
  if (topic === "fulfillments/update") {
    const s = (payload.status ?? "").toLowerCase();
    return s === "success" || s === "delivered" ? "shipped" : "received";
  }
  // orders/create | orders/updated → order-level fulfillment_status ("fulfilled" | null | "partial")
  return (payload.fulfillment_status ?? "").toLowerCase() === "fulfilled" ? "shipped" : "received";
}

export async function POST(req: Request) {
  const secret = await webhookSecret();
  if (!secret) {
    // Dormant until the secret is provisioned — never silently accept unverified webhooks.
    return NextResponse.json({ error: "webhook not configured" }, { status: 401 });
  }

  const raw = await req.text();
  const hmac = req.headers.get("x-shopify-hmac-sha256") ?? "";
  if (!hmac || !verifyHmac(secret, raw, hmac)) {
    return NextResponse.json({ error: "invalid HMAC" }, { status: 401 });
  }

  const topic = req.headers.get("x-shopify-topic") ?? "";
  const shopDomain = req.headers.get("x-shopify-shop-domain") ?? "";

  let payload: {
    id?: number | string;
    order_id?: number | string;
    admin_graphql_api_id?: string;
    total_price?: string;
    fulfillment_status?: string | null;
    status?: string | null;
    created_at?: string;
  };
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // Resolve the tenant by connected domain.
  const convex = convexClient();
  const site = await convex.query(api.sites.getByDomain, { shopifyDomain: shopDomain });
  if (!site) {
    // Ack 200 so Shopify doesn't retry forever for an unknown/unconnected shop.
    return NextResponse.json({ ok: true, ignored: "unknown shop" });
  }

  // Build the Shopify order gid. orders/* payloads carry numeric id; fulfillments/* carry order_id.
  const numericId =
    topic === "fulfillments/update" ? payload.order_id : payload.id;
  const shopifyOrderId =
    payload.admin_graphql_api_id ?? (numericId != null ? `gid://shopify/Order/${numericId}` : null);
  if (!shopifyOrderId) {
    return NextResponse.json({ ok: true, ignored: "no order id" });
  }

  const status = mapTopicToStatus(topic, payload);
  const totalUsd = Number(payload.total_price ?? 0) || 0;
  const createdAt = payload.created_at ? Date.parse(payload.created_at) : Date.now();

  try {
    await convex.mutation(api.orders.upsertFromShopify, {
      siteId: site._id as Id<"sites">,
      orders: [{ shopifyOrderId, totalUsd, fulfillmentStatus: status, createdAt }],
    });
  } catch {
    // Swallow → still ack 200; Shopify will retry on a non-2xx and we don't want a poison loop.
    return NextResponse.json({ ok: true, deferred: true });
  }

  return NextResponse.json({ ok: true, topic });
}
