import { defineConfig } from "@trigger.dev/sdk/v3";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";

// Trigger.dev v3/v4 project config.
// project: dropship-ai-jobs (proj_ebwgqvfufapbqnhjxhnc) — own project since 2026-07-03 (was the org DEFAULT project, whose deploy clobbered remote-work-hub's chat-dispatcher; every app gets its OWN Trigger project).
// Reads TRIGGER_PROJECT_REF from env first so CI can override.
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_ebwgqvfufapbqnhjxhnc",
  dirs: ["./src/trigger"],
  maxDuration: 600, // 10 min default ceiling per run
  build: {
    extensions: [
      // Server-to-Convex calls are authenticated too. Keep this scoped service JWT in the
      // Trigger project; it is never a browser credential and is not written to source.
      syncEnvVars(() => {
        const names = [
          "VAULT_ACCESS_TOKEN", "NEXT_PUBLIC_CONVEX_URL", "CONVEX_URL", "DROPSHIP_AI_SERVICE_TOKEN",
          // Non-secret dual-control flag required before a Trigger worker can issue any live write.
          "DROPSHIP_AI_LIVE_EFFECTS", "DROPSHIP_AI_LIVE_EFFECTS_CONFIRM",
        ] as const;
        const values = Object.fromEntries(names.flatMap((name) => process.env[name] ? [[name, process.env[name]!]] : []));
        return Object.keys(values).length ? values : undefined;
      }),
    ],
  },
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
