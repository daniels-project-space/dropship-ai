import { createHmac, timingSafeEqual } from "node:crypto";

export const CJ_WEBHOOK_MAX_BYTES = 256 * 1024;
export const CJ_WEBHOOK_SUCCESS = { code: 200, result: "success", message: "ok" } as const;

export type CjWebhookEnvelope = {
  messageId: string;
  type: string;
  messageType: string;
  params: Record<string, unknown>;
};

export type CjOrderWebhook = CjWebhookEnvelope & {
  type: "ORDER";
  params: Record<string, unknown> & { orderNumber: string };
};

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new Error(`cj webhook: ${name} is invalid`);
  }
  return value;
}

/** Parse CJ's documented envelope without reserializing the bytes used for authentication. */
export function parseCjWebhookEnvelope(rawBody: Buffer): CjWebhookEnvelope {
  if (rawBody.byteLength < 2 || rawBody.byteLength > CJ_WEBHOOK_MAX_BYTES) {
    throw new Error("cj webhook: body size is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new Error("cj webhook: body is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("cj webhook: body must be an object");
  }
  const record = value as Record<string, unknown>;
  const type = boundedString(record.type, "type", 20);
  const messageId = boundedString(record.messageId, "messageId", type === "ORDER" ? 50 : 200);
  const messageType = boundedString(record.messageType, "messageType", 15);
  if (!record.params || typeof record.params !== "object" || Array.isArray(record.params)) {
    throw new Error("cj webhook: params must be an object");
  }
  return { messageId, type, messageType, params: record.params as Record<string, unknown> };
}

/** Narrow the documented ORDER payload and bound every field that can reach durable state. */
export function parseCjOrderWebhook(envelope: CjWebhookEnvelope): CjOrderWebhook {
  if (envelope.type !== "ORDER") throw new Error("cj webhook: not an ORDER message");
  const orderNumber = boundedString(envelope.params.orderNumber, "params.orderNumber", 200);
  for (const field of ["cjOrderId", "orderStatus", "logisticName", "trackNumber", "trackingUrl"] as const) {
    const value = envelope.params[field];
    if (value !== undefined && value !== null) boundedString(value, `params.${field}`, 200);
  }
  return { ...envelope, type: "ORDER", params: { ...envelope.params, orderNumber } };
}

/** CJ signs the exact raw bytes with openId and sends padded standard Base64 in `sign`. */
export function verifyCjWebhookSignature(openId: string, rawBody: Buffer, signature: string): boolean {
  if (!/^[0-9]{1,20}$/.test(openId) || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  const supplied = Buffer.from(signature, "base64");
  // Buffer's decoder is permissive, so require the canonical padded standard-Base64 spelling.
  if (supplied.byteLength !== 32 || supplied.toString("base64") !== signature) return false;
  const expected = createHmac("sha256", openId).update(rawBody).digest();
  return timingSafeEqual(expected, supplied);
}

export type ParsedCjTracking = {
  cjOrderId?: string;
  orderNumber: string;
  trackNumber?: string;
  trackingUrl?: string;
  logisticName?: string;
  status?: string;
};

export function trackingFromCjOrder(payload: CjOrderWebhook): ParsedCjTracking {
  const stringOrUndefined = (key: string): string | undefined => {
    const value = payload.params[key];
    return typeof value === "string" && value.length ? value : undefined;
  };
  const cjOrderId = stringOrUndefined("cjOrderId");
  const trackNumber = stringOrUndefined("trackNumber");
  const trackingUrl = stringOrUndefined("trackingUrl");
  const logisticName = stringOrUndefined("logisticName");
  const status = stringOrUndefined("orderStatus");
  return {
    orderNumber: payload.params.orderNumber,
    ...(cjOrderId ? { cjOrderId } : {}),
    ...(trackNumber ? { trackNumber } : {}),
    ...(trackingUrl ? { trackingUrl } : {}),
    ...(logisticName ? { logisticName } : {}),
    ...(status ? { status } : {}),
  };
}

/** Unknown CJ topics are acknowledged without invoking a state writer. */
export async function settleVerifiedCjWebhook(
  rawBody: Buffer,
  recordOrder: (payload: CjOrderWebhook) => Promise<void>,
): Promise<"order" | "ignored_type"> {
  const envelope = parseCjWebhookEnvelope(rawBody);
  if (envelope.type !== "ORDER") return "ignored_type";
  await recordOrder(parseCjOrderWebhook(envelope));
  return "order";
}
