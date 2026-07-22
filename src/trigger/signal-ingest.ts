// Scheduled provider-ingest slot. It deliberately records no synthetic heartbeat: a successful
// worker tick is operational telemetry, not a market signal or an analytics observation.
import { schedules, logger } from "@trigger.dev/sdk/v3";

export const signalIngest = schedules.task({
  id: "signal-ingest",
  // Daily at 06:00 UTC. Override per-environment in the dashboard if needed.
  cron: "0 6 * * *",
  run: async () => {
    logger.info("signal-ingest skipped; no provider-observed source adapter is configured");
    return { ingested: false, reason: "no_provider_observations_configured" as const };
  },
});
