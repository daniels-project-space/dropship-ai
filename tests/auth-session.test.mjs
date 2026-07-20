import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { createOperatorSession, verifyOperatorSession } from "../src/lib/auth/session.ts";
import { isCreativeAssetKey } from "../src/lib/storageKey.ts";
import { requireOperator } from "../src/lib/auth/server.ts";
import { proxy } from "../proxy.ts";

const secret = "a-session-secret-that-is-longer-than-thirty-two-characters";

test("a valid operator session verifies and expires", async () => {
  const now = 1_700_000_000_000;
  const session = await createOperatorSession(secret, now);
  assert.equal(await verifyOperatorSession(session, secret, now + 1), true);
  assert.equal(await verifyOperatorSession(session, secret, now + 8 * 60 * 60 * 1000 + 1), false);
});

test("a modified session is denied", async () => {
  const session = await createOperatorSession(secret);
  const [payload, signature] = session.split(".");
  assert.equal(await verifyOperatorSession(`${payload}.${signature.slice(0, -1)}x`, secret), false);
  assert.equal(await verifyOperatorSession(session, `${secret}changed`), false);
});

test("R2 preview keys are limited to canonical creative objects", () => {
  assert.equal(isCreativeAssetKey("creatives/site_123/final-video.mp4"), true);
  assert.equal(isCreativeAssetKey("sample/private.mp4"), false);
  assert.equal(isCreativeAssetKey("creatives/site_123/../../secrets.txt"), false);
  assert.equal(isCreativeAssetKey("creatives/site_123/video.mp4?response-content-type=text/plain"), false);
});

test("missing or forged operator sessions are denied before API work", async () => {
  const original = process.env.DROPSHIP_AI_SESSION_SECRET;
  process.env.DROPSHIP_AI_SESSION_SECRET = secret;
  try {
    const noSession = await requireOperator(new Request("https://control.example/api/asset"), { csrf: false });
    assert.deepEqual(noSession, { ok: false, status: 401, error: "authentication required" });
    const forged = await requireOperator(new Request("https://control.example/api/asset", { headers: { cookie: "dropship_ai_operator=forged.signature" } }), { csrf: false });
    assert.deepEqual(forged, { ok: false, status: 401, error: "authentication required" });
  } finally {
    if (original === undefined) delete process.env.DROPSHIP_AI_SESSION_SECRET;
    else process.env.DROPSHIP_AI_SESSION_SECRET = original;
  }
});

test("proxy cryptographically verifies protected page sessions", async () => {
  const original = process.env.DROPSHIP_AI_SESSION_SECRET;
  process.env.DROPSHIP_AI_SESSION_SECRET = secret;
  try {
    const forged = await proxy(new NextRequest("https://control.example/dashboard", {
      headers: { cookie: "dropship_ai_operator=forged.signature" },
    }));
    assert.equal(forged.status, 307);
    assert.equal(new URL(forged.headers.get("location")).pathname, "/login");

    const session = await createOperatorSession(secret);
    const valid = await proxy(new NextRequest("https://control.example/dashboard", {
      headers: { cookie: `dropship_ai_operator=${session}` },
    }));
    assert.equal(valid.status, 200);
  } finally {
    if (original === undefined) delete process.env.DROPSHIP_AI_SESSION_SECRET;
    else process.env.DROPSHIP_AI_SESSION_SECRET = original;
  }
});
