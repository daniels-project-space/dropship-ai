import assert from "node:assert/strict";
import test from "node:test";
import { dispatchTriggerDecision, missingReceiptPlatforms, providerDeliveryDecision } from "../src/lib/distributionState.ts";

test("crash after local scheduling but before a provider receipt becomes reconciliation, never a repost", () => {
  // The local post rows are written before the durable `processing` fence. If the worker dies
  // after that fence, a later worker retains the schedule but may only read/reconcile.
  assert.equal(providerDeliveryDecision("pending"), "deliver");
  assert.equal(providerDeliveryDecision("processing"), "reconcile_required");
  assert.equal(providerDeliveryDecision("ambiguous"), "reconcile_required");
  assert.equal(providerDeliveryDecision("delivered"), "already_delivered");
});

test("missing or partial provider receipts do not authorize a full fan-out retry", () => {
  assert.deepEqual(
    missingReceiptPlatforms(["tiktok", "instagram", "youtube"], { tiktok: "tt-1", youtube: "yt-1" }),
    ["instagram"],
  );
  assert.deepEqual(
    missingReceiptPlatforms(["tiktok", "instagram", "youtube"], {}),
    ["tiktok", "instagram", "youtube"],
  );
});

test("only a pending durable dispatch may enter Trigger; terminal and reconciliation states cannot requeue it", () => {
  assert.equal(dispatchTriggerDecision("pending"), "trigger");
  assert.equal(dispatchTriggerDecision("dispatched"), "already_dispatched");
  assert.equal(dispatchTriggerDecision("delivered"), "already_dispatched");
  assert.equal(dispatchTriggerDecision("reconcile_required"), "reconcile_required");
});
