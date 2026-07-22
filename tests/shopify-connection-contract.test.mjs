import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { verifyShopifyVaultToken } from "../src/lib/shopifyAuth.ts";
import { assertShopifyIdentity, vaultRefForDomain } from "../src/lib/shopifyIdentity.ts";
import { boundedShopifySinceDays } from "../src/lib/shopifySync.ts";

test("first connection accepts only the same token resolved through the deterministic vault reference", async () => {
  const original = { fetch: globalThis.fetch, token: process.env.VAULT_ACCESS_TOKEN, url: process.env.VAULT_URL };
  process.env.VAULT_ACCESS_TOKEN = "fixture-vault-capability";
  process.env.VAULT_URL = "https://vault.test/api/query";
  const seen = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    seen.push(request.args.keyName);
    return new Response(JSON.stringify({ value: { value: "shpat_fixture_same" } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    assert.equal(vaultRefForDomain("calm-collar.myshopify.com"), "shopify/CALM_COLLAR");
    assert.equal(await verifyShopifyVaultToken("calm-collar.myshopify.com", "shpat_fixture_same"), "shpat_fixture_same");
    assert.equal(await verifyShopifyVaultToken("calm-collar.myshopify.com", "shpat_fixture_other"), null);
    assert.deepEqual(seen, ["CALM_COLLAR", "CALM_COLLAR"]);
  } finally {
    globalThis.fetch = original.fetch;
    if (original.token === undefined) delete process.env.VAULT_ACCESS_TOKEN; else process.env.VAULT_ACCESS_TOKEN = original.token;
    if (original.url === undefined) delete process.env.VAULT_URL; else process.env.VAULT_URL = original.url;
  }
});

test("Shopify verification fails before persistence on domain/currency mismatch and clamps economics history", () => {
  assert.doesNotThrow(() => assertShopifyIdentity("store.myshopify.com", "store.myshopify.com", "USD"));
  assert.throws(() => assertShopifyIdentity("store.myshopify.com", "other.myshopify.com", "USD"), /identity/);
  assert.throws(() => assertShopifyIdentity("store.myshopify.com", "store.myshopify.com", "CAD"), /requires USD/);
  assert.equal(boundedShopifySinceDays(-10), 1);
  assert.equal(boundedShopifySinceDays(30.9), 30);
  assert.equal(boundedShopifySinceDays(999), 60);
});

test("connect UI and readiness distinguish recurring proof from one-time configuration", async () => {
  const [connectRoute, settingsTab, readiness] = await Promise.all([
    fs.readFile(new URL("../app/api/shopify/connect/route.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../app/sites/[siteId]/tabs/SettingsTab.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../app/api/status/route.ts", import.meta.url), "utf8"),
  ]);
  assert.ok(connectRoute.indexOf("verifyShopifyVaultToken") < connectRoute.indexOf("api.sites.connectStore"));
  assert.match(connectRoute, /state: "vault_setup_required"/);
  assert.match(settingsTab, /Needs re-verification/);
  assert.match(settingsTab, /one-time token check alone does not connect/);
  assert.match(readiness, /one-time operator token check is never counted as recurring access/);
});
