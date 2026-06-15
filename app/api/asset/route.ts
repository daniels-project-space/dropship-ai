// Server-only route: mint a short-lived presigned R2 URL for a creative asset so the browser
// can preview video/image without exposing R2 credentials or making the bucket public.
// GET /api/asset?key=<r2Key>  →  { url }
import { NextResponse } from "next/server";
import { getSignedUrl } from "@/src/lib/storage";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("key");
  if (!key) return NextResponse.json({ error: "key is required" }, { status: 400 });
  try {
    const url = await getSignedUrl(key, 900); // 15 min — long enough to load + scrub
    return NextResponse.json({ url }, { headers: { "Cache-Control": "private, max-age=600" } });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "presign failed" },
      { status: 500 },
    );
  }
}
