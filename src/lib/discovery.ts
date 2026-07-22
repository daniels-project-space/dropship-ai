// Server-only discovery adapters. These sources provide market evidence only; their results never
// create products, spend money, or generate affiliate clicks.
import { getKey } from "./vault";

const KELKOO_BASE = "https://api.kelkoogroup.net/publisher/shopping/v2";
const JINA_SEARCH_BASE = "https://s.jina.ai";

export type DiscoverySource = "kelkoo" | "jina";

export interface DiscoveryQuery {
  query: string;
  country?: string;
  limit?: number;
  sources?: DiscoverySource[];
}

export interface DiscoveryResult {
  source: DiscoverySource;
  title: string;
  url: string;
  excerpt?: string;
  priceUsd?: number;
  merchant?: string;
  imageUrl?: string;
}

export interface DiscoveryResponse {
  results: DiscoveryResult[];
  unavailable: Array<{ source: DiscoverySource; reason: string }>;
}

function boundedLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 10, 1), 50);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeUrl(value: unknown): string | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

async function sourceKey(service: string, key: string, envName: string): Promise<string | null> {
  return (await getKey(service, key).catch(() => null)) ?? process.env[envName] ?? null;
}

/** Search a Kelkoo publisher account. The JWT stays on the server and no result URL is opened. */
export async function searchKelkoo(query: string, options: { country?: string; limit?: number } = {}): Promise<DiscoveryResult[]> {
  const token = await sourceKey("kelkoo", "KELKOO_JWT", "KELKOO_JWT");
  if (!token) throw new Error("kelkoo: KELKOO_JWT is not configured");
  const url = new URL(`${KELKOO_BASE}/search/offers`);
  url.searchParams.set("country", (options.country ?? "us").toLowerCase());
  url.searchParams.set("query", query);
  url.searchParams.set("fieldsAlias", "minimal");
  url.searchParams.set("additionalFields", "merchantName,imageUrl,totalPrice");
  url.searchParams.set("sortBy", "price");
  url.searchParams.set("sortDirection", "asc");
  url.searchParams.set("page", "1");
  url.searchParams.set("pageSize", String(boundedLimit(options.limit)));
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!response.ok) throw new Error(`kelkoo: offer search failed: HTTP ${response.status}`);
  const payload = await response.json() as { offers?: unknown[] };
  return (payload.offers ?? []).flatMap((offer): DiscoveryResult[] => {
    const row = (offer ?? {}) as Record<string, unknown>;
    const url = safeUrl(row.goUrl ?? row.url ?? row.merchantUrl);
    const title = optionalString(row.title ?? row.name ?? row.productName);
    if (!url || !title) return [];
    return [{
      source: "kelkoo",
      title,
      url,
      excerpt: optionalString(row.description),
      priceUsd: numberOrUndefined(row.totalPrice ?? row.price),
      merchant: optionalString(row.merchantName ?? row.merchant),
      imageUrl: safeUrl(row.imageUrl ?? row.image),
    }];
  });
}

/** Search Jina's search endpoint. It is evidence enrichment, not a scraper of authenticated pages. */
export async function searchJina(query: string, options: { limit?: number } = {}): Promise<DiscoveryResult[]> {
  const apiKey = await sourceKey("jina", "JINA_API_KEY", "JINA_API_KEY");
  if (!apiKey) throw new Error("jina: JINA_API_KEY is not configured");
  const url = new URL(`${JINA_SEARCH_BASE}/${encodeURIComponent(query)}`);
  url.searchParams.set("count", String(boundedLimit(options.limit)));
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`jina: search failed: HTTP ${response.status}`);
  const payload = await response.json() as { data?: unknown[] };
  return (payload.data ?? []).flatMap((item): DiscoveryResult[] => {
    const row = (item ?? {}) as Record<string, unknown>;
    const url = safeUrl(row.url);
    const title = optionalString(row.title ?? row.name);
    if (!url || !title) return [];
    return [{
      source: "jina",
      title,
      url,
      excerpt: optionalString(row.description ?? row.content ?? row.snippet),
    }];
  });
}

/**
 * Gather independent, read-only discovery evidence. One unavailable source does not erase the
 * other source's result; callers receive a reason suitable for an operator console.
 */
export async function discoverProducts(input: DiscoveryQuery): Promise<DiscoveryResponse> {
  const query = input.query.trim();
  if (!query) throw new Error("discovery: query is required");
  const sources: DiscoverySource[] = Array.from(new Set<DiscoverySource>(input.sources?.length ? input.sources : ["kelkoo", "jina"]));
  const settled = await Promise.allSettled(sources.map(async (source) => ({
    source,
    results: source === "kelkoo"
      ? await searchKelkoo(query, { country: input.country, limit: input.limit })
      : await searchJina(query, { limit: input.limit }),
  })));
  const results: DiscoveryResult[] = [];
  const unavailable: DiscoveryResponse["unavailable"] = [];
  for (let index = 0; index < settled.length; index++) {
    const outcome = settled[index];
    const source = sources[index];
    if (outcome.status === "fulfilled") results.push(...outcome.value.results);
    else unavailable.push({ source, reason: outcome.reason instanceof Error ? outcome.reason.message : "source unavailable" });
  }
  return { results, unavailable };
}
