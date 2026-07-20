import assert from "node:assert/strict";
import test from "node:test";
import { getProduct, getVariants, refreshAccessToken } from "../src/lib/cj.ts";
import { parseCjEvidence } from "../src/lib/cjEvidence.ts";
import { deriveCjEconomics } from "../src/lib/sourcingPolicy.ts";

test("CJ product reads use GET, access-token authentication, and no cache", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ result: true, data: { id: "ok" } }), { status: 200 });
  };
  try {
    assert.deepEqual(await getProduct("product-1", "access-token"), { id: "ok" });
    assert.deepEqual(await getVariants("product-1", "US", "access-token"), { id: "ok" });
    assert.equal(calls[0].options.method, "GET");
    assert.equal(calls[0].options.headers["CJ-Access-Token"], "access-token");
    assert.equal(calls[0].options.cache, "no-store");
    assert.match(calls[0].url, /product\/query\?pid=product-1/);
    assert.match(calls[1].url, /product\/variant\/query\?pid=product-1&countryCode=US/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CJ refresh exchanges only the refresh token and returns rotated credentials to server callers", async () => {
  const originalFetch = globalThis.fetch;
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url: String(url), options };
    return new Response(JSON.stringify({ result: true, data: { accessToken: "new-access", refreshToken: "new-refresh" } }), { status: 200 });
  };
  try {
    assert.deepEqual(await refreshAccessToken("old-refresh"), { accessToken: "new-access", refreshToken: "new-refresh" });
    assert.match(call.url, /authentication\/refreshAccessToken$/);
    assert.deepEqual(JSON.parse(call.options.body), { refreshToken: "old-refresh" });
    assert.equal(call.options.headers["CJ-Access-Token"], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CJ evidence is parsed from a verified US variant and unknown shipping never becomes zero", () => {
  const evidence = parseCjEvidence({
    productId: "product-1",
    variantId: "variant-1",
    product: { productNameEn: "Verified widget", isFreeShipping: true },
    variants: [{ vid: "variant-1", variantSellPrice: "12.50" }],
    inventory: [],
    variant: { vid: "variant-1", variantSellPrice: "12.50" },
    variantInventory: [{ countryCode: "US", totalInventoryNum: 7, verifiedWarehouse: 1 }],
  });
  assert.deepEqual(evidence, {
    cjProductId: "product-1",
    cjVariantId: "variant-1",
    title: "Verified widget",
    cogsUsd: 12.5,
    shippingUsd: 0,
    inventoryQty: 7,
    fromUsWarehouse: true,
    inventoryVerified: true,
    sourceUrl: "https://developers.cjdropshipping.com/api2.0/v1/product/query?pid=product-1",
  });
  const unknownShipping = parseCjEvidence({
    productId: "product-2", variantId: "variant-2", product: { productNameEn: "No shipping quote" }, variants: [], inventory: [], variant: { variantSellPrice: 2 }, variantInventory: [{ countryCode: "US", totalInventoryNum: 1, verifiedWarehouse: 1 }],
  });
  assert.equal(unknownShipping.shippingUsd, undefined);
  assert.throws(() => deriveCjEconomics(unknownShipping, 50), /unknown COGS or shipping cost/);
});
