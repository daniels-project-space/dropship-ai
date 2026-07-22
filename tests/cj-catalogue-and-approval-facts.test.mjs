import assert from "node:assert/strict";
import test from "node:test";
import { cjCatalogueSearchProducts, normalizeCjCatalogueSearch } from "../src/lib/cjCatalog.ts";
import { sourcedDraftApprovalFacts } from "../src/lib/sourcedDraftApprovalFacts.ts";

test("CJ listV2 nesting and Product Details inventory shape expose exact US variants", () => {
  // Exact documented listV2 shape: grouping records contain productList, not product rows.
  const search = { content: [{ productList: [{ id: "p1", nameEn: "Widget" }] }] };
  assert.deepEqual(cjCatalogueSearchProducts(search), [{ id: "p1", nameEn: "Widget" }]);
  // Exact documented variant shape has no countryCode. Country belongs to inventories.
  const results = normalizeCjCatalogueSearch(search, [{ productId: "p1", product: { variants: [{ vid: "v-us", variantNameEn: "Blue", variantSellPrice: "8.50", inventories: [{ countryCode: "US", totalInventory: 7, verifiedWarehouse: 1 }] }, { vid: "v-cn", variantNameEn: "Red", variantSellPrice: "8.50", inventories: [{ countryCode: "CN", totalInventory: 9, verifiedWarehouse: 1 }] }] } }]);
  assert.deepEqual(results, [{ cjProductId: "p1", title: "Widget", variants: [{ cjVariantId: "v-us", label: "Blue", inventoryQty: 7, cogsUsd: 8.5, shippingUsd: null }] }]);
});

test("approval facts include the exact sourcing and Shopify-DRAFT decision facts", () => {
  const facts = sourcedDraftApprovalFacts("import_sourced_product", { title: "Widget", cjProductId: "p1", cjVariantId: "v1", evidenceReadAt: 1, inventoryQty: 7, cogsUsd: 8, shippingUsd: 2, landedCostUsd: 10, priceUsd: 40, contributionMarginPct: 75 });
  assert.deepEqual(facts, { title: "Widget", cjProductId: "p1", cjVariantId: "v1", evidenceReadAt: 1, inventoryQty: 7, cogsUsd: 8, shippingUsd: 2, landedCostUsd: 10, priceUsd: 40, contributionMarginPct: 75 });
  assert.equal(sourcedDraftApprovalFacts("import_sourced_product", { cjProductId: "p1" }), null);
});
