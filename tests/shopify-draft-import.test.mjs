import assert from "node:assert/strict";
import test from "node:test";
import { productCreate } from "../src/lib/shopify.ts";

test("Shopify product import is structurally draft-only", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    if (request.query.includes("productVariantsBulkUpdate")) {
      return new Response(JSON.stringify({ data: { productVariantsBulkUpdate: { productVariants: [{ id: "gid://shopify/ProductVariant/1", price: "42.00", sku: "cj-variant-1" }], userErrors: [] } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { productCreate: { product: { id: "gid://shopify/Product/1", title: "Verified widget", handle: "verified-widget", media: { nodes: [{ mediaContentType: "IMAGE" }] }, variants: { nodes: [{ id: "gid://shopify/ProductVariant/1" }] } }, userErrors: [] } } }), { status: 200 });
  };
  try {
    const created = await productCreate({ shop: "example.myshopify.com", accessToken: "token" }, { title: "Verified widget", priceUsd: 42, cjVariantId: "cj-variant-1", mediaUrl: "https://images.example/widget.jpg" });
    assert.equal(created.id, "gid://shopify/Product/1");
    assert.equal(created.variantId, "gid://shopify/ProductVariant/1");
    assert.match(requests[0].query, /ProductCreateInput/);
    assert.doesNotMatch(requests[0].query, /ProductInput/);
    // The first mutation is DRAFT-only and carries the immutable CJ image; the second sets the
    // exact sell price and CJ VID SKU on Shopify's initial variant.
    assert.deepEqual(requests[0].variables, { product: { title: "Verified widget", status: "DRAFT" }, media: [{ originalSource: "https://images.example/widget.jpg", mediaContentType: "IMAGE" }] });
    assert.deepEqual(requests[1].variables, { productId: "gid://shopify/Product/1", variants: [{ id: "gid://shopify/ProductVariant/1", price: "42.00", sku: "cj-variant-1" }] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
