// Human-in-the-loop approval gate for `human_gated` actions.
//
// Trigger waitpoint tokens have a FINITE max timeout (~4 weeks). A pending approval may sit
// longer than that, so we RE-ARM: create a token with a 4w timeout, wait; on timeout create a
// fresh token and wait again, up to MAX_CYCLES (~6 ≈ 24 weeks). After that we escalate and stop
// burning a run. Sourced Shopify imports remain approved until their own executor records the
// draft-only provider result; legacy action handlers retain their existing completion behavior.
//
// The token id is persisted to the action (actions.setWaitpointToken) so an external approver
// (dashboard "Approve" button → wait.completeToken) can resume this exact waitpoint.
import { task, wait, logger } from "@trigger.dev/sdk/v3";
import { convexClient, api } from "../lib/convexClient";
import type { Id } from "../../convex/_generated/dataModel";
import { approvalWaitpointKey } from "../lib/sourceSelectionState";

const TIMEOUT = "4w" as const; // Trigger waitpoint max window
const MAX_CYCLES = 6; // 6 × 4w ≈ 24 weeks before escalation

interface ApprovalDecision {
  approved: boolean;
  approver?: string;
  reason?: string;
}

export const approvalGate = task({
  id: "approval-gate",
  run: async (payload: { actionId: string; approvalDispatchKey: string }) => {
    const convex = convexClient();
    const actionId = payload.actionId as Id<"actions">;

    for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
      const canArm = await convex.mutation(api.actions.canArmApprovalWaitpoint, {
        actionId,
        approvalDispatchKey: payload.approvalDispatchKey,
      });
      if (!canArm) {
        logger.info("approval-gate stopped; action is no longer pending", { actionId, cycle });
        return { status: "no_longer_pending" as const, actionId };
      }
      // Fresh waitpoint each cycle (re-arm).
      const token = await wait.createToken({ timeout: TIMEOUT, idempotencyKey: approvalWaitpointKey(actionId, cycle), idempotencyKeyTTL: "24w" });
      await convex.mutation(api.actions.setWaitpointToken, {
        actionId,
        waitpointToken: token.id,
        approvalDispatchKey: payload.approvalDispatchKey,
      });
      logger.info("approval-gate armed", { actionId, cycle, tokenId: token.id });

      const result = await wait.forToken<ApprovalDecision>(token);

      if (result.ok) {
        const decision = result.output;
        if (decision.approved) {
          await convex.mutation(api.actions.approve, { actionId, approver: decision.approver });
          const action = await convex.query(api.actions.get, { actionId });
          if (action?.type === "import_sourced_product") {
            logger.info("approval-gate approved sourced import; awaiting draft-only executor", { actionId });
            return { status: "approved" as const, actionId };
          }
          await convex.mutation(api.actions.markExecuted, {
            actionId,
            result: { resolvedVia: "waitpoint", approver: decision.approver ?? "human" },
          });
          logger.info("approval-gate approved+executed", { actionId });
          return { status: "executed" as const, actionId };
        }
        await convex.mutation(api.actions.reject, {
          actionId,
          reason: decision.reason,
          approver: decision.approver,
        });
        logger.info("approval-gate rejected", { actionId, reason: decision.reason });
        return { status: "rejected" as const, actionId };
      }

      // result.ok === false → token timed out this cycle; loop re-arms.
      logger.warn("approval-gate timeout — re-arming", { actionId, cycle });
    }

    // Exhausted all cycles → escalate, leave action pending for manual handling.
    const action = await convex.query(api.actions.get, { actionId });
    if (action?.status === "pending_approval" && action.approvalDispatchKey === payload.approvalDispatchKey) {
      await convex.mutation(api.audit.append, {
        siteId: action.siteId,
        actionId,
        event: "approval_escalated",
        detail: { reason: "max waitpoint re-arm cycles exhausted", cycles: MAX_CYCLES, approvalDispatchKey: payload.approvalDispatchKey },
      });
    }
    logger.error("approval-gate escalated — no decision after max cycles", { actionId });
    return { status: "escalated" as const, actionId };
  },
});
