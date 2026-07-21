import assert from "node:assert/strict";
import test from "node:test";
import { quoteCjFreight, selectVerifiedCjFreight } from "../src/lib/cj.ts";

test("CJ logistics preflight is read-only, binds the verified origin, and never invents a carrier", async () => {
  const originalFetch = globalThis.fetch;
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url: String(url), options };
    return new Response(JSON.stringify({ result: true, data: [{ logisticName: "Route B", logisticPrice: 4.5 }, { logisticName: "Route A", logisticPrice: 4.5 }] }), { status: 200 });
  };
  try {
    const quotes = await quoteCjFreight({ fromCountryCode: "us", destinationCountryCode: "US", shippingZip: "90210", products: [{ vid: "cj-v1", quantity: 1 }] }, "token");
    assert.match(call.url, /logistic\/freightCalculate$/);
    assert.equal(call.options.method, "POST");
    assert.deepEqual(JSON.parse(call.options.body), { startCountryCode: "US", endCountryCode: "US", zip: "90210", products: [{ vid: "cj-v1", quantity: 1 }] });
    assert.deepEqual(selectVerifiedCjFreight(quotes), { logisticName: "Route A", logisticPriceUsd: 4.5 });
    assert.throws(() => selectVerifiedCjFreight([]), /no valid logistics route/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
