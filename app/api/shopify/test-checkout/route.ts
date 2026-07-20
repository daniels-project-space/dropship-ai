// POST /api/shopify/test-checkout
// Creates only a zero-dollar draft order in an explicitly allowlisted Shopify development shop.
// It never emails an invoice, completes the draft, creates a customer, or starts CJ fulfillment.
import { NextResponse } from "next/server";
import { requireOperator } from "@/src/lib/auth/server";
import { sandboxShopAllowed } from "@/src/lib/effects";
import { resolveShopifyConfig } from "@/src/lib/shopifyAuth";
import { createZeroChargeDraftCheckout } from "@/src/lib/shopify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guard = await requireOperator(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  let body: { siteId?: string; traceId?: string; sandbox?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.siteId || !body.traceId || body.sandbox !== true) {
    return NextResponse.json({ error: "siteId, traceId, and sandbox:true are required" }, { status: 400 });
  }
  if (!/^[a-zA-Z0-9_-]{8,120}$/.test(body.traceId)) {
    return NextResponse.json({ error: "traceId must be 8–120 URL-safe characters" }, { status: 400 });
  }

  try {
    const cfg = await resolveShopifyConfig(body.siteId);
    if (!sandboxShopAllowed(cfg.shop)) {
      return NextResponse.json({
        error: "sandbox checkout is disabled for this shop; enable DROPSHIP_AI_SANDBOX_EFFECTS and add this development shop to SHOPIFY_SANDBOX_SHOPS",
      }, { status: 409 });
    }
    const draft = await createZeroChargeDraftCheckout(cfg, { traceId: body.traceId });
    return NextResponse.json({
      ok: true,
      mode: "sandbox",
      traceId: body.traceId,
      draft: { id: draft.id, name: draft.name, totalAmount: draft.totalAmount, currencyCode: draft.currencyCode },
      // The link is deliberately not returned. Sending or opening it is a separate Daniel decision.
      invoiceCreated: Boolean(draft.invoiceUrl),
      fulfillment: "disabled",
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "sandbox checkout failed" }, { status: 400 });
  }
}
