import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import {
  CJ_WEBHOOK_MAX_BYTES,
  CJ_WEBHOOK_SUCCESS,
  parseCjOrderWebhook,
  parseCjWebhookEnvelope,
  settleVerifiedCjWebhook,
  trackingFromCjOrder,
  verifyCjWebhookSignature,
} from "../src/lib/cjWebhook.ts";
import { getIndependentAccountTokenBundle, parseIndependentAccountTokenResponse, refreshAccessToken } from "../src/lib/cj.ts";
import { selectCjOpenId } from "../src/lib/cjOpenId.ts";
import { POST as postCjWebhook } from "../app/api/webhooks/cj/route.ts";

const fixture = (name) => fs.readFile(new URL(`./fixtures/cj/${name}`, import.meta.url), "utf8");

test("official CJ ORDER fixture uses the documented envelope and raw-byte Base64 HMAC", async () => {
  const raw = Buffer.from(await fixture("order-update.json"));
  const openId = "12312";
  const sign = createHmac("sha256", openId).update(raw).digest("base64");
  assert.equal(verifyCjWebhookSignature(openId, raw, sign), true);
  assert.equal(verifyCjWebhookSignature(openId, raw, createHmac("sha256", openId).update(raw).digest("hex")), false, "hex is not CJ's contract");
  assert.equal(verifyCjWebhookSignature(openId, raw, sign.slice(0, -2) + "AA"), false);
  const order = parseCjOrderWebhook(parseCjWebhookEnvelope(raw));
  assert.deepEqual(trackingFromCjOrder(order), {
    orderNumber: "api_52f268d40b8d460e82c0683955e63cc9",
    cjOrderId: "210823100016290555",
    logisticName: "CJPacket Ordinary",
    status: "CREATED",
  });
  assert.deepEqual(CJ_WEBHOOK_SUCCESS, { code: 200, result: "success", message: "ok" });
});

test("CJ webhook parsing is bounded and unknown types settle without an order writer", async () => {
  assert.throws(() => parseCjWebhookEnvelope(Buffer.alloc(CJ_WEBHOOK_MAX_BYTES + 1, 0x20)), /body size/);
  assert.throws(() => parseCjOrderWebhook(parseCjWebhookEnvelope(Buffer.from(JSON.stringify({
    messageId: "m".repeat(50), type: "ORDER", messageType: "UPDATE", params: { orderNumber: "o".repeat(201) },
  })))), /orderNumber/);
  assert.throws(() => parseCjWebhookEnvelope(Buffer.from(JSON.stringify({
    messageId: "m", type: "ORDER", messageType: "X".repeat(16), params: { orderNumber: "order" },
  }))), /messageType/);
  let writes = 0;
  const raw = Buffer.from(JSON.stringify({ messageId: "ca72a4834cd14b9588e88ce206f614a0", type: "PRODUCT", messageType: "UPDATE", params: { pid: "1" } }));
  assert.equal(await settleVerifiedCjWebhook(raw, async () => { writes++; }), "ignored_type");
  assert.equal(writes, 0);
});

test("official get-token fixture is requested with apiKey and captures openId as a string", async () => {
  const raw = await fixture("get-access-token-success.json");
  assert.deepEqual(parseIndependentAccountTokenResponse(raw, 200), {
    openId: "123456789",
    accessToken: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    accessTokenExpiryDate: "2021-08-18T09:16:33+08:00",
    refreshToken: "f7edabe65c3b4a198b50ca8f969e36eb",
    refreshTokenExpiryDate: "2022-02-07T09:16:33+08:00",
    createDate: "2021-08-11T09:16:33+08:00",
  });
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), body: JSON.parse(init.body) };
    return new Response(raw, { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await getIndependentAccountTokenBundle("CJUserNum@api@fixture");
    assert.deepEqual(request, { url: "https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken", body: { apiKey: "CJUserNum@api@fixture" } });
    assert.equal(result.openId, "123456789");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("official refresh fixture omits openId", async () => {
  const raw = await fixture("refresh-access-token-success.json");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(raw, { status: 200, headers: { "content-type": "application/json" } });
  try {
    const result = await refreshAccessToken("fixture-refresh");
    assert.equal("openId" in result, false);
    assert.equal(result.refreshToken, "f7edabe65c3b4a198b50ca8f969e36eb");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CJ route source has one callback contract and no invented x-cj/siteId inputs", async () => {
  const source = await fs.readFile(new URL("../app/api/webhooks/cj/route.ts", import.meta.url), "utf8");
  assert.match(source, /headers\.get\("sign"\)/);
  for (const stale of ["x-cj-signature", "x-cj-hmac-sha256", "x-cj-topic", "x-cj-webhook-id", "searchParams.get(\"siteId\")"]) assert.equal(source.includes(stale), false);
});

test("CJ webhook prefers durable openId and fails closed on a stale environment alias", async () => {
  assert.equal(selectCjOpenId("22222", undefined), "22222");
  assert.equal(selectCjOpenId(null, "11111"), "11111");
  assert.throws(() => selectCjOpenId("22222", "11111"), (error) => {
    assert.match(error.message, /configuration conflict/);
    assert.equal(error.message.includes("22222"), false);
    assert.equal(error.message.includes("11111"), false);
    return true;
  });

  const original = {
    fetch: globalThis.fetch,
    openId: process.env.CJ_OPEN_ID,
    vaultToken: process.env.VAULT_ACCESS_TOKEN,
    vaultUrl: process.env.VAULT_URL,
  };
  process.env.CJ_OPEN_ID = "11111";
  process.env.VAULT_ACCESS_TOKEN = "fixture-vault-capability";
  process.env.VAULT_URL = "https://vault.test/api/query";
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ value: { value: "22222" } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const raw = Buffer.from(await fixture("order-update.json"));
    const response = await postCjWebhook(new Request("https://control.example/api/webhooks/cj", {
      method: "POST",
      headers: { sign: createHmac("sha256", "11111").update(raw).digest("base64") },
      body: raw,
    }));
    assert.equal(response.status, 503);
    assert.equal(calls, 1, "only the durable vault read occurs; no Convex writer runs");
    const text = await response.text();
    assert.equal(text.includes("11111"), false);
    assert.equal(text.includes("22222"), false);
  } finally {
    globalThis.fetch = original.fetch;
    for (const [key, value] of [["CJ_OPEN_ID", original.openId], ["VAULT_ACCESS_TOKEN", original.vaultToken], ["VAULT_URL", original.vaultUrl]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
