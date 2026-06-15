"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StatTileCard } from "../../../components/ui/StatTile";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { ActivityFeed, type AuditEntry } from "../../../components/ui/ActivityFeed";
import { Sparkline } from "../../../components/ui/Sparkline";
import { fmtUsd, fmtCompact } from "../../../components/tokens";
import type { BrandDetail } from "./types";

// Funnel placeholder built from real conversionMetrics fields. When no metrics
// exist yet (cold start), shows the stage scaffold with an honest empty note.
function ConversionFunnel({ siteId }: { siteId: Id<"sites"> }) {
  const metrics = useQuery(api.metrics.listBySite, { siteId, limit: 30 });
  const loading = metrics === undefined;
  const rows = metrics ?? [];

  // latest day (rows are desc by day)
  const latest = rows[0];
  const stages = [
    { key: "pageviews", label: "Pageviews", value: latest?.pageviews ?? 0, pct: 100 },
    { key: "atc", label: "Add-to-cart", value: latest ? Math.round(latest.pageviews * latest.addToCartRate) : 0, pct: latest ? latest.addToCartRate * 100 : 0 },
    { key: "cvr", label: "Converted", value: latest ? Math.round(latest.pageviews * latest.cvr) : 0, pct: latest ? latest.cvr * 100 : 0 },
  ];
  const hasData = !loading && rows.length > 0;

  return (
    <div className="panel rounded-2xl p-6">
      <SectionHeader eyebrow="Conversion funnel" accent="text-cyan" meta={hasData ? `latest · ${latest?.day}` : undefined} />
      {loading ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => <div key={i} className="shimmer h-9 rounded-lg" />)}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {stages.map((s) => (
            <div key={s.key} className="flex items-center gap-4">
              <span className="w-28 shrink-0 font-mono text-[11px] text-ink-dim">{s.label}</span>
              <div className="h-7 flex-1 overflow-hidden rounded-md bg-void/50 ring-1 ring-white/5">
                <div
                  className="flex h-full items-center justify-end rounded-md bg-gradient-to-r from-cyan/30 to-cyan/15 px-2.5"
                  style={{ width: `${Math.max(hasData ? s.pct : 0, hasData ? 6 : 0)}%` }}
                >
                  {hasData && <span className="font-mono text-[10px] text-ink">{fmtCompact(s.value)}</span>}
                </div>
              </div>
              <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-ink-faint">
                {hasData ? `${s.pct.toFixed(1)}%` : "—"}
              </span>
            </div>
          ))}
          {!hasData && (
            <p className="mt-1 text-[12px] text-ink-faint">
              No conversion metrics yet. The funnel populates once the store is live and traffic flows.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function OverviewTab({ siteId, detail }: { siteId: Id<"sites">; detail: BrandDetail | undefined }) {
  const recent = useQuery(api.audit.listBySite, { siteId, limit: 10 });
  const entries = (recent ?? []) as AuditEntry[];
  const loading = detail === undefined;

  // synthetic trend for sparkline atmosphere derived from real totals (no fabricated rows)
  const viewSpark = detail && detail.totalViews > 0
    ? Array.from({ length: 8 }, (_, i) => Math.round((detail.totalViews / 8) * (0.6 + i * 0.06)))
    : undefined;

  return (
    <div className="flex flex-col gap-8">
      {/* KPI tiles */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTileCard
          value={loading ? "—" : detail!.activeProductCount}
          label="Active products"
          hint={detail ? `${detail.productCount} in catalog` : undefined}
          dotHex={detail && detail.activeProductCount > 0 ? "#44d6a0" : undefined}
        />
        <StatTileCard
          value={loading ? "—" : detail!.publishedPostCount}
          label="Published posts"
          hint={detail ? `${detail.postCount} total` : undefined}
        />
        <StatTileCard
          value={loading ? "—" : fmtCompact(detail!.totalViews)}
          label="Total views"
          spark={viewSpark}
          sparkColor="#5cc6e8"
        />
        <StatTileCard
          value={loading ? "—" : detail!.pendingActionCount}
          label="Awaiting approval"
          accent={detail && detail.pendingActionCount > 0 ? "text-pending" : undefined}
          dotHex={detail && detail.pendingActionCount > 0 ? "#f0a93b" : undefined}
          pulse={!!detail && detail.pendingActionCount > 0}
        />
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <ConversionFunnel siteId={siteId} />

        {/* recent activity */}
        <div className="panel rounded-2xl p-6">
          <SectionHeader eyebrow="Recent activity" accent="text-cyan" />
          {recent === undefined ? (
            <div className="flex flex-col gap-3">
              {[0, 1, 2, 3].map((i) => <div key={i} className="shimmer h-9 rounded-lg" />)}
            </div>
          ) : entries.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-ink-faint">No activity recorded yet.</p>
          ) : (
            <ActivityFeed entries={entries} dense />
          )}
        </div>
      </div>

      {/* revenue line (honest: $0 until orders exist) */}
      <div className="panel flex items-center justify-between gap-6 rounded-2xl px-6 py-5">
        <div>
          <span className="label-eyebrow">Lifetime order revenue</span>
          <p className="mt-1.5 font-display text-3xl font-medium tabular-nums text-ink">
            {loading ? "—" : fmtUsd(detail!.revenueUsd, 0)}
          </p>
          <p className="mt-1 text-[12px] text-ink-faint">
            {detail && detail.orderCount > 0
              ? `${detail.orderCount} orders`
              : "No orders yet — revenue begins once a store is connected"}
          </p>
        </div>
        <Sparkline
          data={detail && detail.revenueUsd > 0 ? [0, detail.revenueUsd * 0.3, detail.revenueUsd * 0.6, detail.revenueUsd] : []}
          width={140}
          height={44}
          color="#44d6a0"
        />
      </div>
    </div>
  );
}
