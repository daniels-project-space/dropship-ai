import assert from "node:assert/strict";
import test from "node:test";
import { CjTokenCoordinator } from "../src/lib/cjTokenRotation.ts";

function memoryStore(initial) {
  let bundle = { ...initial };
  return {
    read: async () => ({ ...bundle }),
    replace: async (expectedRefreshToken, next) => {
      if (bundle.refreshToken !== expectedRefreshToken) return "conflict";
      bundle = { ...next };
      return "written";
    },
    snapshot: () => ({ ...bundle }),
  };
}

test("API-key connection persists openId and the complete CJ bundle atomically", async () => {
  const store = memoryStore({ openId: "111", accessToken: "old-access", refreshToken: "old-refresh" });
  let connectCalls = 0;
  const coordinator = new CjTokenCoordinator(store, async () => { throw new Error("not used"); }, async (apiKey) => {
    connectCalls++;
    assert.equal(apiKey, "independent-api-key");
    return { openId: "222", accessToken: "new-access", refreshToken: "new-refresh", accessTokenExpiryDate: "tomorrow" };
  });
  await coordinator.connectApiKey("independent-api-key");
  assert.equal(connectCalls, 1);
  assert.deepEqual(store.snapshot(), { openId: "222", accessToken: "new-access", refreshToken: "new-refresh", accessTokenExpiryDate: "tomorrow" });
});

test("a restarted worker reads the persisted rotated CJ pair rather than stale process memory", async () => {
  const store = memoryStore({ openId: "123", accessToken: "old-access", refreshToken: "old-refresh" });
  const first = new CjTokenCoordinator(store, async () => ({ accessToken: "rotated-access", refreshToken: "rotated-refresh" }), async () => { throw new Error("not used"); });
  assert.equal(await first.refreshAccessToken(), "rotated-access");
  assert.equal(store.snapshot().openId, "123", "refresh retains the persisted openId omitted by CJ");
  const restarted = new CjTokenCoordinator(store, async () => { throw new Error("not used"); }, async () => { throw new Error("not used"); });
  assert.equal(await restarted.getAccessToken(), "rotated-access");
});

test("concurrent 401 refreshes issue one CJ refresh and all callers converge on the atomically written pair", async () => {
  const store = memoryStore({ openId: "123", accessToken: "old-access", refreshToken: "old-refresh" });
  let refreshCalls = 0;
  const coordinator = new CjTokenCoordinator(store, async () => {
    refreshCalls++;
    await Promise.resolve();
    return { accessToken: "rotated-access", refreshToken: "rotated-refresh" };
  }, async () => { throw new Error("not used"); });
  assert.deepEqual(await Promise.all([coordinator.refreshAccessToken(), coordinator.refreshAccessToken(), coordinator.refreshAccessToken()]), ["rotated-access", "rotated-access", "rotated-access"]);
  assert.equal(refreshCalls, 1);
  assert.deepEqual(store.snapshot(), { openId: "123", accessToken: "rotated-access", refreshToken: "rotated-refresh" });
});

test("a compare-and-swap conflict reloads the winning persisted pair without a second refresh", async () => {
  const store = memoryStore({ openId: "123", accessToken: "old-access", refreshToken: "old-refresh" });
  let refreshCalls = 0;
  const conflictingStore = {
    read: store.read,
    replace: async () => {
      await store.replace("old-refresh", { openId: "123", accessToken: "other-access", refreshToken: "other-refresh" });
      return "conflict";
    },
  };
  const coordinator = new CjTokenCoordinator(conflictingStore, async () => {
    refreshCalls++;
    return { accessToken: "lost-access", refreshToken: "lost-refresh" };
  }, async () => { throw new Error("not used"); });
  assert.equal(await coordinator.refreshAccessToken(), "other-access");
  assert.equal(refreshCalls, 1);
});

test("a stale warm instance reloads a durable winner before consuming a one-time refresh token", async () => {
  const store = memoryStore({ openId: "123", accessToken: "old-access", refreshToken: "old-refresh" });
  const stale = new CjTokenCoordinator(store, async () => { throw new Error("stale refresh must not run"); }, async () => { throw new Error("not used"); });
  assert.equal(await stale.getAccessToken(), "old-access");
  await store.replace("old-refresh", { openId: "123", accessToken: "winner-access", refreshToken: "winner-refresh" });
  assert.equal(await stale.refreshAccessToken(), "winner-access");
});

test("a failed durable reload blocks refresh rather than spending a cached one-time token", async () => {
  let refreshCalls = 0;
  const coordinator = new CjTokenCoordinator({
    read: async () => { throw new Error("durable read unavailable"); },
    replace: async () => "written",
  }, async () => { refreshCalls++; return { accessToken: "new", refreshToken: "new-refresh" }; }, async () => { throw new Error("not used"); });
  await assert.rejects(() => coordinator.refreshAccessToken(), /durable read unavailable/);
  assert.equal(refreshCalls, 0);
});
