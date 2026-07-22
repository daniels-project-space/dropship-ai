// POST /api/shopify/sync — re-run the read-only products+orders sync for a connected site using
// the VAULT token (resolveShopifyConfig, no override). Returns { productCount, orderCount,
// lastSyncedAt }. No CJ/fulfillment side effects.
import { NextResponse } from "next/server";
import { resolveShopifyConfig } from "@/src/lib/shopifyAuth";
import { syncShopify } from "@/src/lib/shopifySync";
import { requireOperator } from "@/src/lib/auth/server";
import { parseShopifySyncRequest } from "@/src/lib/shopifySyncRequest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SyncRouteDependencies = {
  authorize: typeof requireOperator;
  sync: typeof syncShopify;
  resolveConfig: typeof resolveShopifyConfig;
};

const runtimeDependencies: SyncRouteDependencies = {
  authorize: requireOperator,
  sync: syncShopify,
  resolveConfig: resolveShopifyConfig,
};

export async function handleShopifySync(req: Request, dependencies: SyncRouteDependencies = runtimeDependencies) {
  const guard = await dependencies.authorize(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const body = parseShopifySyncRequest(rawBody);
  if (!body) return NextResponse.json({ error: "invalid Shopify sync request" }, { status: 400 });

  try {
    const result = await dependencies.sync(body.siteId, () => dependencies.resolveConfig(body.siteId), { sinceDays: body.sinceDays });
    if (result.economicsSync === "incomplete") {
      return NextResponse.json({ ok: false, state: "incomplete", error: "bounded Shopify coverage is incomplete", ...result }, { status: 409 });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, state: "failed", error: err instanceof Error ? err.message : "sync failed" },
      { status: 409 },
    );
  }
}

export async function POST(req: Request) {
  return handleShopifySync(req);
}
