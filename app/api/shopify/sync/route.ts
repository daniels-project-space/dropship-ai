// POST /api/shopify/sync — re-run the read-only products+orders sync for a connected site using
// the VAULT token (resolveShopifyConfig, no override). Returns { productCount, orderCount,
// lastSyncedAt }. No CJ/fulfillment side effects.
import { NextResponse } from "next/server";
import { resolveShopifyConfig } from "@/src/lib/shopifyAuth";
import { syncShopify } from "@/src/lib/shopifySync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { siteId?: string; sinceDays?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.siteId) {
    return NextResponse.json({ error: "siteId is required" }, { status: 400 });
  }

  try {
    const cfg = await resolveShopifyConfig(body.siteId); // vault token
    const result = await syncShopify(body.siteId, cfg, { sinceDays: body.sinceDays ?? 60 });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "sync failed" },
      { status: 400 },
    );
  }
}
