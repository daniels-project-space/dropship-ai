import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import triggerConfigModule from "../trigger.config.ts";
import { mintServiceJwt } from "../src/lib/auth/jwt.ts";

test("Trigger build installs official FFmpeg and syncs the exact RS256 caller inputs", async () => {
  const triggerConfig = triggerConfigModule.default ?? triggerConfigModule;
  const source = await fs.readFile(new URL("../trigger.config.ts", import.meta.url), "utf8");
  assert.equal(source.includes("DROPSHIP_AI_SERVICE_TOKEN"), false);
  for (const name of ["DROPSHIP_AI_AUTH_ISSUER", "DROPSHIP_AI_AUTH_AUDIENCE", "DROPSHIP_AI_AUTH_KID", "DROPSHIP_AI_AUTH_PRIVATE_KEY"]) {
    assert.equal(source.includes(name), true, `${name} must be synced to Trigger`);
  }
  const extension = triggerConfig.build?.extensions?.find((item) => item.name === "ffmpeg");
  assert.ok(extension?.onBuildComplete);
  const layers = [];
  await extension.onBuildComplete({ target: "deploy", addLayer: (layer) => layers.push(layer), logger: { debug() {}, warn() {}, error() {}, info() {}, log() {} } });
  assert.deepEqual(layers[0].image.pkgs, ["ffmpeg"]);
  assert.equal(layers[0].deploy.env.FFMPEG_PATH, "/usr/bin/ffmpeg");
});

test("service JWT carries the issuer, audience and kid consumed by Convex", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const names = ["DROPSHIP_AI_AUTH_ISSUER", "DROPSHIP_AI_AUTH_AUDIENCE", "DROPSHIP_AI_AUTH_KID", "DROPSHIP_AI_AUTH_PRIVATE_KEY"];
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    DROPSHIP_AI_AUTH_ISSUER: "https://dropship.example",
    DROPSHIP_AI_AUTH_AUDIENCE: "convex-dropship",
    DROPSHIP_AI_AUTH_KID: "dropship-test-kid",
    DROPSHIP_AI_AUTH_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  });
  try {
    const [headerPart, payloadPart] = mintServiceJwt(1_700_000_000).split(".");
    const header = JSON.parse(Buffer.from(headerPart, "base64url").toString());
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString());
    assert.deepEqual(header, { alg: "RS256", typ: "JWT", kid: "dropship-test-kid" });
    assert.equal(payload.iss, "https://dropship.example");
    assert.equal(payload.aud, "convex-dropship");
    assert.equal(payload.sub, "dropship-ai:service");
    assert.equal(payload.exp - payload.iat, 300);
  } finally {
    for (const name of names) prior[name] === undefined ? delete process.env[name] : process.env[name] = prior[name];
  }
});

test("readiness does not claim unsupported Higgsfield or Replicate callers", async () => {
  const source = await fs.readFile(new URL("../app/api/status/route.ts", import.meta.url), "utf8");
  assert.equal(/higgsfield|replicate/i.test(source), false);
  for (const state of ["configured", "unverified", "verified", "blocked"]) assert.equal(source.includes(`\"${state}\"`), true);
});
