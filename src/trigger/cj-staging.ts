// Durable CJ preflight/staging worker. Shopify's request path writes an intent and returns; this
// scheduled worker is the only place freight or approval runtime is contacted.
import { schedules, task, tasks, logger } from "@trigger.dev/sdk/v3";
import { convexClient, api } from "../lib/convexClient";
import { quoteCjFreight, selectVerifiedCjFreight } from "../lib/cj";
import { executeCjStaging } from "../lib/cjStagingExecutor";
import type { approvalGate } from "./approval-gate";
import type { Id } from "../../convex/_generated/dataModel";

export interface CjStagingPayload { intentId: string }

export async function processCjStagingIntent({ intentId }: CjStagingPayload) {
  const convex = convexClient();
  const result = await executeCjStaging({
    claimPreflight: () => convex.mutation(api.orders.claimCjStagingPreflight, { intentId: intentId as Id<"cjStagingIntents"> }) as any,
    // `claimed` is a service-to-service response and may temporarily contain PII. This function
    // does not log it or put it into a task payload, trace, audit row, or outbox.
    quote: async (input) => selectVerifiedCjFreight(await quoteCjFreight(input)),
    recordQuote: async (quote) => { await convex.mutation(api.orders.recordCjStagingQuote, { intentId: intentId as Id<"cjStagingIntents">, ...quote }); },
    stage: () => convex.mutation(api.orders.stageQuotedCjStagingIntent, { intentId: intentId as Id<"cjStagingIntents"> }) as any,
    claimApproval: () => convex.mutation(api.orders.claimCjStagingApprovalDispatch, { intentId: intentId as Id<"cjStagingIntents"> }) as any,
    beginApproval: (input) => convex.mutation(api.actions.beginApprovalDispatch, input as any) as any,
    triggerApproval: async ({ actionId, approvalDispatchKey }) => {
      const handle = await tasks.trigger<typeof approvalGate>("approval-gate", { actionId, approvalDispatchKey }, { idempotencyKey: approvalDispatchKey, idempotencyKeyTTL: "24w" });
      await convex.mutation(api.actions.recordApprovalDispatch, { actionId: actionId as Id<"actions">, approvalDispatchKey, approvalRunId: handle.id });
    },
    recordApproval: async ({ actionId }) => { await convex.mutation(api.orders.recordCjStagingApprovalDispatch, { intentId: intentId as Id<"cjStagingIntents">, actionId: actionId as Id<"actions"> }); },
    now: Date.now,
  });
  if (result.state === "approval_dispatched") logger.info("CJ staging intent processed", { intentId, actionId: result.actionId });
  return { intentId, ...result };
}

export const cjStaging = task({ id: "cj-staging", run: processCjStagingIntent });

// An intent survives a route/server/Trigger failure; the next short tick resumes it with its
// persisted quote and fenced state. The schedule payload is intentionally empty.
export const cjStagingSweep = schedules.task({
  id: "cj-staging-sweep",
  cron: "*/1 * * * *",
  run: async () => {
    const convex = convexClient();
    const intents = await convex.query(api.orders.listPendingCjStagingIntents, { limit: 25 }) as Array<{ _id: string }>;
    for (const intent of intents) {
      await tasks.trigger<typeof cjStaging>("cj-staging", { intentId: intent._id }, { idempotencyKey: `cj-staging:${intent._id}`, idempotencyKeyTTL: "1m" });
    }
    return { intents: intents.length };
  },
});
