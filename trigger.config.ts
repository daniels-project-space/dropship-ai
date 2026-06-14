import { defineConfig } from "@trigger.dev/sdk/v3";

// Trigger.dev v3/v4 project config.
// project: "Daniels Project Project" sandbox (proj_oqwizuikmyjdfuzbetda) — confirmed empty 2026-06-14.
// Reads TRIGGER_PROJECT_REF from env first so CI can override; literal is the verified sandbox ref.
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_oqwizuikmyjdfuzbetda",
  dirs: ["./src/trigger"],
  maxDuration: 600, // 10 min default ceiling per run
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      factor: 2,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 30000,
      randomize: true,
    },
  },
});
