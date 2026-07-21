// Durable CJ preflight/staging worker. Shopify's request path writes an intent and returns; this
// scheduled worker is the only place freight or approval runtime is contacted.
import { schedules, task, tasks, logger } from "@trigger.dev/sdk/v3";
import { convexClient, api } from "../lib/convexClient";
import { quoteCjFreight, selectVerifiedCjFreight } from "../lib/cj";
import { executeCjStaging } from "../lib/cjStagingExecutor";
import type { approvalGate } from "./approval-gate";
import type { Id } from "../../convex/_generated/dataModel";
import { classifyCjStagingFailure } from "../lib/cjStagingState";

export interface CjStagingPayload { intentId: string }

export async function processCjStagingIntent({ intentId }: CjStagingPayload) {
  const convex = convexClient();
  let failureFence: { expectedPhase: "preflighting" | "quoted" | "approval_dispatching"; expectedAttempt: number; leaseGeneration: number } | null = null;
  try {
    const result = await executeCjStaging({
    claimPreflight: async () => {
      const claim: any = await convex.mutation(api.orders.claimCjStagingPreflight, { intentId: intentId as Id<"cjStagingIntents"> });
      if (claim.state === "preflight") failureFence = { expectedPhase: "preflighting", expectedAttempt: claim.attempt, leaseGeneration: claim.leaseGeneration };
      if (claim.state === "quoted") failureFence = { expectedPhase: "quoted", expectedAttempt: claim.attempt, leaseGeneration: claim.leaseGeneration };
      return claim;
    },
    // `claimed` is a service-to-service response and may temporarily contain PII. This function
    // does not log it or put it into a task payload, trace, audit row, or outbox.
    quote: async (input) => selectVerifiedCjFreight(await quoteCjFreight(input)),
    recordQuote: async (quote) => {
      const recorded: any = await convex.mutation(api.orders.recordCjStagingQuote, { intentId: intentId as Id<"cjStagingIntents">, ...quote });
      if (recorded.ignored) return recorded;
      failureFence = { expectedPhase: "quoted", expectedAttempt: quote.attempt, leaseGeneration: quote.leaseGeneration };
      return recorded;
    },
    stage: () => convex.mutation(api.orders.stageQuotedCjStagingIntent, { intentId: intentId as Id<"cjStagingIntents"> }) as any,
    claimApproval: async () => {
      const claim: any = await convex.mutation(api.orders.claimCjStagingApprovalDispatch, { intentId: intentId as Id<"cjStagingIntents"> });
      if (claim.state === "dispatch") failureFence = { expectedPhase: "approval_dispatching", expectedAttempt: claim.attempt, leaseGeneration: claim.leaseGeneration };
      return claim;
    },
    beginApproval: (input) => convex.mutation(api.actions.beginApprovalDispatch, input as any) as any,
    triggerApproval: async ({ actionId, approvalDispatchKey }) => {
      try {
        const handle = await tasks.trigger<typeof approvalGate>("approval-gate", { actionId, approvalDispatchKey }, { idempotencyKey: approvalDispatchKey, idempotencyKeyTTL: "24w" });
        await convex.mutation(api.actions.recordApprovalDispatch, { actionId: actionId as Id<"actions">, approvalDispatchKey, approvalRunId: handle.id });
        return handle.id;
      } catch (error) {
        // A lost Trigger response is reconciled by the deterministic key, never treated as sent.
        await convex.mutation(api.actions.markApprovalDispatchAmbiguous, { actionId: actionId as Id<"actions">, approvalDispatchKey, error: "trigger_response_ambiguous" });
        throw error;
      }
    },
    recordApproval: ({ actionId, approvalDispatchKey, approvalRunId, leaseGeneration }) => convex.mutation(api.orders.recordCjStagingApprovalDispatch, { intentId: intentId as Id<"cjStagingIntents">, actionId: actionId as Id<"actions">, approvalDispatchKey, approvalRunId, leaseGeneration }) as any,
    resolveApproval: ({ actionId, approvalDispatchKey, leaseGeneration }) => convex.mutation(api.orders.resolveCjStagingApproval, { intentId: intentId as Id<"cjStagingIntents">, actionId: actionId as Id<"actions">, approvalDispatchKey, leaseGeneration }) as any,
    });
    if (result.state === "approval_dispatched") logger.info("CJ staging intent processed", { intentId, actionId: result.actionId });
    return { intentId, ...result };
  } catch (error) {
    const failure = classifyCjStagingFailure(error);
    const fence = failureFence as { expectedPhase: "preflighting" | "quoted" | "approval_dispatching"; expectedAttempt: number; leaseGeneration: number } | null;
    if (!fence) {
      logger.warn("CJ staging failed before a durable lease was claimed", { intentId, code: failure.code });
      return { intentId, state: "needs_attention" as const };
    }
    const recorded = await convex.mutation(api.orders.recordCjStagingFailure, { intentId: intentId as Id<"cjStagingIntents">, ...fence, kind: failure.kind, errorCode: failure.code });
    // No provider error text reaches Trigger logs; the durable mutation stores only a code.
    logger.warn("CJ staging attempt deferred or stopped", { intentId, code: failure.code, status: recorded.status });
    return { intentId, state: recorded.status };
  }
}

export const cjStaging = task({ id: "cj-staging", run: processCjStagingIntent });

// An intent survives a route/server/Trigger failure; the next short tick resumes it with its
// persisted quote and fenced state. The schedule payload is intentionally empty.
export const cjStagingSweep = schedules.task({
  id: "cj-staging-sweep",
  cron: "*/1 * * * *",
  run: async () => {
    const convex = convexClient();
    // Optional rollout fields are repaired in small indexed batches before the due read.  This
    // makes legacy rows runnable without adding a full-table scan to the steady-state path.
    await convex.mutation(api.orders.reconcileLegacyCjStagingIntents, { limit: 25 });
    const intents = await convex.query(api.orders.listDueCjStagingIntents, { limit: 25 }) as Array<{ _id: string }>;
    for (const intent of intents) {
      await tasks.trigger<typeof cjStaging>("cj-staging", { intentId: intent._id }, { idempotencyKey: `cj-staging:${intent._id}`, idempotencyKeyTTL: "1m" });
    }
    return { intents: intents.length };
  },
});
