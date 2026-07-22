// GET /api/research/cj-search — authenticated, read-only CJ catalogue search. It never follows
// affiliate URLs and never writes CJ, Shopify, Convex, or a supplier order.
import { NextResponse } from "next/server";
import { requireOperator } from "@/src/lib/auth/server";
import { getProduct, searchProducts } from "@/src/lib/cj";
import { cjCatalogueSearchProducts, normalizeCjCatalogueSearch } from "@/src/lib/cjCatalog";
import { RequestCoalescer } from "@/src/lib/requestCoalescer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const searchCache = new RequestCoalescer<{ results: ReturnType<typeof normalizeCjCatalogueSearch> }>(30_000);

function normalizedQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

export async function GET(request: Request) {
  const guard = await requireOperator(request, { csrf: false });
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const keyword = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (keyword.length < 2 || keyword.length > 120) return NextResponse.json({ error: "q must be 2–120 characters" }, { status: 400 });
  try {
    const cached = await searchCache.get(normalizedQuery(keyword), async () => {
      // listV2 costs 50 CJ points. Bound the next detail reads to four products; each
      // country-filtered Product Details read supplies variants plus their US inventories.
      const search = await searchProducts({ keyword, page: 1, size: 4, countryCode: "US" });
      const ids = Array.from(new Set(cjCatalogueSearchProducts(search).flatMap((product) => {
        const id = product.pid ?? product.productId ?? product.id;
        return typeof id === "string" && id.trim() ? [id] : [];
      }))).slice(0, 4);
      const details = await Promise.all(ids.map(async (productId) => ({ productId, product: await getProduct(productId, "US") })));
      return { results: normalizeCjCatalogueSearch(search, details) };
    });
    return NextResponse.json({ ...cached, readOnly: true, published: false });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "CJ catalogue search failed" }, { status: 502 });
  }
}
