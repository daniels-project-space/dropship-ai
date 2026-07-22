// Durable recovery for the small gap between creating an approved creative's dispatch row and
// receiving the Trigger run id. It only replays Trigger's idempotent enqueue operation; it never
// calls a social provider and never touches receipt-reconciliation rows.
import { schedules, tasks, logger } from "@trigger.dev/sdk/v3";
import { convexClient, api } from "../lib/convexClient";
import type { scheduleApprovedCreative } from "./content-factory";
import type { Id } from "../../convex/_generated/dataModel";

export const distributionRecovery = schedules.task({
  id: "distribution-recovery",
  cron: "*/5 * * * *",
  run: async () => {
    const convex = convexClient();
    const dispatches = await convex.query(api.posts.listDispatchesNeedingTrigger, { limit: 100 });
    let dispatched = 0;
    for (const row of dispatches) {
      const creativeId = row.creativeId as Id<"creatives">;
      const claim = await convex.mutation(api.posts.beginDistributionDispatch, { creativeId, dispatchKey: row.dispatchKey });
      if (claim.status !== "dispatching") continue;
      try {
        const handle = await tasks.trigger<typeof scheduleApprovedCreative>("schedule-approved-creative", { creativeId, dispatchKey: row.dispatchKey }, {
          idempotencyKey: row.dispatchKey,
          idempotencyKeyTTL: "24w",
        });
        await convex.mutation(api.posts.recordDistributionDispatch, { creativeId, dispatchKey: row.dispatchKey, triggerRunId: handle.id });
        dispatched++;
      } catch (error) {
        // Keep dispatching. The next recovery tick uses the exact same Trigger idempotency key.
        logger.warn("distribution recovery enqueue did not return a run id", { creativeId, error: String(error).slice(0, 180) });
      }
    }
    return { examined: dispatches.length, dispatched };
  },
});
