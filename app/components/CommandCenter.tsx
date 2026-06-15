"use client";

// The structured analytics overview — rendered both as the portfolio Command
// Center (scope="all", from app/page.tsx) and per-brand (scope=siteId, from the
// Overview tab). One cohesive surface, scope-parameterised. All numbers come
// from index-driven Convex queries; charts are the bespoke SVG set.

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { KpiTile } from "./ui/KpiTile";
import { SectionHeader } from "./ui/SectionHeader";
import { Segmented } from "./ui/Segmented";
import { InsightCard, type InsightData } from "./ui/InsightCard";
import { ActivityFeed, type AuditEntry } from "./ui/ActivityFeed";
import { DataTable, type Column } from "./ui/DataTable";
import { AreaChart, LineChart, BarChart, Funnel, RadialGauge, Heatmap, MiniBars } from "./charts";
import { Icon } from "./Icons";
import { fmtUsd, fmtCompact, PLATFORM, type Platform } from "./tokens";

type Timeframe = 7 | 30 | 90;
type PlatformFilter = "all" | Platform;

const C = { signal: "#e8b04b", live: "#44d6a0", cyan: "#5cc6e8", violet: "#9b8cff", pending: "#f0a93b" };

type TopProduct = {
  productId: string;
  title: string;
  siteName: string;
  views: number;
  cvr: number;
  marginPct: number | null;
  priceUsd: number;
  trend: number[];
  status: string;
};

export function CommandCenter({ scope = "all" }: { scope?: string }) {
  const [tf, setTf] = useState<Timeframe>(30);
  const [pf, setPf] = useState<PlatformFilter>("all");

  // primary metric series + secondary series, all scoped + windowed (re-queries on tf/pf change)
  const revenue = useQuery(api.dashboard.timeseries, { scope, metric: "revenue", days: tf });
  const orders = useQuery(api.dashboard.timeseries, { scope, metric: "orders", days: tf });
  const views = useQuery(api.dashboard.timeseries, { scope, metric: "views", days: tf, platform: pf });
  const engagement = useQuery(api.dashboard.timeseries, { scope, metric: "engagement", days: tf, platform: pf });
  const platforms = useQuery(api.dashboard.platformBreakdown, { scope, days: tf });
  const funnel = useQuery(api.dashboard.funnel, { scope, days: tf });
  const products = useQuery(api.dashboard.topProducts, { scope, limit: 6 });
  const insights = useQuery(api.insights.list, { scope, days: tf });
  const cadence = useQuery(api.dashboard.postingCadence, { scope, days: 84 });
  const gate = useQuery(api.dashboard.contentFitGate, scope === "all" ? {} : { siteId: scope as never });
  const portfolio = useQuery(api.dashboard.portfolio);
  const recent = useQuery(
    scope === "all" ? api.audit.listRecent : api.audit.listBySite,
    scope === "all" ? { limit: 8 } : ({ siteId: scope as never, limit: 8 } as never),
  );

  const tfLabel = `${tf}d`;

  // KPI strip values
  const netRevenue = revenue?.total ?? 0;
  const orderCount = orders?.total ?? 0;
  const viewTotal = views?.total ?? 0;
  const pendingTotal = portfolio?.totalPendingActions ?? 0;
  // contribution margin: weighted from top products (representative blended)
  const marginVals = (products ?? []).map((p) => p.marginPct).filter((m): m is number => m != null);
  const blendedMargin = marginVals.length ? marginVals.reduce((s, m) => s + m, 0) / marginVals.length : 0;
  const gatePassed = gate?.passed ?? false;
  const bestVideoViews = gate?.bestVideo?.views ?? 0;

  const spark = (s?: { points: { value: number }[] }) => (s ? s.points.map((p) => p.value) : undefined);

  const platformBars =
    (platforms ?? [])
      .filter((p) => p.posts > 0)
      .map((p) => ({
        label: PLATFORM[p.platform as Platform]?.label ?? p.platform,
        value: p.views,
        color: PLATFORM[p.platform as Platform]?.hex,
        sublabel: `${p.posts}p`,
      })) ?? [];

  const productCols: Column<TopProduct>[] = [
    {
      key: "title",
      header: "Product",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-ink">{r.title}</div>
          {scope === "all" && <div className="font-mono text-[10px] text-ink-faint">{r.siteName}</div>}
        </div>
      ),
    },
    {
      key: "trend",
      header: "14d views",
      hideBelow: "md",
      render: (r) => <MiniBars data={r.trend.length ? r.trend : [0]} color={C.cyan} />,
    },
    {
      key: "views",
      header: "Views",
      align: "right",
      sortable: true,
      sortValue: (r) => r.views,
      render: (r) => <span className="font-mono tabular-nums text-ink-dim">{fmtCompact(r.views)}</span>,
    },
    {
      key: "cvr",
      header: "CVR",
      align: "right",
      sortable: true,
      sortValue: (r) => r.cvr,
      hideBelow: "sm",
      render: (r) => <span className="font-mono tabular-nums text-ink-dim">{r.cvr.toFixed(1)}%</span>,
    },
    {
      key: "margin",
      header: "Margin",
      align: "right",
      sortable: true,
      sortValue: (r) => r.marginPct ?? 0,
      render: (r) =>
        r.marginPct == null ? (
          <span className="text-ink-faint">—</span>
        ) : (
          <span className={`font-mono tabular-nums ${r.marginPct >= 70 ? "text-live" : r.marginPct >= 50 ? "text-pending" : "text-danger"}`}>
            {r.marginPct.toFixed(0)}%
          </span>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-10">
      {/* ── controls bar ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2.5">
          <Segmented<string>
            options={[
              { value: "7", label: "7d" },
              { value: "30", label: "30d" },
              { value: "90", label: "90d" },
            ]}
            value={String(tf)}
            onChange={(v) => setTf(Number(v) as Timeframe)}
          />
          <Segmented<PlatformFilter>
            size="sm"
            options={[
              { value: "all", label: "All" },
              { value: "tiktok", label: "TT" },
              { value: "instagram", label: "IG" },
              { value: "youtube", label: "YT" },
            ]}
            value={pf}
            onChange={setPf}
          />
        </div>
        <div className="flex items-center gap-2">
          <Link href="/content" className="inline-flex items-center gap-1.5 rounded-full bg-signal px-3.5 py-2 text-[12px] font-semibold text-void transition hover:bg-signal-deep">
            <Icon.spark size={13} /> Generate batch
          </Link>
          <Link
            href="/approvals"
            className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-[12px] font-medium transition ${
              pendingTotal > 0 ? "border-pending/40 bg-pending/10 text-pending hover:bg-pending/15" : "border-line bg-panel/60 text-ink-dim hover:text-ink"
            }`}
          >
            <Icon.approvals size={13} /> Approvals{pendingTotal > 0 ? ` · ${pendingTotal}` : ""}
          </Link>
        </div>
      </div>

      {/* ── hero KPI strip ───────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-5">
        <KpiTile
          label={`Net revenue · ${tfLabel}`}
          numericValue={netRevenue}
          format={(n) => fmtUsd(n, 0)}
          delta={revenue?.deltaPct ?? null}
          spark={spark(revenue)}
          sparkColor={C.live}
          dotHex={C.live}
          accent="text-ink"
          loading={revenue === undefined}
          hint="take-home after platform fees"
        />
        <KpiTile
          label="Contribution margin"
          numericValue={blendedMargin}
          format={(n) => `${Math.round(n)}%`}
          accent={blendedMargin >= 70 ? "text-live" : "text-ink"}
          sparkColor={C.signal}
          loading={products === undefined}
          hint="blended across top products"
        />
        <KpiTile
          label={`Orders · ${tfLabel}`}
          numericValue={orderCount}
          delta={orders?.deltaPct ?? null}
          spark={spark(orders)}
          sparkColor={C.cyan}
          loading={orders === undefined}
        />
        <KpiTile
          label={`Organic views · ${tfLabel}`}
          numericValue={viewTotal}
          format={(n) => fmtCompact(Math.round(n))}
          delta={views?.deltaPct ?? null}
          spark={spark(views)}
          sparkColor={C.violet}
          loading={views === undefined}
        />
        <KpiTile
          label="Content-fit gate"
          value={gatePassed ? "Fit" : "Pending"}
          accent={gatePassed ? "text-live" : "text-pending"}
          dotHex={gatePassed ? C.live : C.pending}
          pulse={gatePassed}
          loading={gate === undefined}
          hint={bestVideoViews > 0 ? `best ${fmtCompact(bestVideoViews)} / 10k` : "no breakout yet"}
        />
      </div>

      {/* ── primary chart ────────────────────────────────────────────── */}
      <div className="panel rounded-2xl p-6 sm:p-7">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <span className="label-eyebrow text-signal">Revenue & contribution</span>
            <p className="mt-2 font-display text-[1.9rem] font-medium tabular-nums leading-none text-ink">
              {revenue === undefined ? "—" : fmtUsd(netRevenue, 0)}
            </p>
            <p className="mt-1.5 font-mono text-[11px] text-ink-faint">trailing {tfLabel} · daily</p>
          </div>
        </div>
        <AreaChart
          data={(revenue?.points ?? []).map((p) => ({ label: p.day.slice(5), value: p.value }))}
          color={C.signal}
          height={260}
          valuePrefix="$"
          format={(n) => n.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          emptyHint="Revenue populates once orders flow in this window."
        />
      </div>

      {/* ── secondary row: reach trend · funnel · content-fit gauge ──── */}
      <div className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-3">
        <div className="panel flex min-h-[320px] flex-col rounded-2xl p-6">
          <SectionHeader eyebrow="Organic reach" accent="text-violet" meta={tfLabel} />
          <div className="flex flex-1 flex-col justify-center">
            <LineChart
              labels={(views?.points ?? []).map((p) => p.day.slice(5))}
              series={[
                { name: "Views", color: C.violet, data: (views?.points ?? []).map((p) => p.value), format: (n) => fmtCompact(n) },
                { name: "Engagement", color: C.cyan, data: (engagement?.points ?? []).map((p) => p.value), format: (n) => fmtCompact(n) },
              ]}
              height={208}
              emptyHint="No published-post reach yet."
            />
          </div>
        </div>

        <div className="panel flex min-h-[320px] flex-col rounded-2xl p-6">
          <SectionHeader eyebrow="Conversion funnel" accent="text-cyan" meta={tfLabel} />
          <div className="flex flex-1 flex-col justify-center">
            <Funnel
              stages={funnel?.stages ?? []}
              color={C.cyan}
              format={(n) => fmtCompact(n)}
              emptyHint="Funnel populates once traffic flows."
            />
          </div>
        </div>

        <div className="panel flex min-h-[320px] flex-col rounded-2xl p-6">
          <SectionHeader eyebrow="Content-fit milestone" accent="text-signal" className="w-full" />
          <div className="flex flex-1 items-center justify-center">
            <RadialGauge
              value={bestVideoViews}
              target={10000}
              label={gatePassed ? "Gate cleared" : "To 10k views"}
              color={gatePassed ? C.live : C.signal}
              caption={
                gate?.bestVideo
                  ? `Best: ${gate.bestVideo.platform} · ${fmtCompact(bestVideoViews)} views`
                  : "Best organic post toward the go/kill gate."
              }
            />
          </div>
        </div>
      </div>

      {/* ── breakdowns: platform bars · posting cadence ──────────────── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="panel rounded-2xl p-6">
          <SectionHeader eyebrow="Platform performance" accent="text-cyan" meta={`views · ${tfLabel}`} />
          {platforms === undefined ? (
            <div className="flex flex-col gap-3">{[0, 1, 2].map((i) => <div key={i} className="shimmer h-6 rounded-md" />)}</div>
          ) : (
            <BarChart data={platformBars} format={(n) => fmtCompact(n)} emptyHint="No published posts in window." />
          )}
        </div>

        <div className="panel rounded-2xl p-6">
          <SectionHeader eyebrow="Posting cadence" accent="text-signal" meta="published · 12w" />
          {cadence === undefined ? (
            <div className="shimmer h-28 rounded-md" />
          ) : (
            <Heatmap cells={cadence} color={C.signal} weeks={12} format={(n) => `${n} post${n > 1 ? "s" : ""}`} emptyHint="No posting activity yet." />
          )}
        </div>
      </div>

      {/* ── top products ─────────────────────────────────────────────── */}
      <div>
        <SectionHeader eyebrow="Top products" meta={products ? `${products.length} ranked by reach` : undefined} />
        <DataTable<TopProduct>
          columns={productCols}
          rows={(products ?? []) as TopProduct[]}
          rowKey={(r) => r.productId}
          loading={products === undefined}
          initialSort={{ key: "views", dir: "desc" }}
          empty={{
            glyph: <Icon.package size={24} />,
            title: "No product metrics yet",
            body: "Top products appear here once conversion metrics accrue.",
          }}
        />
      </div>

      {/* ── insights ─────────────────────────────────────────────────── */}
      <div>
        <SectionHeader eyebrow="Insights" accent="text-signal" meta="rule-based · computed" />
        {insights === undefined ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <div key={i} className="shimmer h-36 rounded-2xl" />)}
          </div>
        ) : insights.insights.length === 0 ? (
          <p className="panel rounded-2xl px-6 py-8 text-center text-[13px] text-ink-faint">
            No insights yet — they surface as the data accrues.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {(insights.insights as InsightData[]).map((ins, i) => (
              <InsightCard key={ins.id} insight={ins} index={i} />
            ))}
          </div>
        )}
      </div>

      {/* ── activity rail ────────────────────────────────────────────── */}
      <div className="panel rounded-2xl p-6">
        <SectionHeader eyebrow="Recent activity" accent="text-cyan" />
        {recent === undefined ? (
          <div className="flex flex-col gap-3">{[0, 1, 2, 3].map((i) => <div key={i} className="shimmer h-9 rounded-lg" />)}</div>
        ) : (recent as AuditEntry[]).length === 0 ? (
          <p className="py-6 text-center text-[13px] text-ink-faint">No activity yet. Events land here as the brain works.</p>
        ) : (
          <ActivityFeed entries={recent as AuditEntry[]} showSite={scope === "all"} dense />
        )}
      </div>
    </div>
  );
}
