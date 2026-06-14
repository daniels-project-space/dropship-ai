"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { TopBar } from "./components/TopBar";
import { SiteCard, type PortfolioSite } from "./components/SiteCard";
import { CreateBrandDialog } from "./components/CreateBrandDialog";
import { EmptyState } from "./components/EmptyState";
import { StatusDot } from "./components/StatusDot";

function SummaryStat({
  value,
  label,
  pulse = false,
  accent = false,
}: {
  value: number | string;
  label: string;
  pulse?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {pulse && <StatusDot className="bg-pending" hex="#f0a93b" live size={8} />}
        <span
          className={`font-display text-4xl font-medium tabular-nums leading-none tracking-tight sm:text-5xl ${
            accent ? "text-pending" : "text-ink"
          }`}
        >
          {value}
        </span>
      </div>
      <span className="label-eyebrow">{label}</span>
    </div>
  );
}

function CardSkeleton() {
  return <div className="shimmer h-[248px] rounded-2xl border border-line" />;
}

export default function PortfolioPage() {
  const data = useQuery(api.dashboard.portfolio);
  const [dialogOpen, setDialogOpen] = useState(false);

  const loading = data === undefined;
  const sites = (data?.sites ?? []) as PortfolioSite[];
  const isEmpty = !loading && sites.length === 0;
  const pendingTotal = data?.totalPendingActions ?? 0;
  const activeCount = sites.filter((s) => s.status === "active").length;

  return (
    <div className="relative z-10">
      <TopBar pendingCount={pendingTotal} />

      <main className="mx-auto max-w-[1240px] px-5 pb-24 pt-10 sm:px-8 sm:pt-14">
        {/* hero / fleet header */}
        <section className="mb-12 sm:mb-16">
          <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <div className="mb-4 flex items-center gap-2">
                <span className="label-eyebrow text-signal">Fleet overview</span>
                <span className="h-px w-12 bg-line" />
              </div>
              <h1 className="font-display text-[2.4rem] font-medium leading-[1.05] tracking-tight text-ink sm:text-[3.25rem]">
                Your autonomous
                <br />
                <span className="italic text-signal">brand portfolio</span>
              </h1>
              <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-ink-dim sm:text-base">
                Every site below runs a self-directed sourcing, content and CRO
                loop. The brain proposes — you approve what carries money or
                ban-risk. Everything else runs on its own.
              </p>
            </div>

            {!isEmpty && (
              <button
                onClick={() => setDialogOpen(true)}
                className="group inline-flex w-fit items-center gap-2 rounded-full bg-signal px-5 py-3 text-[14px] font-semibold text-void transition hover:bg-signal-deep"
              >
                <span className="text-lg leading-none">+</span> New brand
              </button>
            )}
          </div>

          {/* summary band */}
          {!isEmpty && (
            <div className="panel mt-10 grid grid-cols-2 gap-6 rounded-2xl px-6 py-7 sm:grid-cols-4 sm:gap-4 sm:px-8">
              <SummaryStat value={loading ? "—" : sites.length} label="Brand-sites" />
              <SummaryStat value={loading ? "—" : activeCount} label="Active" />
              <SummaryStat
                value={loading ? "—" : pendingTotal}
                label="Awaiting approval"
                accent={pendingTotal > 0}
                pulse={pendingTotal > 0}
              />
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <StatusDot className="bg-live" hex="#44d6a0" live size={8} />
                  <span className="font-display text-4xl font-medium leading-none tracking-tight text-live sm:text-5xl">
                    Live
                  </span>
                </div>
                <span className="label-eyebrow">Brain status</span>
              </div>
            </div>
          )}
        </section>

        {/* fleet grid */}
        {loading ? (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        ) : isEmpty ? (
          <EmptyState
            glyph={
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9l9-6 9 6v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <path d="M9 21V12h6v9" />
              </svg>
            }
            title="No brands in the fleet yet"
            body="Provision your first brand-site to put the autonomous loop to work. The brain starts sourcing products and proposing its first actions within minutes."
          >
            <button
              onClick={() => setDialogOpen(true)}
              className="inline-flex items-center gap-2 rounded-full bg-signal px-6 py-3 text-[14px] font-semibold text-void transition hover:bg-signal-deep"
            >
              <span className="text-lg leading-none">+</span> Create your first brand
            </button>
          </EmptyState>
        ) : (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
            {sites.map((site, i) => (
              <SiteCard key={site.siteId} site={site} index={i} />
            ))}
          </div>
        )}
      </main>

      <CreateBrandDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
}
