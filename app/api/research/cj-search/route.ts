// GET /api/research/cj-search — authenticated, read-only CJ catalogue search. It never follows
// affiliate URLs and never writes CJ, Shopify, Convex, or a supplier order.
import { NextResponse } from "next/server";
import { requireOperator } from "@/src/lib/auth/server";
import { getInventoryByProduct, getVariants, searchProducts } from "@/src/lib/cj";
import { normalizeCjCatalogueSearch } from "@/src/lib/cjCatalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const guard = await requireOperator(request, { csrf: false });
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const keyword = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (keyword.length < 2 || keyword.length > 120) return NextResponse.json({ error: "q must be 2–120 characters" }, { status: 400 });
  try {
    const search = await searchProducts({ keyword, page: 1, size: 8, countryCode: "US" });
    const ids = Array.from(new Set((Array.isArray(search) ? search : [search]).flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const value = entry as Record<string, unknown>;
      return [value.pid, value.productId, value.id].filter((id): id is string => typeof id === "string" && id.trim().length > 0);
    }))).slice(0, 8);
    // Search response shapes vary; recover ids from the normalizer-ready container as well.
    const root = search as Record<string, unknown>;
    const list = [root?.content, root?.list, root?.records, root?.data].flatMap((value) => Array.isArray(value) ? value : []);
    for (const item of list) if (typeof item === "object" && item !== null) {
      const record = item as Record<string, unknown>;
      const id = record.pid ?? record.productId ?? record.id;
      if (typeof id === "string" && id.trim() && !ids.includes(id)) ids.push(id);
    }
    const details = await Promise.all(ids.slice(0, 8).map(async (productId) => ({ productId, variants: await getVariants(productId, "US"), inventory: await getInventoryByProduct(productId) })));
    return NextResponse.json({ results: normalizeCjCatalogueSearch(search, details), readOnly: true, published: false });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "CJ catalogue search failed" }, { status: 502 });
  }
}
