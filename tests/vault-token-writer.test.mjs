import assert from "node:assert/strict";
import test from "node:test";
import { replaceCjTokenBundleAtomically } from "../src/lib/vault.ts";

test("CJ token writer accepts only explicit written/conflict response schemas", async () => {
  const old = { url: process.env.VAULT_TOKEN_BUNDLE_WRITER_URL, token: process.env.VAULT_TOKEN_BUNDLE_WRITER_TOKEN, fetch: globalThis.fetch };
  process.env.VAULT_TOKEN_BUNDLE_WRITER_URL = "https://writer.test/token";
  process.env.VAULT_TOKEN_BUNDLE_WRITER_TOKEN = "writer-token";
  try {
    for (const body of ["", "{}", JSON.stringify({ value: {} }), JSON.stringify({ value: { status: "unknown" } })]) {
      globalThis.fetch = async () => new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
      await assert.rejects(() => replaceCjTokenBundleAtomically("old-refresh", { openId: "123", accessToken: "new-access", refreshToken: "new-refresh" }), /invalid response/);
    }
    globalThis.fetch = async () => new Response(JSON.stringify({ value: { status: "written" } }), { status: 200, headers: { "Content-Type": "application/json" } });
    await assert.rejects(() => replaceCjTokenBundleAtomically("old-refresh", { openId: "123", accessToken: "new-access", refreshToken: "new-refresh" }), /including openId/);
    globalThis.fetch = async () => new Response(JSON.stringify({ value: { status: "written", retainedKeys: ["CJ_OPEN_ID", "CJ_ACCESS_TOKEN", "CJ_REFRESH_TOKEN"] } }), { status: 200, headers: { "Content-Type": "application/json" } });
    assert.equal(await replaceCjTokenBundleAtomically("old-refresh", { openId: "123", accessToken: "new-access", refreshToken: "new-refresh" }), "written");
  } finally {
    globalThis.fetch = old.fetch;
    if (old.url === undefined) delete process.env.VAULT_TOKEN_BUNDLE_WRITER_URL; else process.env.VAULT_TOKEN_BUNDLE_WRITER_URL = old.url;
    if (old.token === undefined) delete process.env.VAULT_TOKEN_BUNDLE_WRITER_TOKEN; else process.env.VAULT_TOKEN_BUNDLE_WRITER_TOKEN = old.token;
  }
});
