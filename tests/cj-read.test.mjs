import assert from "node:assert/strict";
import test from "node:test";
import { getProduct, getVariants, refreshAccessToken } from "../src/lib/cj.ts";
import { parseCjEvidence } from "../src/lib/cjEvidence.ts";
import { deriveCjEconomics, evaluatePersistedCjEvidence } from "../src/lib/sourcingPolicy.ts";

test("CJ product reads use GET, access-token authentication, and no cache", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ result: true, data: { id: "ok" } }), { status: 200 });
  };
  try {
    assert.deepEqual(await getProduct("product-1", "US", "access-token"), { id: "ok" });
    assert.deepEqual(await getVariants("product-1", "US", "access-token"), { id: "ok" });
    assert.equal(calls[0].options.method, "GET");
    assert.equal(calls[0].options.headers["CJ-Access-Token"], "access-token");
    assert.equal(calls[0].options.cache, "no-store");
    assert.match(calls[0].url, /product\/query\?pid=product-1&countryCode=US/);
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

test("an expired server-held CJ token fails closed before rotating without an atomic token-bundle writer", async () => {
  const originalFetch = globalThis.fetch;
  const originalAccess = process.env.CJ_ACCESS_TOKEN;
  const originalRefresh = process.env.CJ_REFRESH_TOKEN;
  const calls = [];
  process.env.CJ_ACCESS_TOKEN = "expired-access";
  process.env.CJ_REFRESH_TOKEN = "rotation-refresh";
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("refreshAccessToken")) {
      return new Response(JSON.stringify({ result: true, data: { accessToken: "rotated-access", refreshToken: "rotated-refresh" } }), { status: 200 });
    }
    if (calls.filter((call) => String(call.url).includes("product/query")).length === 1) {
      return new Response(JSON.stringify({ result: false, message: "expired" }), { status: 401 });
    }
    return new Response(JSON.stringify({ result: true, data: { id: "after-rotation" } }), { status: 200 });
  };
  try {
    await assert.rejects(() => getProduct("product-rotation", "US"), /atomic control-plane token-bundle writer is not installed/);
    const productCalls = calls.filter((call) => call.url.includes("product/query"));
    assert.equal(productCalls.length, 1);
    assert.equal(productCalls[0].options.headers["CJ-Access-Token"], "expired-access");
    assert.equal(calls.some((call) => call.url.includes("refreshAccessToken")), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAccess === undefined) delete process.env.CJ_ACCESS_TOKEN;
    else process.env.CJ_ACCESS_TOKEN = originalAccess;
    if (originalRefresh === undefined) delete process.env.CJ_REFRESH_TOKEN;
    else process.env.CJ_REFRESH_TOKEN = originalRefresh;
  }
});

test("CJ evidence is parsed from a verified US variant and unknown shipping never becomes zero", () => {
  const evidence = parseCjEvidence({
    productId: "product-1",
    variantId: "variant-1",
    product: { productNameEn: "Verified widget", isFreeShipping: true, productImage: "https://images.example/widget.jpg" },
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
    fromCountryCode: "US",
    inventoryVerified: true,
    sourceUrl: "https://developers.cjdropshipping.com/api2.0/v1/product/query?pid=product-1",
    mediaUrl: "https://images.example/widget.jpg",
  });
  const unknownShipping = parseCjEvidence({
    productId: "product-2", variantId: "variant-2", product: { productNameEn: "No shipping quote" }, variants: [], inventory: [], variant: { variantSellPrice: 2 }, variantInventory: [{ countryCode: "US", totalInventoryNum: 1, verifiedWarehouse: 1 }],
  });
  assert.equal(unknownShipping.shippingUsd, undefined);
  assert.throws(() => deriveCjEconomics(unknownShipping, 50), /unknown COGS or shipping cost/);
});

test("country-filtered Product Details binds the selected variant to its own US inventory", () => {
  const evidence = parseCjEvidence({
    productId: "product-1",
    variantId: "variant-us",
    product: {
      productNameEn: "Verified widget",
      variants: [
        { vid: "variant-us", variantNameEn: "US", variantSellPrice: 12.5, inventories: [{ countryCode: "US", totalInventory: 7, verifiedWarehouse: 1 }] },
        { vid: "variant-cn", variantNameEn: "CN", variantSellPrice: 8, inventories: [{ countryCode: "CN", totalInventory: 99, verifiedWarehouse: 1 }] },
      ],
    },
    variants: [], inventory: [], variant: {}, variantInventory: [],
  });
  assert.equal(evidence.cjVariantId, "variant-us");
  assert.equal(evidence.cogsUsd, 12.5);
  assert.equal(evidence.inventoryQty, 7);
  assert.equal(evidence.fromUsWarehouse, true);
  assert.equal(evidence.inventoryVerified, true);
});

test("persisted CJ evidence is rechecked when a draft is activated or imported", () => {
  const evidence = {
    cogsUsd: 12.5,
    shippingUsd: 0,
    inventoryQty: 7,
    fromUsWarehouse: true,
    inventoryVerified: true,
    mediaUrl: "https://images.example/widget.jpg",
    readAt: 1_000,
  };
  const policy = { priceUsd: 100, minimumPriceUsd: 50, minimumMarginPct: 60, now: 1_100 };
  assert.equal(evaluatePersistedCjEvidence(evidence, policy).eligible, true);
  assert.match(
    evaluatePersistedCjEvidence(evidence, { ...policy, now: 24 * 60 * 60 * 1000 + 1_001 }).reason,
    /less than 24 hours/,
  );
  assert.match(
    evaluatePersistedCjEvidence({ ...evidence, shippingUsd: undefined }, policy).reason,
    /unknown COGS or shipping cost/,
  );
  const belowMargin = evaluatePersistedCjEvidence({ ...evidence, cogsUsd: 90 }, policy);
  assert.equal(belowMargin.eligible, false);
  assert.equal(belowMargin.reason, "contribution margin is below the site's floor");
  assert.match(evaluatePersistedCjEvidence({ ...evidence, mediaUrl: undefined }, policy).reason, /no verified product media/);
});
