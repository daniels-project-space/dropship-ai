"use client";

import { Suspense, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { SiteCard, type PortfolioSite } from "./components/SiteCard";
import { CreateBrandDialog } from "./components/CreateBrandDialog";
import { EmptyState } from "./components/EmptyState";
import { PageContainer } from "./components/ui/PageContainer";
import { StatTile } from "./components/ui/StatTile";
import { SectionHeader } from "./components/ui/SectionHeader";
import { ActivityFeed, type AuditEntry } from "./components/ui/ActivityFeed";
import { Icon } from "./components/Icons";
import { useBrand } from "./components/shell/useBrand";

function CardSkeleton() {
  return <div className="shimmer h-[260px] rounded-2xl border border-line" />;
}

function PortfolioInner() {
  const data = useQuery(api.dashboard.portfolio);
  const gate = useQuery(api.dashboard.contentFitGate, {});
  const recent = useQuery(api.audit.listRecent, { limit: 16 });
  const [dialogOpen, setDialogOpen] = useState(false);
  const { brand, isAll } = useBrand();

  const loading = data === undefined;
  const allSites = (data?.sites ?? []) as PortfolioSite[];
  // brand scope: when a single brand is selected, the grid narrows to it.
  const sites = isAll ? allSites : allSites.filter((s) => s.siteId === brand);
  const isEmpty = !loading && allSites.length === 0;

  const pendingTotal = data?.totalPendingActions ?? 0;
  const activeCount = allSites.filter((s) => s.status === "active").length;
  const gatePassed = gate?.passed ?? false;
  const entries = (recent ?? []) as AuditEntry[];

  return (
    <PageContainer wide>
      {/* hero */}
      <section className="mb-10">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <div className="mb-4 flex items-center gap-2">
              <span className="label-eyebrow text-signal">Mission control</span>
              <span className="h-px w-12 bg-line" />
            </div>
            <h1 className="font-display text-[2.3rem] font-medium leading-[1.05] tracking-tight text-ink sm:text-[3rem]">
              Your autonomous
              <br />
              <span className="italic text-signal">brand portfolio</span>
            </h1>
            <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-ink-dim">
              Every site runs a self-directed sourcing, content and CRO loop. The brain proposes — you
              approve what carries money or ban-risk. Everything else runs on its own.
            </p>
          </div>
          {!isEmpty && (
            <button
              onClick={() => setDialogOpen(true)}
              className="inline-flex w-fit items-center gap-2 rounded-full bg-signal px-5 py-3 text-[14px] font-semibold text-void transition hover:bg-signal-deep"
            >
              <span className="text-lg leading-none">+</span> New brand
            </button>
          )}
        </div>

        {/* global KPI band */}
        {!isEmpty && (
          <div className="panel mt-9 grid grid-cols-2 gap-6 rounded-2xl px-6 py-7 sm:grid-cols-4 sm:gap-4 sm:px-8">
            <StatTile value={loading ? "—" : allSites.length} label="Brand-sites" />
            <StatTile
              value={loading ? "—" : activeCount}
              label="Active"
              dotHex="#44d6a0"
              pulse={activeCount > 0}
              accent="text-live"
            />
            <StatTile
              value={loading ? "—" : pendingTotal}
              label="Awaiting approval"
              accent={pendingTotal > 0 ? "text-pending" : undefined}
              dotHex={pendingTotal > 0 ? "#f0a93b" : undefined}
              pulse={pendingTotal > 0}
            />
            <StatTile
              value={loading ? "—" : gatePassed ? "Fit" : "Pending"}
              label="Content-fit gate"
              accent={gatePassed ? "text-live" : "text-ink"}
              dotHex={gatePassed ? "#44d6a0" : "#f0a93b"}
              pulse={gatePassed}
            />
          </div>
        )}
      </section>

      {isEmpty ? (
        <EmptyState
          glyph={<Icon.portfolio size={26} />}
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
        <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1fr)_340px]">
          {/* fleet grid */}
          <div>
            <SectionHeader
              eyebrow={isAll ? "Fleet" : "Scoped brand"}
              meta={loading ? undefined : `${sites.length} ${sites.length === 1 ? "site" : "sites"}`}
            />
            {loading ? (
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                {[0, 1].map((i) => (
                  <CardSkeleton key={i} />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                {sites.map((site, i) => (
                  <SiteCard key={site.siteId} site={site} index={i} />
                ))}
              </div>
            )}
          </div>

          {/* recent activity rail */}
          <aside className="xl:sticky xl:top-20 xl:self-start">
            <div className="panel rounded-2xl p-5 sm:p-6">
              <SectionHeader eyebrow="Recent activity" accent="text-cyan" />
              {recent === undefined ? (
                <div className="flex flex-col gap-3">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="shimmer h-9 rounded-lg" />
                  ))}
                </div>
              ) : entries.length === 0 ? (
                <p className="py-6 text-center text-[13px] text-ink-faint">
                  No activity yet. Events land here as the brain works.
                </p>
              ) : (
                <ActivityFeed entries={entries} showSite dense />
              )}
            </div>
          </aside>
        </div>
      )}

      <CreateBrandDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </PageContainer>
  );
}

export default function PortfolioPage() {
  // useBrand reads useSearchParams → needs a Suspense boundary (Next 16).
  return (
    <Suspense fallback={<PageContainer wide><div className="shimmer h-64 rounded-2xl" /></PageContainer>}>
      <PortfolioInner />
    </Suspense>
  );
}
