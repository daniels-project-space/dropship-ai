import type { CreateOrderInput } from "./cj";

/**
 * Shared, runtime-neutral order identity helpers. They deliberately avoid Node crypto because
 * the same validation runs in Convex before a provider boundary is crossed.
 */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function sandboxOrderNumber(siteId: string, shopifyOrderId: string): string {
  if (!siteId || !shopifyOrderId) throw new Error("siteId and shopifyOrderId are required");
  // CJ caps orderNumber at 50 characters. This contains no customer data and remains stable
  // across webhook redelivery and Trigger retries.
  return `dsa-sb-${fnv1a(`${siteId}\u0000${shopifyOrderId}`)}`;
}

export function normalizeCjOrderInput(input: CreateOrderInput, orderNumber: string): CreateOrderInput {
  if (!orderNumber || !input.shippingCountryCode || !input.shippingCountry || !input.shippingProvince
    || !input.shippingCity || !input.shippingAddress || !input.shippingCustomerName || !input.products.length) {
    throw new Error("CJ order input is incomplete");
  }
  if (input.products.some((line) => !line.vid || !Number.isInteger(line.quantity) || line.quantity <= 0)) {
    throw new Error("CJ order input has an invalid product line");
  }
  return {
    orderNumber,
    shippingZip: input.shippingZip,
    shippingCountryCode: input.shippingCountryCode.toUpperCase(),
    shippingCountry: input.shippingCountry,
    shippingProvince: input.shippingProvince,
    shippingCity: input.shippingCity,
    shippingAddress: input.shippingAddress,
    shippingCustomerName: input.shippingCustomerName,
    shippingPhone: input.shippingPhone,
    logisticName: input.logisticName,
    fromCountryCode: input.fromCountryCode,
    products: input.products.map((line) => ({ vid: line.vid, quantity: line.quantity })),
  };
}

/** Stable fingerprint used to bind one approval to the persisted, immutable input snapshot. */
export function cjOrderInputHash(input: CreateOrderInput): string {
  return fnv1a(JSON.stringify({
    orderNumber: input.orderNumber,
    shippingZip: input.shippingZip,
    shippingCountryCode: input.shippingCountryCode,
    shippingCountry: input.shippingCountry,
    shippingProvince: input.shippingProvince,
    shippingCity: input.shippingCity,
    shippingAddress: input.shippingAddress,
    shippingCustomerName: input.shippingCustomerName,
    shippingPhone: input.shippingPhone,
    logisticName: input.logisticName ?? null,
    fromCountryCode: input.fromCountryCode ?? null,
    products: input.products.map((line) => ({ vid: line.vid, quantity: line.quantity })),
  }));
}

export type SandboxDispatchState = "staged" | "reserved" | "ambiguous" | "sent" | "failed";

/** A provider write is never retried from reserved/ambiguous state until a read reconciliation. */
export function sandboxDispatchDecision(state: SandboxDispatchState | undefined): "reserve" | "reconcile" | "reused" | "blocked" {
  if (state === "sent") return "reused";
  if (state === "reserved" || state === "ambiguous") return "reconcile";
  if (state === "failed") return "blocked";
  return "reserve";
}
