// Server-only route: mint a short-lived presigned R2 URL for a creative asset so the browser
// can preview video/image without exposing R2 credentials or making the bucket public.
// GET /api/asset?key=<r2Key>  →  { url }
import { NextResponse } from "next/server";
import { getSignedUrl } from "@/src/lib/storage";
import { isCreativeAssetKey } from "@/src/lib/storageKey";
import { requireOperator } from "@/src/lib/auth/server";
import { api, convexClient } from "@/src/lib/convexClient";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const guard = await requireOperator(req, { csrf: false });
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const key = new URL(req.url).searchParams.get("key");
  if (!key) return NextResponse.json({ error: "key is required" }, { status: 400 });
  if (!isCreativeAssetKey(key)) return NextResponse.json({ error: "invalid asset key" }, { status: 400 });
  try {
    const creative = await convexClient().query(api.creatives.getByR2Key, { r2Key: key });
    if (!creative) return NextResponse.json({ error: "asset not found" }, { status: 404 });
    const url = await getSignedUrl(key, 900); // 15 min — long enough to load + scrub
    return NextResponse.json({ url }, { headers: { "Cache-Control": "private, max-age=600" } });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "presign failed" },
      { status: 500 },
    );
  }
}
