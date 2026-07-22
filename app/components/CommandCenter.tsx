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
import { MetricDelta } from "./ui/MetricDelta";
import { AreaChart, LineChart, BarChart, Funnel, RadialGauge, Heatmap, MiniBars } from "./charts";
import { StatusDot } from "./StatusDot";
import { Icon } from "./Icons";
import { fmtUsd, fmtCompact, PLATFORM, type Platform } from "./tokens";
import { commercePresentationState } from "@/src/lib/commercePresentation";

type Timeframe = 7 | 30 | 90;
type PlatformFilter = "all" | Platform;

const C = { signal: "#e8b04b", live: "#44d6a0", cyan: "#5cc6e8", violet: "#9b8cff", pending: "#f0a93b" };

type TopProduct = {
  productId: string;
  title: string;
  siteName: string;
  views: number;
  cvr: number | null;
  marginPct: number | null;
  priceUsd: number;
  trend: number[];
  status: string;
};

export function CommandCenter({ scope = "all" }: { scope?: string }) {
  const [tf, setTf] = useState<Timeframe>(30);
  const [pf, setPf] = useState<PlatformFilter>("all");

  const snapshot = useQuery(api.dashboard.commandCenterSnapshot, { scope, days: tf, platform: pf });
  const data = snapshot?.projectionState === "ready" || snapshot?.projectionState === "legacy" ? snapshot : undefined;
  const revenue = data?.revenue;
  const orders = data?.orders;
  const views = data?.views;
  const engagement = data?.engagement;
  const platforms = data?.platforms;
  const funnel = data?.funnel;
  const products = data?.products;
  const insights = data?.insights;
  const cadence = data?.cadence;
  const gate = data?.gate;
  const recent = useQuery(
    scope === "all" ? api.audit.listRecent : api.audit.listBySite,
    scope === "all" ? { limit: 8 } : ({ siteId: scope as never, limit: 8 } as never),
  );

  const tfLabel = `${tf}d`;
  const commerce = commercePresentationState({
    days: tf,
    revenueVerified: revenue?.commerceVerified,
    ordersVerified: orders?.commerceVerified,
    funnelVerified: funnel?.commerceVerified,
  });
  const commerceVerified = commerce.verified;
  const commerceLoading = commerce.loading;
  const commerceAwaiting = commerce.detail;

  // KPI strip values
  const netRevenue = revenue?.total ?? 0;
  const orderCount = orders?.total ?? 0;
  const viewTotal = views?.total ?? 0;
  const pendingTotal = data?.pendingTotal ?? 0;
  // contribution margin: weighted from top products (representative blended)
  const marginVals = (products ?? []).map((p: TopProduct) => p.marginPct).filter((m: number | null): m is number => m != null);
  const blendedMargin = marginVals.length ? marginVals.reduce((s: number, m: number) => s + m, 0) / marginVals.length : 0;
  const marginVerified = commerceVerified && marginVals.length > 0;
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
      render: (r, i) => (
        <div className="flex min-w-0 items-center gap-3">
          <span className="num w-4 shrink-0 text-right text-[11px] text-ink-faint">{i + 1}</span>
          <div className="min-w-0">
            <div className="truncate font-medium text-ink">{r.title}</div>
            {scope === "all" && <div className="num text-[10px] text-ink-faint">{r.siteName}</div>}
          </div>
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
      render: (r) => <span className="num text-[13px] text-ink">{fmtCompact(r.views)}</span>,
    },
    {
      key: "cvr",
      header: "CVR",
      align: "right",
      sortable: true,
      sortValue: (r) => r.cvr ?? 0,
      hideBelow: "sm",
      render: (r) => r.cvr == null ? <span className="text-ink-faint">Unavailable</span> : <span className="num text-ink-dim">{r.cvr.toFixed(1)}%</span>,
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
    <div className="flex flex-col gap-9">
      {/* ── controls bar ─────────────────────────────────────────────── */}
      <div className="animate-rise flex flex-col gap-3 rounded-2xl border border-line-soft/70 bg-panel/30 px-3 py-2.5 backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="hidden caption uppercase tracking-wider text-ink-faint sm:inline">Window</span>
            <Segmented<string>
              options={[
                { value: "7", label: "7d" },
                { value: "30", label: "30d" },
                { value: "90", label: "90d" },
              ]}
              value={String(tf)}
              onChange={(v) => setTf(Number(v) as Timeframe)}
            />
          </div>
          <span className="hidden h-5 w-px bg-line-soft sm:block" />
          <div className="flex items-center gap-2">
            <span className="hidden caption uppercase tracking-wider text-ink-faint sm:inline">Platform</span>
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
        </div>
        <div className="flex items-center gap-2">
          <Link href="/content" className="inline-flex items-center gap-1.5 rounded-full bg-signal px-3.5 py-2 text-[12px] font-semibold text-void shadow-[0_6px_18px_-8px_rgba(232,176,75,0.8)] transition hover:bg-signal-deep">
            <Icon.spark size={13} /> Generate batch
          </Link>
          <Link
            href="/approvals"
            className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-[12px] font-medium transition ${
              pendingTotal > 0
                ? "border-pending/40 bg-pending/10 text-pending hover:bg-pending/15"
                : "border-line bg-panel/60 text-ink-dim hover:text-ink"
            }`}
          >
            <Icon.approvals size={13} /> Approvals
            {pendingTotal > 0 && (
              <span className="ml-0.5 inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-pending px-1 num text-[10px] font-semibold text-void">
                {pendingTotal}
              </span>
            )}
          </Link>
        </div>
      </div>

      {/* ── hero KPI strip ───────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-5">
        {[
          <KpiTile
            key="rev"
            label={`Net revenue · ${tfLabel}`}
            {...(commerceVerified ? { numericValue: netRevenue, format: (n: number) => fmtUsd(n, 0) } : { value: "Unverified" })}
            delta={commerceVerified ? revenue?.deltaPct ?? null : undefined}
            deltaLabel="vs prior"
            spark={commerceVerified ? spark(revenue) : undefined}
            sparkColor={C.live}
            dotHex={commerceVerified ? C.live : C.pending}
            accent={commerceVerified ? "text-ink" : "text-pending"}
            loading={commerceLoading}
            hint={commerceVerified ? "take-home after platform fees" : commerceAwaiting}
          />,
          <KpiTile
            key="margin"
            label="Contribution margin"
            {...(marginVerified ? { numericValue: blendedMargin, format: (n: number) => `${Math.round(n)}%` } : { value: "Unverified" })}
            accent={marginVerified ? (blendedMargin >= 70 ? "text-live" : "text-ink") : "text-pending"}
            sparkColor={C.signal}
            loading={products === undefined || commerceLoading}
            hint={marginVerified ? "blended across top products" : commerceVerified ? "Awaiting verified cost evidence" : commerceAwaiting}
          />,
          <KpiTile
            key="orders"
            label={`Orders · ${tfLabel}`}
            {...(commerceVerified ? { numericValue: orderCount } : { value: "Unverified" })}
            delta={commerceVerified ? orders?.deltaPct ?? null : undefined}
            deltaLabel="vs prior"
            spark={commerceVerified ? spark(orders) : undefined}
            sparkColor={C.cyan}
            dotHex={commerceVerified ? C.cyan : C.pending}
            accent={commerceVerified ? "text-ink" : "text-pending"}
            loading={commerceLoading}
            hint={commerceVerified ? undefined : commerceAwaiting}
          />,
          <KpiTile
            key="views"
            label={`Organic views · ${tfLabel}`}
            numericValue={viewTotal}
            format={(n) => fmtCompact(Math.round(n))}
            delta={views?.deltaPct ?? null}
            deltaLabel="vs prior"
            spark={spark(views)}
            sparkColor={C.violet}
            loading={views === undefined}
          />,
          <KpiTile
            key="gate"
            label="Content-fit gate"
            value={gatePassed ? "Fit" : "Pending"}
            accent={gatePassed ? "text-live" : "text-pending"}
            dotHex={gatePassed ? C.live : C.pending}
            pulse={gatePassed}
            loading={gate === undefined}
            hint={bestVideoViews > 0 ? `best ${fmtCompact(bestVideoViews)} / 10k` : "no breakout yet"}
          />,
        ].map((tile, i) => (
          <div key={i} className="animate-rise" style={{ animationDelay: `${60 + i * 55}ms` }}>
            {tile}
          </div>
        ))}
      </div>

      {/* ── primary chart ────────────────────────────────────────────── */}
      <div className="panel-hero animate-rise rounded-2xl p-6 sm:p-7" style={{ animationDelay: "120ms" }}>
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="label-eyebrow text-signal">Revenue &amp; contribution</span>
            <p className="mt-2.5 font-display text-[2rem] font-medium tabular-nums leading-none text-ink">
              {commerceLoading ? "—" : commerceVerified ? fmtUsd(netRevenue, 0) : "Unverified"}
            </p>
            <p className="mt-2 num text-[11px] text-ink-faint">{commerceVerified ? `trailing ${tfLabel} · daily net revenue` : commerceAwaiting}</p>
          </div>
          <div className="flex items-center gap-2.5">
            {commerceVerified && revenue?.deltaPct != null && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-line-soft bg-panel-2/60 px-2.5 py-1.5">
                <MetricDelta value={revenue.deltaPct} />
                <span className="caption text-ink-faint">vs prior {tfLabel}</span>
              </span>
            )}
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 ${commerceVerified ? "border-live/25 bg-live/5" : "border-pending/25 bg-pending/5"}`}>
              <StatusDot className={commerceVerified ? "bg-live" : "bg-pending"} hex={commerceVerified ? C.live : C.pending} live={commerceVerified} size={6} />
              <span className="caption uppercase tracking-wider text-ink-dim">{commerce.label}</span>
            </span>
          </div>
        </div>
        <AreaChart
          data={commerceVerified ? (revenue?.points ?? []).map((p) => ({ label: p.day.slice(5), value: p.value })) : []}
          color={C.signal}
          height={272}
          valuePrefix="$"
          format={(n) => n.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          emptyHint={commerceVerified ? "Revenue populates once orders flow in this window." : `${commerceAwaiting}; commerce values are withheld.`}
        />
      </div>

      {/* ── secondary row: reach trend · funnel · content-fit gauge ──── */}
      <div className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-3">
        <div className="panel animate-rise flex min-h-[328px] flex-col rounded-2xl p-6" style={{ animationDelay: "160ms" }}>
          <SectionHeader eyebrow="Organic reach" accent="text-violet" meta={tfLabel} />
          <div className="flex flex-1 flex-col justify-center">
            <LineChart
              labels={(views?.points ?? []).map((p) => p.day.slice(5))}
              series={[
                { name: "Views", color: C.violet, data: (views?.points ?? []).map((p) => p.value), format: (n) => fmtCompact(n) },
                { name: "Engagement", color: C.cyan, data: (engagement?.points ?? []).map((p) => p.value), format: (n) => fmtCompact(n) },
              ]}
              height={216}
              emptyHint="No published-post reach yet."
            />
          </div>
        </div>

        <div className="panel animate-rise flex min-h-[328px] flex-col rounded-2xl p-6" style={{ animationDelay: "200ms" }}>
          <SectionHeader eyebrow="Conversion funnel" accent="text-cyan" meta={tfLabel} />
          <div className="flex flex-1 flex-col justify-center">
            {funnel?.conversionAvailability.state === "unavailable" ? (
              <div className="rounded-xl border border-pending/25 bg-pending/5 px-4 py-5 text-center">
                <p className="font-medium text-pending">Provider conversion unavailable</p>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-dim">{funnel.conversionAvailability.reason}</p>
              </div>
            ) : commerceVerified ? (
              <Funnel
                stages={funnel?.stages ?? []}
                color={C.cyan}
                format={(n) => fmtCompact(n)}
                emptyHint="Funnel populates once traffic flows."
              />
            ) : (
              <div className="rounded-xl border border-pending/25 bg-pending/5 px-4 py-5 text-center">
                <p className="font-medium text-pending">Commerce unverified</p>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-dim">{commerceAwaiting}. Content reach remains available.</p>
              </div>
            )}
          </div>
        </div>

        <div className="panel animate-rise flex min-h-[328px] flex-col rounded-2xl p-6" style={{ animationDelay: "240ms" }}>
          <SectionHeader eyebrow="Content-fit milestone" accent="text-signal" className="w-full" />
          <div className="flex flex-1 items-center justify-center py-2">
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
            <div className="flex flex-col gap-3.5">{[0, 1, 2].map((i) => <div key={i} className="shimmer h-7 rounded-md" />)}</div>
          ) : (
            <div className="pt-1">
              <BarChart data={platformBars} format={(n) => fmtCompact(n)} emptyHint="No published posts in window." />
            </div>
          )}
        </div>

        <div className="panel rounded-2xl p-6">
          <SectionHeader eyebrow="Posting cadence" accent="text-signal" meta="published · 12w" />
          {cadence === undefined ? (
            <div className="shimmer h-28 rounded-md" />
          ) : (
            <div className="pt-1">
              <Heatmap cells={cadence} color={C.signal} weeks={12} format={(n) => `${n} post${n > 1 ? "s" : ""}`} emptyHint="No posting activity yet." />
            </div>
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
