"use client";

import { Suspense, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PageContainer } from "../components/ui/PageContainer";
import { SectionHeader } from "../components/ui/SectionHeader";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Badge } from "../components/ui/Badge";
import { Drawer } from "../components/ui/Drawer";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icons";
import { useBrand } from "../components/shell/useBrand";
import {
  PRODUCT_STATUS,
  type ProductStatus,
  fmtUsd,
} from "../components/tokens";

// ── the locked niche-scoring rubric (NICHE-CRITERIA.md) ──────────────────────
// Weighted criteria the brain scores every candidate against. Rendered as bars
// whose length encodes the weight — organic-first reorders the usual emphasis.
const RUBRIC: { label: string; weight: number; five: string; accent: string }[] = [
  { label: "Content-genic", weight: 3, five: "stops the scroll · obvious before/after", accent: "#e8b04b" },
  { label: "Unfair advantage", weight: 3, five: "you ARE the customer", accent: "#e8b04b" },
  { label: "Margin headroom", weight: 3, five: "≥70% gross · premium price · cheap CJ", accent: "#e8b04b" },
  { label: "Repeat / brand-ability", weight: 3, five: "consumable · reorders · community", accent: "#e8b04b" },
  { label: "Shipping/returns safety", weight: 2, five: "US/EU warehouse · low not-as-described", accent: "#5cc6e8" },
  { label: "Audience reachability", weight: 2, five: "active short-form sub-culture", accent: "#5cc6e8" },
  { label: "Saturation gap", weight: 2, five: "defensible underserved angle", accent: "#5cc6e8" },
];
const MAX_WEIGHT = 3;

const HARD_GATES = [
  "Regulatory/liability landmines (ingestibles, cosmetics, medical, baby/kids, batteries)",
  "Sizing-dependent apparel (returns hell)",
  "Fragile / high-DOA (glass, complex electronics)",
  "Pure-seasonal (Q4-only)",
];

const SOURCE_LABEL: Record<string, string> = {
  google_trends: "Google Trends",
  meta_ad_library: "Meta Ad Library",
  tiktok_cc: "TikTok Creative Center",
  serp: "SERP",
};

type SignalRow = {
  _id: Id<"productSignals">;
  source: string;
  signalType: string;
  value: number;
  day: string;
  siteName?: string;
};

type ProductRow = {
  _id: Id<"products">;
  title: string;
  cjProductId?: string;
  cjFromUsWarehouse: boolean;
  cogsUsd: number;
  shippingUsd: number;
  priceUsd: number;
  contributionMarginPct?: number;
  status: ProductStatus;
  siteName?: string;
};

function RubricBars() {
  return (
    <div className="panel flex flex-col gap-3.5 rounded-2xl p-6">
      {RUBRIC.map((r) => {
        const pct = (r.weight / MAX_WEIGHT) * 100;
        return (
          <div key={r.label}>
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <span className="text-[13px] text-ink">{r.label}</span>
              <span className="font-mono text-[10px] text-ink-faint">×{r.weight}</span>
            </div>
            <div className="h-[7px] w-full overflow-hidden rounded-full bg-void/60 ring-1 ring-line-soft">
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{ width: `${pct}%`, background: r.accent, opacity: 0.85 }}
              />
            </div>
            <p className="mt-1 font-mono text-[10px] text-ink-faint">5 = {r.five}</p>
          </div>
        );
      })}
      <div className="mt-1 border-t border-line-soft pt-3.5">
        <Badge ring="bg-cyan/10 text-cyan ring-1 ring-cyan/25" dot="bg-cyan" hex="#5cc6e8">
          Brain-scored on every candidate
        </Badge>
        <p className="mt-3 text-[12px] leading-relaxed text-ink-faint">
          Organic-only makes <span className="text-ink-dim">content-genic</span> and{" "}
          <span className="text-ink-dim">audience reachability</span> existential — no ad spend to buy
          reach, so the product must earn it.
        </p>
      </div>
    </div>
  );
}

function ProductDrawer({ row, onClose }: { row: ProductRow | null; onClose: () => void }) {
  if (!row) return null;
  const m = row.contributionMarginPct;
  const t = PRODUCT_STATUS[row.status];
  return (
    <Drawer open={!!row} onClose={onClose} eyebrow="Candidate product" title={row.title}>
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-2">
          <Badge ring={t.ring} dot={t.dot} hex={t.hex} live={row.status === "active"}>{t.label}</Badge>
          {row.siteName && <Badge>{row.siteName}</Badge>}
          {row.cjFromUsWarehouse ? (
            <Badge ring="bg-live/10 text-live ring-1 ring-live/25" dot="bg-live" hex="#44d6a0">US warehouse</Badge>
          ) : (
            <Badge>CN / other</Badge>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line-soft bg-line-soft">
          {[
            ["Price", fmtUsd(row.priceUsd)],
            ["Contribution margin", m == null ? "—" : `${m.toFixed(0)}%`],
            ["COGS", fmtUsd(row.cogsUsd)],
            ["Shipping", fmtUsd(row.shippingUsd)],
            ["CJ source", row.cjProductId ? `CJ ${row.cjProductId}` : "not sourced"],
            ["Status", t.label],
          ].map(([k, val]) => (
            <div key={k} className="bg-panel px-4 py-3">
              <dt className="label-eyebrow text-[9px]">{k}</dt>
              <dd className="mt-1 font-mono text-[13px] tabular-nums text-ink">{val}</dd>
            </div>
          ))}
        </dl>
        <p className="text-[12px] leading-relaxed text-ink-faint">
          Margin is computed after COGS + shipping. The brain only proposes candidates that clear the
          {" "}≥70% blended floor and the US-warehouse sourcing gate.
        </p>
      </div>
    </Drawer>
  );
}

function ResearchInner() {
  const { brand, isAll } = useBrand();
  const siteId = isAll ? undefined : (brand as Id<"sites">);
  const scope = isAll ? undefined : { siteId };

  const signals = useQuery(api.signals.listAllAcrossBrands, scope ?? {});
  const products = useQuery(api.products.listAllAcrossBrands, scope ?? {});

  const signalsLoading = signals === undefined;
  const productsLoading = products === undefined;
  const signalRows = (signals ?? []) as SignalRow[];
  const productRows = (products ?? []) as ProductRow[];

  const [active, setActive] = useState<ProductRow | null>(null);

  const signalColumns: Column<SignalRow>[] = useMemo(
    () => [
      {
        key: "source",
        header: "Source",
        render: (r) => <span className="text-ink">{SOURCE_LABEL[r.source] ?? r.source}</span>,
      },
      ...(isAll
        ? [{
            key: "brand",
            header: "Brand",
            hideBelow: "sm" as const,
            render: (r: SignalRow) => <span className="text-ink-dim">{r.siteName ?? "—"}</span>,
          }]
        : []),
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
    ],
    [isAll],
  );

  const productColumns: Column<ProductRow>[] = useMemo(
    () => [
      {
        key: "title",
        header: "Candidate",
        sortable: true,
        sortValue: (r) => r.title.toLowerCase(),
        render: (r) => (
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line-soft bg-void/40 text-ink-faint">
              <Icon.package size={15} />
            </span>
            <div className="min-w-0">
              <p className="truncate font-medium text-ink">{r.title}</p>
              <p className="truncate font-mono text-[10px] text-ink-faint">
                {isAll && r.siteName ? `${r.siteName} · ` : ""}
                {r.cjProductId ? `CJ ${r.cjProductId}` : "no CJ source"}
              </p>
            </div>
          </div>
        ),
      },
      {
        key: "source",
        header: "Source",
        hideBelow: "md",
        render: (r) =>
          r.cjFromUsWarehouse ? (
            <Badge ring="bg-live/10 text-live ring-1 ring-live/25" dot="bg-live" hex="#44d6a0">US warehouse</Badge>
          ) : (
            <Badge>CN / other</Badge>
          ),
      },
      {
        key: "price",
        header: "Price",
        align: "right",
        sortable: true,
        sortValue: (r) => r.priceUsd,
        render: (r) => <span className="font-mono tabular-nums text-ink">{fmtUsd(r.priceUsd)}</span>,
      },
      {
        key: "margin",
        header: "Margin",
        align: "right",
        sortable: true,
        sortValue: (r) => r.contributionMarginPct ?? -1,
        render: (r) => {
          const m = r.contributionMarginPct;
          if (m == null) return <span className="font-mono text-ink-faint">—</span>;
          const tone = m >= 70 ? "text-live" : m >= 50 ? "text-pending" : "text-danger";
          return <span className={`font-mono tabular-nums ${tone}`}>{m.toFixed(0)}%</span>;
        },
      },
      {
        key: "status",
        header: "Status",
        align: "right",
        render: (r) => {
          const t = PRODUCT_STATUS[r.status];
          return <Badge ring={t.ring} dot={t.dot} hex={t.hex} live={r.status === "active"}>{t.label}</Badge>;
        },
      },
    ],
    [isAll],
  );

  return (
    <PageContainer wide>
      <section className="mb-10">
        <div className="mb-4 flex items-center gap-2">
          <span className="label-eyebrow text-signal">Research</span>
          <span className="h-px w-12 bg-line" />
        </div>
        <h1 className="font-display text-[2.2rem] font-medium leading-[1.05] tracking-tight text-ink sm:text-[2.85rem]">
          Trend signals &amp;
          <span className="italic text-signal"> the niche rubric</span>
        </h1>
        <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-ink-dim">
          {isAll
            ? "Cross-brand product discovery. Rolled-up daily signals from Google Trends, Meta Ad Library, TikTok Creative Center and SERP — scored against the locked niche rubric before anything reaches your approval queue."
            : "Discovery scoped to this brand. Signals and candidates are scored against the same locked rubric the brain enforces on every import."}
        </p>
      </section>

      {/* signals + rubric */}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div>
          <SectionHeader
            eyebrow="Trend signals"
            accent="text-cyan"
            meta={signalsLoading ? undefined : `${signalRows.length} points`}
          />
          <DataTable
            columns={signalColumns}
            rows={signalRows}
            loading={signalsLoading}
            rowKey={(r) => r._id}
            initialSort={{ key: "day", dir: "desc" }}
            empty={{
              glyph: <Icon.research size={26} />,
              title: "No research signals yet",
              body: "The brain pulls rolled-up daily signals from Google Trends, Meta Ad Library, TikTok Creative Center and SERP. Seed a niche, run discovery, and candidates that clear the rubric below become product proposals in the approval queue.",
            }}
          />
        </div>

        <aside>
          <SectionHeader eyebrow="Niche-scoring rubric" accent="text-signal" />
          <RubricBars />
        </aside>
      </div>

      {/* hard gates */}
      <section className="mt-12">
        <SectionHeader eyebrow="Auto-disqualify gates" accent="text-danger" />
        <div className="panel grid grid-cols-1 gap-2.5 rounded-2xl p-6 sm:grid-cols-2">
          {HARD_GATES.map((g) => (
            <div key={g} className="flex items-start gap-3 rounded-xl border border-line-soft bg-void/30 px-4 py-3">
              <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md bg-danger/10 text-danger">
                <Icon.flame size={12} />
              </span>
              <p className="text-[12px] leading-relaxed text-ink-dim">{g}</p>
            </div>
          ))}
        </div>
      </section>

      {/* candidate products */}
      <section className="mt-12">
        <SectionHeader
          eyebrow="Candidate products"
          accent="text-signal"
          meta={productsLoading ? undefined : `${productRows.length} candidates`}
        />
        <DataTable
          columns={productColumns}
          rows={productRows}
          loading={productsLoading}
          rowKey={(r) => r._id}
          onRowClick={(r) => setActive(r)}
          initialSort={{ key: "margin", dir: "desc" }}
          empty={{
            glyph: <Icon.package size={26} />,
            title: isAll ? "No candidate products yet" : "No candidates for this brand yet",
            body: "Candidates appear once discovery sources the CJ catalog and scores each product against the rubric above. Seed a niche on the brand page, then run discovery to populate this shortlist.",
            children: (
              <a
                href="/"
                className="inline-flex items-center gap-2 rounded-full border border-line bg-panel/60 px-5 py-2.5 text-[13px] font-medium text-ink-dim transition hover:border-signal/40 hover:text-ink"
              >
                Go to portfolio &rarr;
              </a>
            ),
          }}
        />
      </section>

      <ProductDrawer row={active} onClose={() => setActive(null)} />
    </PageContainer>
  );
}

export default function ResearchPage() {
  return (
    <Suspense fallback={<PageContainer><div className="shimmer h-64 rounded-2xl" /></PageContainer>}>
      <ResearchInner />
    </Suspense>
  );
}
