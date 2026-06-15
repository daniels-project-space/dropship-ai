"use client";

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
  );
}
