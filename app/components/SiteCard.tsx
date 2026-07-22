"use client";

import Link from "next/link";
import { StatusDot } from "./StatusDot";
import { SITE_STATUS, type SiteStatus } from "./tokens";

export type PortfolioSite = {
  siteId: string;
  name: string;
  niche: string;
  status: SiteStatus;
  distributionMode: "semi_manual" | "automated";
  shopifyDomain: string | null;
  shopifyNeedsReverification: boolean;
  shopifyEconomicsSyncState: "not_connected" | "needs_reverification" | "pending" | "current" | "stale" | "failed" | "incomplete";
  customDomain: string | null;
  killDate: number | null;
  pendingActionCount: number;
  activeProductCount: number;
  ordersAwaitingFulfillment: number;
};

function Metric({
  value,
  label,
  accent = false,
  pulse = false,
}: {
  value: number | string;
  label: string;
  accent?: boolean;
  pulse?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        {pulse && <StatusDot className="bg-pending" hex="#f0a93b" live size={6} />}
        <span
          className={`font-mono text-xl tabular-nums leading-none ${
            accent ? "text-pending" : "text-ink"
          }`}
        >
          {value}
        </span>
      </div>
      <span className="label-eyebrow text-[9.5px]">{label}</span>
    </div>
  );
}

export function SiteCard({ site, index = 0 }: { site: PortfolioSite; index?: number }) {
  const tone = SITE_STATUS[site.status];
  const domain = site.customDomain ?? site.shopifyDomain ?? "domain pending";
  const hasPending = site.pendingActionCount > 0;

  return (
    <article
      className="panel animate-rise group relative flex flex-col overflow-hidden rounded-2xl p-6 transition-transform duration-300 hover:-translate-y-1"
      style={{ animationDelay: `${index * 70}ms` }}
    >
      {/* accent hairline that lights up on hover */}
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-signal/40 to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100"
      />

      <header className="flex items-start justify-between gap-3">
        <Link href={`/sites/${site.siteId}`} className="min-w-0">
          <h3 className="truncate font-display text-[19px] font-medium tracking-tight text-ink transition-colors group-hover:text-signal">
            {site.name}
          </h3>
          <p className="mt-1 truncate font-mono text-[11px] text-ink-faint">
            {domain}
          </p>
        </Link>
        <div
          className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${tone.ring}`}
        >
          <StatusDot
            className={tone.dot}
            hex={tone.hex}
            live={site.status === "active"}
            size={6}
          />
          {tone.label}
        </div>
      </header>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-white/[0.04] px-2 py-0.5 text-[11px] text-ink-dim ring-1 ring-white/5">
          {site.niche}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
          {site.distributionMode === "automated" ? "automated" : "semi-manual"}
        </span>
      </div>

      {site.shopifyNeedsReverification && (
        <p className="mt-3 rounded-lg border border-pending/25 bg-pending/5 px-3 py-2 text-[11px] text-pending">
          Shopify needs re-verification; order and revenue readiness is withheld.
        </p>
      )}
      {!site.shopifyNeedsReverification && site.shopifyEconomicsSyncState !== "current" && (
        <p className="mt-3 rounded-lg border border-pending/25 bg-pending/5 px-3 py-2 text-[11px] text-pending">
          Economics sync is {site.shopifyEconomicsSyncState.replaceAll("_", " ")}; zero revenue is not launch-ready evidence.
        </p>
      )}

      <div className="mt-6 grid grid-cols-3 gap-4 border-t border-line-soft pt-5">
        <Metric
          value={site.pendingActionCount}
          label="Awaiting approval"
          accent={hasPending}
          pulse={hasPending}
        />
        <Metric value={site.activeProductCount} label="Active products" />
        <Metric value={site.shopifyEconomicsSyncState === "current" ? site.ordersAwaitingFulfillment : "—"} label="Open orders" />
      </div>

      <div className="mt-5 flex items-center justify-between">
        {hasPending ? (
          <Link
            href="/approvals"
            className="text-[13px] font-medium text-pending transition-colors hover:text-signal"
          >
            Review {site.pendingActionCount} action{site.pendingActionCount > 1 ? "s" : ""} &rarr;
          </Link>
        ) : (
          <Link
            href={`/sites/${site.siteId}`}
            className="text-[13px] font-medium text-ink-dim transition-colors hover:text-signal"
          >
            Open brand &rarr;
          </Link>
        )}
        {site.killDate && (
          <span className="font-mono text-[10px] text-ink-faint">
            kill&nbsp;{new Date(site.killDate).toLocaleDateString()}
          </span>
        )}
      </div>
    </article>
  );
}
