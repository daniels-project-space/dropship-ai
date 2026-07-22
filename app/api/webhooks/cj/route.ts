// POST /api/webhooks/cj — signed CJ tracking receiver. This is local state only; forwarding
// tracking to Shopify is a separately gated live effect and is deliberately absent here.
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getKey } from "@/src/lib/vault";
import { parseOrderWebhook } from "@/src/lib/cj";
import { convexClient, api } from "@/src/lib/convexClient";
import type { Id } from "@/convex/_generated/dataModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function webhookSecret(): Promise<string | null> {
  if (process.env.CJ_WEBHOOK_SECRET) return process.env.CJ_WEBHOOK_SECRET;
  return getKey("cj", "WEBHOOK_SECRET").catch(() => null);
}

/** CJ integrations have used both hexadecimal and base64 SHA-256 signatures. */
export function verifyCjHmac(secret: string, rawBody: Buffer, signature: string): boolean {
  const base64 = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const hex = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  for (const expected of [base64, hex]) {
    try {
      if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return true;
    } catch {
      // Try the other encoding, then fail closed.
    }
  }
  return false;
}

export async function POST(req: Request) {
  const secret = await webhookSecret();
  if (!secret) return NextResponse.json({ error: "webhook not configured" }, { status: 401 });

  const raw = Buffer.from(await req.arrayBuffer());
  const signature = req.headers.get("x-cj-signature") ?? req.headers.get("x-cj-hmac-sha256") ?? "";
  if (!signature || !verifyCjHmac(secret, raw, signature)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const tracking = parseOrderWebhook(payload);
  if (!tracking.orderNumber) return NextResponse.json({ ok: true, ignored: "no order number" });
  // Configure each site's CJ webhook URL with ?siteId=<Convex site id>. The signature protects
  // the request; the explicit tenant scope prevents a provider identifier collision from ever
  // selecting another site's order.
  const siteId = new URL(req.url).searchParams.get("siteId");
  if (!siteId) return NextResponse.json({ error: "siteId webhook scope is required" }, { status: 400 });
  const convex = convexClient();
  let order;
  try {
    order = await convex.query(api.orders.getByCjOrderNumber, { siteId: siteId as Id<"sites">, cjOrderNumber: tracking.orderNumber });
  } catch {
    return NextResponse.json({ error: "invalid siteId webhook scope" }, { status: 400 });
  }
  if (!order) return NextResponse.json({ ok: true, ignored: "unknown order" });

  const topic = req.headers.get("x-cj-topic") ?? "ORDER";
  const payloadHash = crypto.createHash("sha256").update(raw).digest("hex");
  const deliveryId = req.headers.get("x-cj-webhook-id") ?? req.headers.get("x-cj-event-id") ?? `digest:${topic}:${payloadHash}`;
  try {
    const result = await convex.mutation(api.webhooks.recordCjTracking, {
      siteId: siteId as Id<"sites">,
      deliveryId,
      topic,
      payloadHash,
      cjOrderNumber: tracking.orderNumber,
      trackingNumber: tracking.trackNumber,
      trackingUrl: tracking.trackingUrl,
      cjOrderId: tracking.cjOrderId,
    });
    return NextResponse.json({ ok: true, duplicate: result.duplicate, outcome: result.outcome, shopifyForwarding: "not-triggered" });
  } catch {
    return NextResponse.json({ error: "local webhook processing failed" }, { status: 503 });
  }
}
