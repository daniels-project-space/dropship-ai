// Scheduled trend/competitor signal pull (cron stub).
// Runs daily; real source pulls (Google Trends / Meta Ad Library / TikTok CC / SERP) are wired
// per-site later. For now it walks active sites and writes a heartbeat rollup so the pipeline
// + indexes are exercised end-to-end.
import { schedules, logger } from "@trigger.dev/sdk/v3";
import { convexClient, api } from "../lib/convexClient";
import type { Id } from "../../convex/_generated/dataModel";

function today(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export const signalIngest = schedules.task({
  id: "signal-ingest",
  // Daily at 06:00 UTC. Override per-environment in the dashboard if needed.
  cron: "0 6 * * *",
  run: async () => {
    const convex = convexClient();
    const sites = await convex.query(api.sites.list, { status: "active" });
    logger.info("signal-ingest tick", { day: today(), activeSites: sites.length });

    for (const site of sites) {
      // STUB: replace with real source pulls. Records a heartbeat trend_score=0 rollup.
      await convex.mutation(api.signals.record, {
        siteId: site._id as Id<"sites">,
        source: "heartbeat",
        signalType: "trend_score",
        value: 0,
        day: today(),
      });
    }

    return { day: today(), sitesProcessed: sites.length };
  },
});
