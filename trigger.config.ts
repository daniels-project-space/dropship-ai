import { defineConfig } from "@trigger.dev/sdk/v3";

// Trigger.dev v3/v4 project config.
// project: dropship-ai-jobs (proj_ebwgqvfufapbqnhjxhnc) — own project since 2026-07-03 (was the org DEFAULT project, whose deploy clobbered remote-work-hub's chat-dispatcher; every app gets its OWN Trigger project).
// Reads TRIGGER_PROJECT_REF from env first so CI can override.
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_ebwgqvfufapbqnhjxhnc",
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
