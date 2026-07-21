// POST /api/research/source-cj — turns an operator-selected CJ candidate into a local,
// margin-clearing draft plus a durable human approval. It reads CJ only; it never publishes,
// creates a supplier order, or creates a Shopify product.
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { tasks } from "@trigger.dev/sdk/v3";
import type { approvalGate } from "@/src/trigger/approval-gate";
import { getInventoryByProduct, getInventoryByVariant, getProduct, getVariant, getVariants } from "@/src/lib/cj";
import { parseCjEvidence } from "@/src/lib/cjEvidence";
import { requireOperator } from "@/src/lib/auth/server";
import { convexClient, api } from "@/src/lib/convexClient";
import type { Id } from "@/convex/_generated/dataModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function configuredForApprovalWaitpoint(): boolean {
  return !!(process.env.TRIGGER_SECRET_KEY || process.env.TRIGGER_ACCESS_TOKEN);
}

export async function POST(request: Request) {
  const guard = await requireOperator(request);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  let body: { siteId?: unknown; cjProductId?: unknown; cjVariantId?: unknown; priceUsd?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.siteId !== "string" || !body.siteId.trim()
    || typeof body.cjProductId !== "string" || !body.cjProductId.trim()
    || typeof body.cjVariantId !== "string" || !body.cjVariantId.trim()
    || typeof body.priceUsd !== "number" || !Number.isFinite(body.priceUsd) || body.priceUsd <= 0) {
    return NextResponse.json({ error: "siteId, cjProductId, cjVariantId, and a positive priceUsd are required" }, { status: 400 });
  }
  // Do this before any durable local writes: without Trigger, an approval action would be a
  // dead-end rather than a durable waitpoint.
  if (!configuredForApprovalWaitpoint()) {
    return NextResponse.json({ error: "approval waitpoint is not configured" }, { status: 503 });
  }

  try {
    const cjProductId = body.cjProductId.trim();
    const cjVariantId = body.cjVariantId.trim();
    const [product, variants, inventory, variant, variantInventory] = await Promise.all([
      getProduct(cjProductId),
      getVariants(cjProductId, "US"),
      getInventoryByProduct(cjProductId),
      getVariant(cjVariantId),
      getInventoryByVariant(cjVariantId),
    ]);
    const readAt = Date.now();
    const parsed = parseCjEvidence({ productId: cjProductId, variantId: cjVariantId, product, variants, inventory, variant, variantInventory });
    const convex = convexClient();
    const persisted = await convex.mutation(api.products.recordCjEvidence, {
      siteId: body.siteId.trim() as Id<"sites">,
      ...parsed,
      traceId: randomUUID(),
      readAt,
    });
    const draft = await convex.mutation(api.products.createSourcedDraft, {
      siteId: body.siteId.trim() as Id<"sites">,
      evidenceId: persisted.evidenceId,
      priceUsd: body.priceUsd,
    });
    if (draft.status === "denied") {
      return NextResponse.json({ ok: false, stage: "sourcing_gate", reason: draft.reason, evidenceId: persisted.evidenceId, traceId: persisted.traceId, published: false }, { status: 422 });
    }
    const proposed = await convex.mutation(api.actions.proposeSourcedDraftImport, {
      siteId: body.siteId.trim() as Id<"sites">,
      productId: draft.productId,
      evidenceId: persisted.evidenceId,
    });
    // A duplicate selection reuses the already pending action; only the request that inserted it
    // arms a new waitpoint, avoiding competing approval tokens.
    let approvalRunId: string | undefined;
    if (!proposed.reused) {
      try {
        const handle = await tasks.trigger<typeof approvalGate>("approval-gate", { actionId: proposed.actionId });
        approvalRunId = handle.id;
      } catch (error) {
        // A pending action without a Trigger waitpoint is not an approval gate. Mark this attempt
        // failed so a deliberate re-selection can atomically create and arm a fresh action.
        await convex.mutation(api.actions.markExecuted, {
          actionId: proposed.actionId,
          failed: true,
          result: { reason: error instanceof Error ? error.message : "failed to arm approval waitpoint" },
        });
        throw error;
      }
    }
    return NextResponse.json({
      ok: true,
      productId: draft.productId,
      evidenceId: persisted.evidenceId,
      traceId: persisted.traceId,
      actionId: proposed.actionId,
      approvalRunId,
      reused: proposed.reused,
      status: "pending_approval",
      published: false,
    }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "CJ sourcing failed", published: false }, { status: 502 });
  }
}
