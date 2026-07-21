import assert from "node:assert/strict";
import test from "node:test";
import { RequestCoalescer } from "../src/lib/requestCoalescer.ts";

test("normalized search cache coalesces concurrent read-only provider work", async () => {
  const cache = new RequestCoalescer(30_000);
  let calls = 0;
  const load = async () => ({ call: ++calls });
  const [first, second] = await Promise.all([cache.get("widget", load), cache.get("widget", load)]);
  assert.deepEqual(first, { call: 1 });
  assert.deepEqual(second, { call: 1 });
  assert.deepEqual(await cache.get("widget", load), { call: 1 });
  assert.equal(calls, 1);
});
