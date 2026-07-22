import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/shopify/connect/route.ts";
import { createOperatorSession, OPERATOR_SESSION_COOKIE } from "../src/lib/auth/session.ts";

const sessionSecret = "shopify-connect-route-fixture-secret-longer-than-thirty-two";

test("malformed Shopify connect JSON performs zero provider or state activity", async () => {
  const original = { secret: process.env.DROPSHIP_AI_SESSION_SECRET, fetch: globalThis.fetch };
  process.env.DROPSHIP_AI_SESSION_SECRET = sessionSecret;
  const session = await createOperatorSession(sessionSecret);
  let activity = 0;
  globalThis.fetch = async () => { activity++; throw new Error("external activity must not occur"); };
  const valid = { siteId: "j1234567890", shopifyDomain: "fixture.myshopify.com", accessToken: "shpat_fixture_token" };
  const fixtures = [
    null,
    [],
    "not-an-object",
    { ...valid, siteId: { value: valid.siteId } },
    { ...valid, siteId: "s".repeat(129) },
    { ...valid, shopifyDomain: { value: valid.shopifyDomain } },
    { ...valid, shopifyDomain: `${"a".repeat(64)}.myshopify.com` },
    { ...valid, shopifyDomain: "https://fixture.myshopify.com" },
    { ...valid, accessToken: { value: valid.accessToken } },
    { ...valid, accessToken: "x".repeat(513) },
  ];
  try {
    for (const body of fixtures) {
      const response = await POST(new Request("https://control.example/api/shopify/connect", {
        method: "POST",
        headers: {
          origin: "https://control.example",
          cookie: `${OPERATOR_SESSION_COOKIE}=${session}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }));
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "invalid Shopify connect request" });
    }
    assert.equal(activity, 0);
  } finally {
    globalThis.fetch = original.fetch;
    if (original.secret === undefined) delete process.env.DROPSHIP_AI_SESSION_SECRET;
    else process.env.DROPSHIP_AI_SESSION_SECRET = original.secret;
  }
});
