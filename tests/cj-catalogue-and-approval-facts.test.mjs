import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCjCatalogueSearch } from "../src/lib/cjCatalog.ts";
import { sourcedDraftApprovalFacts } from "../src/lib/sourcedDraftApprovalFacts.ts";

test("CJ search exposes exact US variants with unknown costs left unknown", () => {
  const results = normalizeCjCatalogueSearch({ content: [{ pid: "p1", productNameEn: "Widget" }] }, [{ productId: "p1", variants: [{ vid: "v-us", countryCode: "US", variantNameEn: "Blue", variantSellPrice: "8.50" }], inventory: [{ vid: "v-us", countryCode: "US", totalInventoryNum: "7" }] }]);
  assert.deepEqual(results, [{ cjProductId: "p1", title: "Widget", variants: [{ cjVariantId: "v-us", label: "Blue", inventoryQty: 7, cogsUsd: 8.5, shippingUsd: null }] }]);
});

test("approval facts include the exact sourcing and Shopify-DRAFT decision facts", () => {
  const facts = sourcedDraftApprovalFacts("import_sourced_product", { title: "Widget", cjProductId: "p1", cjVariantId: "v1", evidenceReadAt: 1, inventoryQty: 7, cogsUsd: 8, shippingUsd: 2, landedCostUsd: 10, priceUsd: 40, contributionMarginPct: 75 });
  assert.deepEqual(facts, { title: "Widget", cjProductId: "p1", cjVariantId: "v1", evidenceReadAt: 1, inventoryQty: 7, cogsUsd: 8, shippingUsd: 2, landedCostUsd: 10, priceUsd: 40, contributionMarginPct: 75 });
  assert.equal(sourcedDraftApprovalFacts("import_sourced_product", { cjProductId: "p1" }), null);
});
