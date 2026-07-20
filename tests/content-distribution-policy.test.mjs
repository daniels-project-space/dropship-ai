import assert from "node:assert/strict";
import test from "node:test";
import { matchesDataMode } from "../convex/sampleScope.ts";
import { assertLabelGate, distribute } from "../src/lib/distribute.ts";

test("live analytics exclude seeded rows and sample mode never includes live rows", () => {
  assert.equal(matchesDataMode({}), true);
  assert.equal(matchesDataMode({ sample: false }), true);
  assert.equal(matchesDataMode({ sample: true }), false);
  assert.equal(matchesDataMode({ sample: true }, "sample"), true);
  assert.equal(matchesDataMode({ sample: false }, "sample"), false);
});

test("an AI creative cannot cross the distribution boundary without a burned disclosure", () => {
  assert.throws(
    () => assertLabelGate({ aiGenerated: true, aiLabelRequired: true, labelBurned: false }),
    /Refusing to publish/,
  );
  assert.doesNotThrow(
    () => assertLabelGate({ aiGenerated: true, aiLabelRequired: true, labelBurned: true }),
  );
});

test("semi-manual brands do not call a public distribution provider", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("provider must not be called");
  };
  try {
    const result = await distribute(
      {
        aiGenerated: true,
        aiLabelRequired: true,
        labelBurned: true,
        mediaUrl: "https://example.invalid/creative.mp4",
        caption: "A reviewed creative",
      },
      { distributionMode: "semi_manual" },
    );
    assert.deepEqual(result, {
      mode: "semi_manual",
      ok: true,
      reason: "brand is in semi-manual distribution mode; operator must publish externally.",
    });
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("automated distribution fails closed without the deployment live-effects acknowledgement", async () => {
  const previous = {
    effects: process.env.DROPSHIP_AI_LIVE_EFFECTS,
    confirm: process.env.DROPSHIP_AI_LIVE_EFFECTS_CONFIRM,
  };
  delete process.env.DROPSHIP_AI_LIVE_EFFECTS;
  delete process.env.DROPSHIP_AI_LIVE_EFFECTS_CONFIRM;
  try {
    await assert.rejects(
      distribute(
        {
          aiGenerated: false,
          aiLabelRequired: false,
          labelBurned: false,
          mediaUrl: "https://example.invalid/creative.mp4",
          caption: "A reviewed creative",
        },
        { distributionMode: "automated" },
      ),
      /live effects are disabled/,
    );
  } finally {
    if (previous.effects === undefined) delete process.env.DROPSHIP_AI_LIVE_EFFECTS;
    else process.env.DROPSHIP_AI_LIVE_EFFECTS = previous.effects;
    if (previous.confirm === undefined) delete process.env.DROPSHIP_AI_LIVE_EFFECTS_CONFIRM;
    else process.env.DROPSHIP_AI_LIVE_EFFECTS_CONFIRM = previous.confirm;
  }
});
