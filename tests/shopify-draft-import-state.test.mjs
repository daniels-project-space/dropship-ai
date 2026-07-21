import assert from "node:assert/strict";
import test from "node:test";
import { executeApprovedShopifyDraftImport } from "../src/lib/shopifyDraftImportExecutor.ts";
import { hasVerifiedInternalShopifyDraftLineage } from "../src/lib/shopifyDraftLineage.ts";

function dependencies(overrides = {}) {
  return {
    preflight: async () => ({ product: { title: "Verified widget" }, config: { shop: "test" } }),
    reserve: async () => ({ status: "reserved" }),
    createDraft: async () => ({ id: "gid://shopify/Product/1", title: "Verified widget" }),
    complete: async () => {},
    markAmbiguous: async () => {},
    ...overrides,
  };
}

test("wrong site/action/evidence reservation failures never reach Shopify or request reconciliation", async () => {
  let creates = 0;
  let ambiguous = 0;
  const result = await executeApprovedShopifyDraftImport(dependencies({
    reserve: async () => { throw new Error("a human-approved import action bound to this product evidence is required"); },
    createDraft: async () => { creates++; throw new Error("must not run"); },
    markAmbiguous: async () => { ambiguous++; },
  }));
  assert.deepEqual(result, { ok: false, error: "a human-approved import action bound to this product evidence is required", reconcileRequired: false });
  assert.equal(creates, 0);
  assert.equal(ambiguous, 0);
});

test("pre-boundary configuration failure is not ambiguous", async () => {
  let reserved = 0;
  let ambiguous = 0;
  const result = await executeApprovedShopifyDraftImport(dependencies({
    preflight: async () => { throw new Error("Shopify store is not connected"); },
    reserve: async () => { reserved++; return { status: "reserved" }; },
    markAmbiguous: async () => { ambiguous++; },
  }));
  assert.deepEqual(result, { ok: false, error: "Shopify store is not connected", reconcileRequired: false });
  assert.equal(reserved, 0);
  assert.equal(ambiguous, 0);
});

test("an ambiguous provider response is reconciled only after reservation", async () => {
  let ambiguous;
  const result = await executeApprovedShopifyDraftImport(dependencies({
    createDraft: async () => { throw new Error("network timeout after productCreate"); },
    markAmbiguous: async (error) => { ambiguous = error; },
  }));
  assert.deepEqual(result, { ok: false, error: "network timeout after productCreate", reconcileRequired: true });
  assert.equal(ambiguous, "network timeout after productCreate");
});

test("concurrent duplicate sees the internal draft lineage reuse and creates no second provider product", async () => {
  let creates = 0;
  const once = dependencies({ createDraft: async () => ({ id: `gid://shopify/Product/${++creates}`, title: "Verified widget" }) });
  const first = await executeApprovedShopifyDraftImport(once);
  const duplicate = await executeApprovedShopifyDraftImport(dependencies({
    reserve: async () => ({ status: "already_created", shopifyProductId: "gid://shopify/Product/1" }),
    createDraft: async () => { creates++; throw new Error("must not run"); },
  }));
  assert.equal(first.ok, true);
  assert.deepEqual(duplicate, { ok: true, reused: true, shopifyProductId: "gid://shopify/Product/1" });
  assert.equal(creates, 1);
});

test("a Shopify ID mirrored from the provider is never reported as this application's draft", () => {
  assert.equal(hasVerifiedInternalShopifyDraftLineage({ shopifyProductId: "gid://shopify/Product/1" }), false);
  assert.equal(hasVerifiedInternalShopifyDraftLineage({
    shopifyProductId: "gid://shopify/Product/1",
    shopifyDraftImportStatus: "created",
    trace: { operation: "shopify.product.create_draft", status: "succeeded", detail: { shopifyProductId: "gid://shopify/Product/1" } },
  }), true);
});

test("successful completion is draft-only and has no publish, order, or customer operation", async () => {
  const calls = [];
  const result = await executeApprovedShopifyDraftImport(dependencies({
    createDraft: async (_config, product) => { calls.push(["productCreate", product.title]); return { id: "gid://shopify/Product/1", title: product.title }; },
    complete: async () => { calls.push(["complete"]); },
  }));
  assert.deepEqual(result, { ok: true, shopifyProductId: "gid://shopify/Product/1", title: "Verified widget", status: "DRAFT" });
  assert.deepEqual(calls, [["productCreate", "Verified widget"], ["complete"]]);
});
