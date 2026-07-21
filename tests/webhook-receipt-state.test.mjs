import assert from "node:assert/strict";
import test from "node:test";
import { webhookDeliveryDecision, cjTrackingMappingDecision, shopifyReceiptDecision } from "../src/lib/webhookReceiptState.ts";

test("Convex Shopify/CJ receipt reducer maps duplicate delivery IDs exactly once", () => {
  assert.equal(webhookDeliveryDecision(null), "apply");
  assert.equal(webhookDeliveryDecision({ provider: "shopify", deliveryId: "delivery-1" }), "duplicate");
  assert.equal(webhookDeliveryDecision({ provider: "cj", deliveryId: "delivery-1" }), "duplicate");
});

test("Shopify duplicate delivery IDs reject changed payload hashes fail closed", () => {
  const prior = { payloadHash: "a", topic: "orders/create" };
  assert.equal(shopifyReceiptDecision(prior, { payloadHash: "a", topic: "orders/create" }), "duplicate");
  assert.equal(shopifyReceiptDecision(prior, { payloadHash: "b", topic: "orders/create" }), "reject_changed");
  assert.equal(shopifyReceiptDecision(prior, { payloadHash: "a", topic: "orders/updated" }), "reject_changed");
});

test("Convex CJ receipt reducer rejects cross-site and mismatched order identities", () => {
  assert.equal(cjTrackingMappingDecision({ order: { siteId: "site-a", cjOrderId: "cj-a" }, siteId: "site-a", incomingCjOrderId: "cj-a" }), "apply");
  assert.equal(cjTrackingMappingDecision({ order: { siteId: "site-a", cjOrderId: "cj-a" }, siteId: "site-b", incomingCjOrderId: "cj-a" }), "ignore");
  assert.equal(cjTrackingMappingDecision({ order: { siteId: "site-a", cjOrderId: "cj-a" }, siteId: "site-a", incomingCjOrderId: "cj-b" }), "ignore");
  assert.equal(cjTrackingMappingDecision({ order: null, siteId: "site-a", incomingCjOrderId: "cj-a" }), "ignore");
});
