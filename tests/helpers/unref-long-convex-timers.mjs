// convex-test models scheduled functions with Node timers. Durable 24-hour jobs should remain
// pending for assertions without keeping the test worker alive after every test has completed.
const nodeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = function unrefLongConvexTimer(callback, delay, ...args) {
  const timer = nodeSetTimeout(callback, delay, ...args);
  if (typeof delay === "number" && delay >= 60_000) timer.unref?.();
  return timer;
};
