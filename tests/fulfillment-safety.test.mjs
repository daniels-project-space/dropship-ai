import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createZeroChargeDraftCheckout } from "../src/lib/shopify.ts";
import { createSandboxOrder, getSandboxOrderByOrderNumber } from "../src/lib/cj.ts";
import { assertLiveEffectsEnabled, sandboxShopAllowed } from "../src/lib/effects.ts";
import { cjOrderInputHash, normalizeCjOrderInput, sandboxDispatchDecision, sandboxOrderNumber } from "../src/lib/cjOrder.ts";
import { verifyShopifyHmac } from "../app/api/webhooks/shopify/route.ts";
import { verifyCjHmac } from "../app/api/webhooks/cj/route.ts";

test("sandbox checkout creates only an explicitly zero-dollar draft and never sends or completes it", async () => {
  const originalFetch = globalThis.fetch;
  const originalSandboxEffects = process.env.DROPSHIP_AI_SANDBOX_EFFECTS;
  const originalSandboxShops = process.env.SHOPIFY_SANDBOX_SHOPS;
  let call;
  process.env.DROPSHIP_AI_SANDBOX_EFFECTS = "enabled";
  process.env.SHOPIFY_SANDBOX_SHOPS = "dev.myshopify.com";
  globalThis.fetch = async (url, options) => {
    call = { url: String(url), options };
    return new Response(JSON.stringify({ data: { draftOrderCreate: {
      draftOrder: { id: "gid://shopify/DraftOrder/1", name: "#D1", invoiceUrl: "https://shop.example/invoice", status: "OPEN", totalPriceSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } } },
      userErrors: [],
    } } }), { status: 200 });
  };
  try {
    const result = await createZeroChargeDraftCheckout({ shop: "dev.myshopify.com", accessToken: "token" }, { traceId: "trace_12345678" });
    const request = JSON.parse(call.options.body);
    assert.match(request.query, /draftOrderCreate/);
    assert.deepEqual(request.variables.input.lineItems[0], {
      title: "JARVIS sandbox checkout verification — no fulfillment",
      quantity: 1,
      originalUnitPrice: "0.00",
      requiresShipping: false,
      taxable: false,
    });
    assert.equal(request.variables.input.customAttributes.find((a) => a.key === "fulfillment").value, "disabled");
    assert.equal(result.totalAmount, "0.00");
    assert.equal(result.id, "gid://shopify/DraftOrder/1");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSandboxEffects === undefined) delete process.env.DROPSHIP_AI_SANDBOX_EFFECTS;
    else process.env.DROPSHIP_AI_SANDBOX_EFFECTS = originalSandboxEffects;
    if (originalSandboxShops === undefined) delete process.env.SHOPIFY_SANDBOX_SHOPS;
    else process.env.SHOPIFY_SANDBOX_SHOPS = originalSandboxShops;
  }
});

test("CJ sandbox dispatch is create-only, binds isSandbox=1, and has no real-effect flags", async () => {
  const originalFetch = globalThis.fetch;
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url: String(url), options };
    return new Response(JSON.stringify({ result: true, data: { orderId: "cj-1" } }), { status: 200 });
  };
  try {
    const input = {
      orderNumber: "ignored", shippingZip: "00000", shippingCountryCode: "US", shippingCountry: "United States",
      shippingProvince: "CA", shippingCity: "Test", shippingAddress: "Sandbox", shippingCustomerName: "Test", shippingPhone: "0000000000",
      logisticName: "Verified CJ route", fromCountryCode: "US",
      products: [{ vid: "variant", quantity: 1 }],
    };
    const orderNumber = sandboxOrderNumber("site_1", "gid://shopify/Order/1");
    const persisted = normalizeCjOrderInput(input, orderNumber);
    assert.deepEqual(await createSandboxOrder(persisted, "token"), { orderId: "cj-1", orderNumber });
    assert.match(call.url, /shopping\/order\/createOrderV2$/);
    assert.equal(JSON.parse(call.options.body).payType, 3);
    assert.equal(JSON.parse(call.options.body).isSandbox, 1);
    assert.equal(JSON.parse(call.options.body).orderNumber, orderNumber);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a persisted input snapshot and approval fingerprint are stable; reserved or ambiguous work must reconcile", () => {
  const orderNumber = sandboxOrderNumber("site_1", "gid://shopify/Order/1");
  const first = normalizeCjOrderInput({
    orderNumber: "untrusted", shippingZip: "00000", shippingCountryCode: "us", shippingCountry: "United States",
    shippingProvince: "CA", shippingCity: "Test", shippingAddress: "Sandbox", shippingCustomerName: "Test", shippingPhone: "0000000000",
    logisticName: "Verified CJ route", fromCountryCode: "US",
    products: [{ vid: "variant", quantity: 1 }],
  }, orderNumber);
  const replay = normalizeCjOrderInput({ ...first, orderNumber: "other" }, orderNumber);
  assert.equal(cjOrderInputHash(first), cjOrderInputHash(replay));
  assert.equal(sandboxDispatchDecision("staged"), "reserve");
  assert.equal(sandboxDispatchDecision("reserved"), "reconcile");
  assert.equal(sandboxDispatchDecision("ambiguous"), "reconcile");
  assert.equal(sandboxDispatchDecision("sent"), "reused");
  assert.equal(sandboxDispatchDecision("failed"), "blocked");
});

test("sandbox identities are deterministic, CJ-safe, and collision-resistant across distinct orders", () => {
  const first = sandboxOrderNumber("site_1", "gid://shopify/Order/1");
  const repeat = sandboxOrderNumber("site_1", "gid://shopify/Order/1");
  const otherOrder = sandboxOrderNumber("site_1", "gid://shopify/Order/2");
  const otherSite = sandboxOrderNumber("site_2", "gid://shopify/Order/1");
  assert.equal(first, repeat);
  assert.notEqual(first, otherOrder);
  assert.notEqual(first, otherSite);
  assert.match(first, /^dsa-sb-[a-f0-9]{32}$/);
  assert.ok(first.length <= 50);
});

test("CJ reconciliation accepts only an isSandbox=1 order with the exact stable identity", async () => {
  const originalFetch = globalThis.fetch;
  const orderNumber = sandboxOrderNumber("site_1", "gid://shopify/Order/1");
  try {
    for (const providerSandbox of [1, true]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ result: true, data: { orderId: "cj-1", orderNum: orderNumber, isSandbox: providerSandbox } }), { status: 200 });
      assert.deepEqual(await getSandboxOrderByOrderNumber(orderNumber, "token"), { orderId: "cj-1", orderNumber, isSandbox: 1 });
    }
    globalThis.fetch = async () => new Response(JSON.stringify({ result: true, data: { orderId: "cj-1", orderNum: "different-order", isSandbox: 1 } }), { status: 200 });
    assert.equal(await getSandboxOrderByOrderNumber(orderNumber, "token"), null);
    globalThis.fetch = async () => new Response(JSON.stringify({ result: true, data: { orderId: "cj-1", orderNum: orderNumber, isSandbox: false } }), { status: 200 });
    await assert.rejects(() => getSandboxOrderByOrderNumber(orderNumber, "token"), /non-sandbox/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider writes fail closed unless each sandbox/live gate is explicitly configured", () => {
  const previous = { ...process.env };
  try {
    delete process.env.DROPSHIP_AI_LIVE_EFFECTS;
    delete process.env.DROPSHIP_AI_LIVE_EFFECTS_CONFIRM;
    delete process.env.DROPSHIP_AI_SANDBOX_EFFECTS;
    delete process.env.SHOPIFY_SANDBOX_SHOPS;
    assert.throws(() => assertLiveEffectsEnabled("live"), /live effects are disabled/);
    assert.equal(sandboxShopAllowed("dev.myshopify.com"), false);
    process.env.DROPSHIP_AI_SANDBOX_EFFECTS = "enabled";
    process.env.SHOPIFY_SANDBOX_SHOPS = "dev.myshopify.com";
    assert.equal(sandboxShopAllowed("DEV.myshopify.com"), true);
    process.env.DROPSHIP_AI_LIVE_EFFECTS = "enabled";
    process.env.DROPSHIP_AI_LIVE_EFFECTS_CONFIRM = "I_UNDERSTAND_THIS_CAN_CREATE_EXTERNAL_EFFECTS";
    assert.doesNotThrow(() => assertLiveEffectsEnabled("live"));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test("webhook signatures are verified over the raw body and reject modified payloads", () => {
  const body = Buffer.from(JSON.stringify({ id: 1, total_price: "0.00" }));
  const shopify = crypto.createHmac("sha256", "secret").update(body).digest("base64");
  const cj = crypto.createHmac("sha256", "secret").update(body).digest("hex");
  assert.equal(verifyShopifyHmac("secret", body, shopify), true);
  assert.equal(verifyCjHmac("secret", body, cj), true);
  assert.equal(verifyShopifyHmac("secret", Buffer.from("{}"), shopify), false);
  assert.equal(verifyCjHmac("secret", Buffer.from("{}"), cj), false);
});
