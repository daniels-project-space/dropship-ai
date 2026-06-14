import { defineConfig } from "@trigger.dev/sdk/v3";

// Trigger.dev v3/v4 project config.
// project: the Trigger.dev project ref (proj_...). As of 2026-06-14 a dedicated
// "dropship-ai-jobs" project has NOT been provisioned (requires interactive dashboard
// login). Until then this reads TRIGGER_PROJECT_REF from env so deploys don't hard-fail;
// the placeholder makes the blocker obvious in CI logs.
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_REPLACE_dropship_ai_jobs",
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
