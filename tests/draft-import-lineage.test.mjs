import assert from "node:assert/strict";
import test from "node:test";
import { actionMatchesApprovedDraftImport, shopifyDraftTraceDetail } from "../src/lib/draftImportLineage.ts";

const product = {
  _id: "product_1", siteId: "site_1", cjEvidenceId: "evidence_1", cjProductId: "p1", cjVariantId: "v1",
  priceUsd: 40, cogsUsd: 8, shippingUsd: 2, landedCostUsd: 10, contributionMarginPct: 75, sourceVerifiedAt: 123,
};

const action = {
  siteId: "site_1", type: "import_sourced_product", riskTier: "human_gated", status: "approved",
  params: { productId: "product_1", evidenceId: "evidence_1", cjProductId: "p1", cjVariantId: "v1", priceUsd: 40, cogsUsd: 8, shippingUsd: 2, landedCostUsd: 10, contributionMarginPct: 75, evidenceReadAt: 123 },
};

test("approved Shopify DRAFT reservation binds the action's evidenceReadAt to product lineage", () => {
  assert.equal(actionMatchesApprovedDraftImport(action, product), true);
  assert.equal(actionMatchesApprovedDraftImport({ ...action, params: { ...action.params, evidenceReadAt: 124 } }, product), false);
  assert.equal(actionMatchesApprovedDraftImport({ ...action, params: { ...action.params, evidenceReadAt: undefined, sourceVerifiedAt: 123 } }, product), false);
});

test("reserved Shopify trace retains complete causal identity for success or ambiguity", () => {
  assert.deepEqual(shopifyDraftTraceDetail({ actionId: "action_1", evidenceId: "evidence_1", requestId: "request_1", cjProductId: "p1", cjVariantId: "v1", productId: "product_1" }), {
    actionId: "action_1", evidenceId: "evidence_1", requestId: "request_1", cjProductId: "p1", cjVariantId: "v1", productId: "product_1", published: false,
  });
});
