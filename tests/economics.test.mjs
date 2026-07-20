import assert from "node:assert/strict";
import test from "node:test";
import { calculateLandedEconomics, evaluateSourcedDraftGate } from "../src/lib/economics.ts";

const base = {
  priceUsd: 100,
  cogsUsd: 15,
  shippingUsd: 5,
  dutyUsd: 2,
  paymentFeeUsd: 3,
  refundReserveUsd: 4,
  contentCostUsd: 1,
};

test("landed economics includes every required cost", () => {
  const economics = calculateLandedEconomics(base);
  assert.equal(economics.landedCostUsd, 22);
  assert.equal(economics.totalCostUsd, 30);
  assert.equal(economics.contributionUsd, 70);
  assert.equal(economics.contributionMarginPct, 70);
});

test("unsafe sourced candidate is denied before a draft can be written", () => {
  const result = evaluateSourcedDraftGate({
    ...base,
    inventoryQty: 12,
    fromUsWarehouse: true,
    sourceVerifiedAt: 1_000,
    now: 1_100,
    minimumPriceUsd: 50,
    minimumMarginPct: 75,
  });
  assert.deepEqual(result.eligible, false);
  assert.equal(result.reason, "contribution margin is below the site's floor");
});

test("fresh US evidence that clears the floor is eligible", () => {
  const result = evaluateSourcedDraftGate({
    ...base,
    inventoryQty: 1,
    fromUsWarehouse: true,
    sourceVerifiedAt: 1_000,
    now: 1_100,
    minimumPriceUsd: 50,
    minimumMarginPct: 70,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.economics.contributionMarginPct, 70);
});

test("stale evidence and non-US inventory are denied", () => {
  const stale = evaluateSourcedDraftGate({
    ...base,
    inventoryQty: 1,
    fromUsWarehouse: true,
    sourceVerifiedAt: 1,
    now: 24 * 60 * 60 * 1000 + 2,
    minimumPriceUsd: 50,
    minimumMarginPct: 1,
  });
  assert.equal(stale.eligible, false);
  assert.match(stale.reason, /less than 24 hours/);
  const nonUs = evaluateSourcedDraftGate({
    ...base,
    inventoryQty: 1,
    fromUsWarehouse: false,
    sourceVerifiedAt: 1_000,
    now: 1_100,
    minimumPriceUsd: 50,
    minimumMarginPct: 1,
  });
  assert.equal(nonUs.eligible, false);
  assert.equal(nonUs.reason, "US warehouse inventory is required");
});
