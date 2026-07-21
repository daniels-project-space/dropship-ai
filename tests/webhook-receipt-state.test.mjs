import assert from "node:assert/strict";
import test from "node:test";
import { webhookDeliveryDecision, cjTrackingMappingDecision } from "../src/lib/webhookReceiptState.ts";

test("Convex Shopify/CJ receipt reducer maps duplicate delivery IDs exactly once", () => {
  assert.equal(webhookDeliveryDecision(null), "apply");
  assert.equal(webhookDeliveryDecision({ provider: "shopify", deliveryId: "delivery-1" }), "duplicate");
  assert.equal(webhookDeliveryDecision({ provider: "cj", deliveryId: "delivery-1" }), "duplicate");
});

test("Convex CJ receipt reducer rejects cross-site and mismatched order identities", () => {
  assert.equal(cjTrackingMappingDecision({ order: { siteId: "site-a", cjOrderId: "cj-a" }, siteId: "site-a", incomingCjOrderId: "cj-a" }), "apply");
  assert.equal(cjTrackingMappingDecision({ order: { siteId: "site-a", cjOrderId: "cj-a" }, siteId: "site-b", incomingCjOrderId: "cj-a" }), "ignore");
  assert.equal(cjTrackingMappingDecision({ order: { siteId: "site-a", cjOrderId: "cj-a" }, siteId: "site-a", incomingCjOrderId: "cj-b" }), "ignore");
  assert.equal(cjTrackingMappingDecision({ order: null, siteId: "site-a", incomingCjOrderId: "cj-a" }), "ignore");
});
