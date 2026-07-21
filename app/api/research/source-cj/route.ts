// POST /api/research/source-cj — turns an operator-selected CJ candidate into a local,
// margin-clearing draft plus a durable human approval. It reads CJ only; it never publishes,
// creates a supplier order, or creates a Shopify product.
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { tasks } from "@trigger.dev/sdk/v3";
import type { approvalGate } from "@/src/trigger/approval-gate";
import { getProduct } from "@/src/lib/cj";
import { parseCjEvidence } from "@/src/lib/cjEvidence";
import { requireOperator } from "@/src/lib/auth/server";
import { convexClient, api } from "@/src/lib/convexClient";
import type { Id } from "@/convex/_generated/dataModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function configuredForApprovalWaitpoint(): boolean {
  // TRIGGER_ACCESS_TOKEN is a CLI/admin credential, not the runtime SDK credential. Do not
  // create an approval workflow unless the deployed server has the Trigger runtime secret.
  return !!process.env.TRIGGER_SECRET_KEY;
}

export async function POST(request: Request) {
  const guard = await requireOperator(request);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  let body: { siteId?: unknown; requestId?: unknown; cjProductId?: unknown; cjVariantId?: unknown; priceUsd?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.siteId !== "string" || !body.siteId.trim() || typeof body.requestId !== "string" || !body.requestId.trim()
    || typeof body.cjProductId !== "string" || !body.cjProductId.trim()
    || typeof body.cjVariantId !== "string" || !body.cjVariantId.trim()
    || typeof body.priceUsd !== "number" || !Number.isFinite(body.priceUsd) || body.priceUsd <= 0) {
    return NextResponse.json({ error: "siteId, requestId, cjProductId, cjVariantId, and a positive priceUsd are required" }, { status: 400 });
  }
  // Do this before any durable local writes: without Trigger, an approval action would be a
  // dead-end rather than a durable waitpoint.
  if (!configuredForApprovalWaitpoint()) {
    return NextResponse.json({ error: "approval waitpoint is not configured" }, { status: 503 });
  }

  try {
    const cjProductId = body.cjProductId.trim();
    const cjVariantId = body.cjVariantId.trim();
    // Product Details filtered to US returns the exact candidate's variants and their
    // documented inventories. This refresh is intentionally outside discovery caching.
    const product = await getProduct(cjProductId, "US");
    const readAt = Date.now();
    const parsed = parseCjEvidence({ productId: cjProductId, variantId: cjVariantId, product, variants: [], inventory: [], variant: {}, variantInventory: [] });
    const convex = convexClient();
    const staged = await convex.mutation(api.products.stageSourcedDraftSelection, {
      siteId: body.siteId.trim() as Id<"sites">,
      requestId: body.requestId.trim(),
      priceUsd: body.priceUsd,
      ...parsed,
      traceId: randomUUID(),
      readAt,
    });
    if (staged.status === "denied") {
      return NextResponse.json({ ok: false, stage: "sourcing_gate", reason: staged.reason, evidenceId: staged.evidenceId, traceId: staged.traceId, requestId: body.requestId.trim(), reused: staged.reused, published: false }, { status: 422 });
    }
    if (!staged.productId || !staged.actionId || !staged.approvalDispatchKey) throw new Error("sourced selection has incomplete approval lineage");
    const dispatch = await convex.mutation(api.actions.beginApprovalDispatch, {
      actionId: staged.actionId,
      approvalDispatchKey: staged.approvalDispatchKey,
    });
    if (dispatch.status === "resolved") {
      return NextResponse.json({ ok: true, status: dispatch.actionStatus, productId: staged.productId, evidenceId: staged.evidenceId, traceId: staged.traceId, actionId: staged.actionId, approvalRunId: dispatch.approvalRunId, requestId: body.requestId.trim(), reused: true, published: false });
    }
    let approvalRunId = dispatch.status === "dispatched" ? dispatch.approvalRunId : undefined;
    if (dispatch.status === "dispatching") {
      try {
        const handle = await tasks.trigger<typeof approvalGate>("approval-gate", {
          actionId: staged.actionId,
          approvalDispatchKey: staged.approvalDispatchKey,
        }, { idempotencyKey: staged.approvalDispatchKey, idempotencyKeyTTL: "24w" });
        approvalRunId = handle.id;
        await convex.mutation(api.actions.recordApprovalDispatch, { actionId: staged.actionId, approvalDispatchKey: staged.approvalDispatchKey, approvalRunId: handle.id });
      } catch (error) {
        // The Trigger request may have been accepted even if its response was lost. Persist the
        // ambiguity and let an exact retry reconcile through the same idempotency key.
        const message = error instanceof Error ? error.message : "approval dispatch response was lost";
        await convex.mutation(api.actions.markApprovalDispatchAmbiguous, { actionId: staged.actionId, approvalDispatchKey: staged.approvalDispatchKey, error: message });
        return NextResponse.json({ ok: true, status: "dispatch_reconciliation_required", productId: staged.productId, evidenceId: staged.evidenceId, traceId: staged.traceId, actionId: staged.actionId, requestId: body.requestId.trim(), reused: staged.reused, published: false }, { status: 202 });
      }
    }
    return NextResponse.json({
      ok: true,
      productId: staged.productId,
      evidenceId: staged.evidenceId,
      traceId: staged.traceId,
      actionId: staged.actionId,
      approvalRunId,
      requestId: body.requestId.trim(),
      reused: staged.reused,
      status: "pending_approval",
      published: false,
    }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "CJ sourcing failed", published: false }, { status: 502 });
  }
}
