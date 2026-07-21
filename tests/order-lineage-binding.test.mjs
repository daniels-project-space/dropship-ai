import assert from "node:assert/strict";
import test from "node:test";
import { hasVerifiedShopifyCjLineage } from "../src/lib/orderLineageState.ts";
import { hasValidSandboxCjApprovalBinding } from "../src/lib/sandboxCjBinding.ts";
import { cjOrderInputHash } from "../src/lib/cjOrder.ts";
import { cjStagingGenerationFingerprint } from "../src/lib/cjStagingState.ts";

const product = { siteId: "site-a", shopifyProductId: "gid://shopify/Product/1", shopifyVariantId: "gid://shopify/ProductVariant/1", shopifyDraftImportStatus: "created", cjEvidenceId: "evidence-a", cjProductId: "cj-product-a", cjVariantId: "cj-variant-a", cjFromCountryCode: "US" };
const evidence = { siteId: "site-a", cjProductId: "cj-product-a", cjVariantId: "cj-variant-a", fromCountryCode: "US" };

test("Convex order-lineage reducer rejects wrong Shopify site, product, variant, and CJ evidence", () => {
  const line = { productId: product.shopifyProductId, variantId: product.shopifyVariantId };
  assert.equal(hasVerifiedShopifyCjLineage({ siteId: "site-a", line, product, evidence }), true);
  assert.equal(hasVerifiedShopifyCjLineage({ siteId: "site-b", line, product, evidence }), false);
  assert.equal(hasVerifiedShopifyCjLineage({ siteId: "site-a", line: { ...line, productId: "gid://shopify/Product/2" }, product, evidence }), false);
  assert.equal(hasVerifiedShopifyCjLineage({ siteId: "site-a", line: { ...line, variantId: "gid://shopify/ProductVariant/2" }, product, evidence }), false);
  assert.equal(hasVerifiedShopifyCjLineage({ siteId: "site-a", line, product, evidence: { ...evidence, cjVariantId: "cj-variant-b" } }), false);
});

test("Convex approval reducer rejects wrong action, order, site, logistics, and sandbox binding", () => {
  const cjOrderInput = { orderNumber: "dsa-sb-a", shippingZip: "90210", shippingCountryCode: "US", shippingCountry: "United States", shippingProvince: "CA", shippingCity: "Beverly Hills", shippingAddress: "1 Test Way", shippingCustomerName: "Test User", shippingPhone: "555", logisticName: "Quoted route", fromCountryCode: "US", products: [{ vid: "v1", quantity: 1 }] };
  const inputHash = cjOrderInputHash(cjOrderInput);
  const cjLogisticsPreflight = { logisticName: "Quoted route", fromCountryCode: "US", quotedAt: 123, quotedPriceUsd: 4.5 };
  const fingerprint = cjStagingGenerationFingerprint({ generation: 2, inputHash, quoteInputDigest: "quote-a", ...cjLogisticsPreflight });
  const order = { _id: "order-a", siteId: "site-a", cjApprovalActionId: "action-a", cjDispatchGeneration: 2, cjDispatchGenerationFingerprint: fingerprint, cjQuoteInputDigest: "quote-a", cjOrderInputHash: inputHash, cjOrderInput, cjLogisticsPreflight };
  const action = { _id: "action-a", siteId: "site-a", type: "dispatch_cj_sandbox_order", status: "approved", params: { orderId: "order-a", orderNumber: "dsa-sb-a", inputHash, generation: 2, generationFingerprint: fingerprint, quoteInputDigest: "quote-a", isSandbox: 1, payType: 3, logisticName: "Quoted route", fromCountryCode: "US", logisticsQuotedAt: 123, logisticsQuotedPriceUsd: 4.5 } };
  assert.equal(hasValidSandboxCjApprovalBinding({ actionId: "action-a", action, order }), true);
  assert.equal(hasValidSandboxCjApprovalBinding({ actionId: "action-b", action, order }), false);
  assert.equal(hasValidSandboxCjApprovalBinding({ actionId: "action-a", action: { ...action, params: { ...action.params, orderId: "order-b" } }, order }), false);
  assert.equal(hasValidSandboxCjApprovalBinding({ actionId: "action-a", action: { ...action, siteId: "site-b" }, order }), false);
  assert.equal(hasValidSandboxCjApprovalBinding({ actionId: "action-a", action: { ...action, params: { ...action.params, logisticName: "unverified" } }, order }), false);
  assert.equal(hasValidSandboxCjApprovalBinding({ actionId: "action-a", action: { ...action, params: { ...action.params, generation: 1 } }, order }), false);
  assert.equal(hasValidSandboxCjApprovalBinding({ actionId: "action-a", action: { ...action, params: { ...action.params, quoteInputDigest: "quote-b" } }, order }), false);
  assert.equal(hasValidSandboxCjApprovalBinding({ actionId: "action-a", action: { ...action, params: { ...action.params, logisticsQuotedAt: 124 } }, order }), false);
  assert.equal(hasValidSandboxCjApprovalBinding({ actionId: "action-a", action: { ...action, params: { ...action.params, logisticsQuotedPriceUsd: 4.6 } }, order }), false);
  assert.equal(hasValidSandboxCjApprovalBinding({ actionId: "action-a", action: { ...action, params: { ...action.params, fromCountryCode: "CN" } }, order }), false);
  assert.equal(hasValidSandboxCjApprovalBinding({ actionId: "action-a", action: { ...action, params: { ...action.params, isSandbox: 0 } }, order }), false);
});
