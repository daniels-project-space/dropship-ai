import assert from "node:assert/strict";
import test from "node:test";
import { productCreate } from "../src/lib/shopify.ts";

test("Shopify product import is structurally draft-only", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({ data: { productCreate: { product: { id: "gid://shopify/Product/1", title: "Verified widget", handle: "verified-widget" }, userErrors: [] } } }), { status: 200 });
  };
  try {
    const created = await productCreate({ shop: "example.myshopify.com", accessToken: "token" }, { title: "Verified widget" });
    assert.equal(created.id, "gid://shopify/Product/1");
    assert.match(request.query, /ProductCreateInput/);
    assert.doesNotMatch(request.query, /ProductInput/);
    assert.deepEqual(request.variables, { product: { title: "Verified widget", status: "DRAFT" } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
