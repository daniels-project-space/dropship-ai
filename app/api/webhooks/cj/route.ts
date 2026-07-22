// POST /api/webhooks/cj — CJ's single global ORDER callback. Authentication uses only the
// official `sign` header over the untouched request bytes with the account openId string.
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { convexClient, api } from "@/src/lib/convexClient";
import { getKey } from "@/src/lib/vault";
import {
  CJ_WEBHOOK_MAX_BYTES,
  CJ_WEBHOOK_SUCCESS,
  settleVerifiedCjWebhook,
  trackingFromCjOrder,
  verifyCjWebhookSignature,
} from "@/src/lib/cjWebhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3;

const RESPONSE_DEADLINE_MS = 2_500;

async function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = Math.max(1, deadline - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("deadline")), remaining); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cjOpenId(deadline: number): Promise<string | null> {
  const configured = process.env.CJ_OPEN_ID;
  if (configured) return configured;
  return beforeDeadline(getKey("cj", "CJ_OPEN_ID").catch(() => null), deadline);
}

export async function POST(request: Request) {
  const deadline = Date.now() + RESPONSE_DEADLINE_MS;
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > CJ_WEBHOOK_MAX_BYTES) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  let rawBody: Buffer;
  try {
    rawBody = Buffer.from(await beforeDeadline(request.arrayBuffer(), deadline));
  } catch {
    return NextResponse.json({ error: "webhook request body timed out" }, { status: 408 });
  }
  if (rawBody.byteLength > CJ_WEBHOOK_MAX_BYTES) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  let openId: string | null;
  try {
    openId = await cjOpenId(deadline);
  } catch {
    return NextResponse.json({ error: "webhook verification unavailable" }, { status: 503 });
  }
  const signature = request.headers.get("sign") ?? "";
  if (!openId || !verifyCjWebhookSignature(openId, rawBody, signature)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  try {
    await settleVerifiedCjWebhook(rawBody, async (payload) => {
      const tracking = trackingFromCjOrder(payload);
      const payloadHash = createHash("sha256").update(rawBody).digest("hex");
      await beforeDeadline(convexClient().mutation(api.webhooks.recordCjTracking, {
        deliveryId: payload.messageId,
        topic: payload.type,
        payloadHash,
        cjOrderNumber: tracking.orderNumber,
        trackingNumber: tracking.trackNumber,
        trackingUrl: tracking.trackingUrl,
        cjOrderId: tracking.cjOrderId,
      }), deadline);
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("cj webhook:")) {
      return NextResponse.json({ error: "invalid CJ webhook payload" }, { status: 400 });
    }
    return NextResponse.json({ error: "webhook processing unavailable" }, { status: 503 });
  }

  // This body matches CJ's documented listener response; no tenant or delivery facts leak back.
  return NextResponse.json(CJ_WEBHOOK_SUCCESS, { status: 200 });
}
