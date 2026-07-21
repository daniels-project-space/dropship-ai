"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DataTable, type Column } from "../../../components/ui/DataTable";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { Badge } from "../../../components/ui/Badge";
import { Icon } from "../../../components/Icons";

type SignalRow = {
  _id: Id<"productSignals">;
  source: string;
  signalType: string;
  value: number;
  day: string;
};

type ExperimentRow = {
  _id: Id<"experiments">;
  hypothesis: string;
  status: "running" | "concluded";
  winner?: string;
  startedAt: number;
};

const SOURCE_LABEL: Record<string, string> = {
  google_trends: "Google Trends",
  meta_ad_library: "Meta Ad Library",
  tiktok_cc: "TikTok Creative Center",
  serp: "SERP",
};

// The locked niche rubric the brain scores candidates against (display-only readout).
const RUBRIC = [
  { label: "US-warehouse sourcing", note: "duty-paid bulk only", key: "us" },
  { label: "Min blended margin ≥ 70%", note: "after fees + refunds", key: "margin" },
  { label: "Min kit price floor", note: "premium positioning", key: "price" },
  { label: "Sustained trend signal", note: "not a 2-week spike", key: "trend" },
];

function SourceCjCandidate({ siteId }: { siteId: Id<"sites"> }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ cjProductId: string; title: string; variants: Array<{ cjVariantId: string; label: string; inventoryQty: number | null; cogsUsd: number | null; shippingUsd: number | null }> }>>([]);
  const [cjProductId, setCjProductId] = useState("");
  const [cjVariantId, setCjVariantId] = useState("");
  const [requestId, setRequestId] = useState("");
  const [priceUsd, setPriceUsd] = useState("");
  const [state, setState] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search() {
    setBusy(true);
    setState(null);
    try {
      const response = await fetch(`/api/research/cj-search?q=${encodeURIComponent(query)}`);
      const result = await response.json() as { error?: string; results?: typeof results };
      if (!response.ok) throw new Error(result.error ?? "CJ catalogue search failed");
      setResults(result.results ?? []);
      if ((result.results ?? []).length === 0) setState("No US-variant CJ results were returned. Nothing was selected or created.");
    } catch (error) {
      setState(error instanceof Error ? error.message : "CJ catalogue search failed");
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setState(null);
    try {
      const response = await fetch("/api/research/source-cj", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ siteId, requestId, cjProductId, cjVariantId, priceUsd: Number(priceUsd) }),
      });
      const result = await response.json() as { error?: string; reason?: string; actionId?: string };
      if (!response.ok) throw new Error(result.reason ?? result.error ?? "candidate was not accepted");
      setState(`CJ evidence recorded; approval ${result.actionId} is waiting. No Shopify product has been created.`);
    } catch (error) {
      setState(error instanceof Error ? error.message : "candidate was not accepted");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-12">
      <SectionHeader eyebrow="Search and select a CJ candidate" accent="text-signal" />
      <div className="panel rounded-2xl p-5">
        <div className="flex gap-3">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search CJ catalogue" className="min-w-0 flex-1 rounded-lg border border-line bg-void px-3 py-2 text-sm text-ink" />
          <button type="button" onClick={search} disabled={busy || query.trim().length < 2} className="rounded-lg bg-white/[0.04] px-4 py-2 text-sm font-semibold text-ink ring-1 ring-white/10 disabled:opacity-50">{busy ? "Searching…" : "Search CJ"}</button>
        </div>
        {results.length > 0 && <div className="mt-4 space-y-3">{results.map((result) => <div key={result.cjProductId} className="rounded-xl border border-line p-3"><p className="text-sm text-ink">{result.title} <span className="font-mono text-[10px] text-ink-faint">CJ {result.cjProductId}</span></p><div className="mt-2 flex flex-wrap gap-2">{result.variants.map((variant) => <button type="button" key={variant.cjVariantId} onClick={() => { setCjProductId(result.cjProductId); setCjVariantId(variant.cjVariantId); setRequestId(crypto.randomUUID()); setState(`Selected ${result.title} / ${variant.label}.`); }} className={`rounded-lg border px-3 py-2 text-left text-[11px] ${cjVariantId === variant.cjVariantId ? "border-signal/70 bg-signal/10 text-signal" : "border-line text-ink-dim"}`}><span className="block">{variant.label} · CJ {variant.cjVariantId}</span><span className="font-mono text-[10px]">US stock {variant.inventoryQty ?? "unknown"} · COGS {variant.cogsUsd == null ? "unknown" : `$${variant.cogsUsd.toFixed(2)}`} · ship {variant.shippingUsd == null ? "unknown" : `$${variant.shippingUsd.toFixed(2)}`}</span></button>)}</div></div>)}</div>}
      </div>
      <form onSubmit={submit} className="mt-3 panel grid grid-cols-1 gap-3 rounded-2xl p-5 md:grid-cols-3 md:items-end">
        <p className="text-[12px] text-ink-dim">{cjProductId ? `Selected CJ ${cjProductId} / ${cjVariantId}` : "Select an exact US CJ variant above."}</p>
        <label className="block"><span className="label-eyebrow text-[9px]">Proposed price (USD)</span><input required min="0.01" step="0.01" type="number" value={priceUsd} onChange={(e) => setPriceUsd(e.target.value)} className="mt-1 w-full rounded-lg border border-line bg-void px-3 py-2 text-sm text-ink" /></label>
        <button disabled={busy || !requestId} className="rounded-lg bg-signal/15 px-4 py-2 text-sm font-semibold text-signal ring-1 ring-signal/30 disabled:opacity-50">{busy ? "Verifying CJ…" : "Verify & request approval"}</button>
        <p className="md:col-span-3 text-[12px] leading-relaxed text-ink-faint">The server refreshes the selected CJ facts, persists one trace and server-derived economics, then opens one human approval for a Shopify DRAFT only. Nothing publishes or imports automatically.</p>
        {state && <p className="md:col-span-3 text-[12px] text-ink-dim">{state}</p>}
      </form>
    </section>
  );
}

function ExperimentsSection({ siteId }: { siteId: Id<"sites"> }) {
  const experiments = useQuery(api.experiments.listBySite, { siteId, limit: 50 });
  const loading = experiments === undefined;
  const rows = (experiments ?? []) as ExperimentRow[];

  return (
    <section className="mt-12">
      <SectionHeader eyebrow="CRO experiments" accent="text-violet" meta={loading ? undefined : `${rows.length} total`} />
      {loading ? (
        <div className="panel rounded-2xl p-6">
          <div className="flex flex-col gap-3">
            {[0, 1].map((i) => <div key={i} className="shimmer h-9 rounded-lg" />)}
          </div>
        </div>
      ) : rows.length === 0 ? (
        <div className="panel rounded-2xl px-6 py-10 text-center">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-xl border border-violet/25 bg-violet/10 text-violet">
            <Icon.spark size={18} />
          </div>
          <p className="font-display text-lg font-medium text-ink">No experiments running</p>
          <p className="mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-ink-dim">
            Once a product has traffic, the brain proposes A/B tests (price, hero, copy) to lift CVR. Each
            running test and its winner will surface here.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {rows.map((e) => {
            const running = e.status === "running";
            return (
              <div key={e._id} className="panel flex items-start justify-between gap-4 rounded-xl px-5 py-4">
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] text-ink">{e.hypothesis}</p>
                  <p className="mt-0.5 font-mono text-[10px] text-ink-faint">
                    {new Date(e.startedAt).toLocaleDateString()}
                    {e.winner ? ` · winner: ${e.winner}` : ""}
                  </p>
                </div>
                {running ? (
                  <Badge ring="bg-violet/10 text-violet ring-1 ring-violet/25" dot="bg-violet" hex="#9b8cff" live>Running</Badge>
                ) : (
                  <Badge ring="bg-live/10 text-live ring-1 ring-live/25" dot="bg-live" hex="#44d6a0">Concluded</Badge>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function ResearchTab({ siteId }: { siteId: Id<"sites"> }) {
  const signals = useQuery(api.signals.listBySite, { siteId, limit: 100 });
  const loading = signals === undefined;
  const rows = (signals ?? []) as SignalRow[];

  const columns: Column<SignalRow>[] = [
    {
      key: "source",
      header: "Source",
      render: (r) => <span className="text-ink">{SOURCE_LABEL[r.source] ?? r.source}</span>,
    },
    {
      key: "type",
      header: "Signal",
      hideBelow: "sm",
      render: (r) => <span className="font-mono text-[12px] text-ink-dim">{r.signalType.replace(/_/g, " ")}</span>,
    },
    {
      key: "value",
      header: "Value",
      align: "right",
      sortable: true,
      sortValue: (r) => r.value,
      render: (r) => <span className="font-mono tabular-nums text-ink">{r.value.toLocaleString()}</span>,
    },
    {
      key: "day",
      header: "Day",
      align: "right",
      hideBelow: "md",
      sortable: true,
      sortValue: (r) => r.day,
      render: (r) => <span className="font-mono text-[11px] text-ink-faint">{r.day}</span>,
    },
  ];

  return (
    <>
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div>
        <SectionHeader eyebrow="Trend signals" accent="text-cyan" meta={loading ? undefined : `${rows.length} points`} />
        <DataTable
          columns={columns}
          rows={rows}
          loading={loading}
          rowKey={(r) => r._id}
          initialSort={{ key: "day", dir: "desc" }}
          empty={{
            glyph: <Icon.research size={26} />,
            title: "No research signals yet",
            body: "The brain pulls rolled-up daily signals from Google Trends, Meta Ad Library, TikTok Creative Center and SERP. Candidates that clear the rubric become product proposals in the approval queue.",
          }}
        />
      </div>

      {/* niche rubric */}
      <aside>
        <SectionHeader eyebrow="Niche rubric" accent="text-signal" />
        <div className="panel flex flex-col gap-1 rounded-2xl p-3">
          {RUBRIC.map((r) => (
            <div key={r.key} className="flex items-start gap-3 rounded-xl px-3 py-2.5">
              <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md bg-signal/10 text-signal">
                <Icon.flame size={12} />
              </span>
              <div className="min-w-0">
                <p className="text-[13px] text-ink">{r.label}</p>
                <p className="font-mono text-[10px] text-ink-faint">{r.note}</p>
              </div>
            </div>
          ))}
          <div className="mt-1 border-t border-line-soft px-3 pt-3">
            <Badge ring="bg-cyan/10 text-cyan ring-1 ring-cyan/25" dot="bg-cyan" hex="#5cc6e8">
              Brain-enforced on every import
            </Badge>
          </div>
        </div>
      </aside>
    </div>
    <SourceCjCandidate siteId={siteId} />
    <ExperimentsSection siteId={siteId} />
    </>
  );
}
