import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { createOperatorSession, verifyOperatorSession } from "../src/lib/auth/session.ts";
import { isCreativeAssetKey } from "../src/lib/storageKey.ts";
import { requireOperator } from "../src/lib/auth/server.ts";
import { proxy } from "../proxy.ts";
import { GET as getAsset } from "../app/api/asset/route.ts";
import { GET as getStatus } from "../app/api/status/route.ts";
import { POST as postGenerate } from "../app/api/generate/route.ts";
import { POST as postSchedule } from "../app/api/schedule/route.ts";
import { POST as postShopifyConnect } from "../app/api/shopify/connect/route.ts";
import { POST as postShopifySync } from "../app/api/shopify/sync/route.ts";
import { POST as postShopifyTestCheckout } from "../app/api/shopify/test-checkout/route.ts";
import { POST as postShopifyDraftImport } from "../app/api/shopify/import-draft/route.ts";
import { POST as postCjRefresh } from "../app/api/cj/refresh/route.ts";
import { POST as postDiscover } from "../app/api/research/discover/route.ts";
import { POST as postSourceCj } from "../app/api/research/source-cj/route.ts";
import { POST as postApprovalResolve } from "../app/api/approvals/resolve/route.ts";
import { GET as getOperatorToken } from "../app/api/auth/token/route.ts";
import { POST as postLogout } from "../app/api/auth/logout/route.ts";

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
  // Flip the final base64url character rather than assigning a fixed value: a valid HMAC can
  // itself end in "x", which made this security test intermittently leave the session unchanged.
  const alteredFinalCharacter = signature.endsWith("x") ? "y" : "x";
  assert.equal(await verifyOperatorSession(`${payload}.${signature.slice(0, -1)}${alteredFinalCharacter}`, secret), false);
  // HMAC output is 32 bytes, so its final base64url sextet has four canonical encodings. A
  // non-zero unused padding bit used to decode to the same bytes; canonical decoding rejects it.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const index = alphabet.indexOf(signature.at(-1));
  const nonCanonical = alphabet[index | 1];
  assert.equal(await verifyOperatorSession(`${payload}.${signature.slice(0, -1)}${nonCanonical}`, secret), false);
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

test("every operator route independently rejects a forged session", async () => {
  const original = process.env.DROPSHIP_AI_SESSION_SECRET;
  process.env.DROPSHIP_AI_SESSION_SECRET = secret;
  const forgedHeaders = {
    cookie: "dropship_ai_operator=forged.signature",
    origin: "https://control.example",
    "content-type": "application/json",
  };
  const get = () => new Request("https://control.example/api/protected", { headers: forgedHeaders });
  const post = () => new Request("https://control.example/api/protected", {
    method: "POST",
    headers: forgedHeaders,
    body: "{}",
  });
  try {
    const responses = await Promise.all([
      getAsset(new Request("https://control.example/api/asset?key=creatives/site_123/final.mp4", { headers: forgedHeaders })),
      getStatus(get()),
      getOperatorToken(get()),
      postGenerate(post()),
      postSchedule(post()),
      postShopifyConnect(post()),
      postShopifySync(post()),
      postShopifyTestCheckout(post()),
      postShopifyDraftImport(post()),
      postCjRefresh(post()),
      postDiscover(post()),
      postSourceCj(post()),
      postApprovalResolve(post()),
      postLogout(post()),
    ]);
    for (const response of responses) {
      assert.equal(response.status, 401);
    }
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
