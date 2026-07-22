"use client";

import { Suspense, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { SiteCard, type PortfolioSite } from "./components/SiteCard";
import { CreateBrandDialog } from "./components/CreateBrandDialog";
import { EmptyState } from "./components/EmptyState";
import { PageContainer } from "./components/ui/PageContainer";
import { SectionHeader } from "./components/ui/SectionHeader";
import { CommandCenter } from "./components/CommandCenter";
import { Icon } from "./components/Icons";
import { useBrand } from "./components/shell/useBrand";

function CardSkeleton() {
  return <div className="shimmer h-[260px] rounded-2xl border border-line" />;
}

function PortfolioInner() {
  const data = useQuery(api.dashboard.portfolio, {});
  const [dialogOpen, setDialogOpen] = useState(false);
  const { brand, isAll } = useBrand();

  const loading = data === undefined;
  const allSites = (data?.sites ?? []) as PortfolioSite[];
  // brand scope: when a single brand is selected, everything narrows to it.
  const sites = isAll ? allSites : allSites.filter((s) => s.siteId === brand);
  const isEmpty = !loading && allSites.length === 0;
  const scope = isAll ? "all" : brand;
  const scopedName = sites[0]?.name;
  const economicsNotCurrent = sites.filter((site) => site.shopifyEconomicsSyncState !== "current");

  return (
    <PageContainer wide>
      {/* hero */}
      <section className="mb-10">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <div className="mb-4 flex items-center gap-2.5">
              <span className="label-eyebrow text-signal">{isAll ? "Mission control" : "Brand command"}</span>
              <span className="h-px w-12 bg-line" />
            </div>
            <h1 className="font-display text-[2.3rem] font-medium leading-[1.05] tracking-tight text-ink sm:text-[3rem]">
              {isAll ? (
                <>
                  Autonomous
                  <br />
                  <span className="italic text-signal">command center</span>
                </>
              ) : (
                <span className="italic text-signal">{scopedName ?? "Brand"}</span>
              )}
            </h1>
            <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-ink-dim">
              {isAll
                ? "Verified performance across every brand-site — revenue, organic reach, conversion and the content-fit gate. The brain proposes; you approve what carries money or ban-risk."
                : "Scoped performance for this brand. Switch back to the full fleet from the brand selector."}
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
        <>
          {economicsNotCurrent.length > 0 && (
            <p className="mb-5 rounded-xl border border-pending/30 bg-pending/5 px-4 py-3 text-[12px] leading-relaxed text-pending">
              {economicsNotCurrent.length} visible brand{economicsNotCurrent.length === 1 ? " has" : "s have"} no complete current economics sync. Zero revenue and order values are not launch-ready evidence.
            </p>
          )}
          {/* the structured analytics command center */}
          <CommandCenter scope={scope} />

          {/* fleet grid (only meaningful in the all-brands view) */}
          {isAll && (
            <section className="mt-14">
              <SectionHeader eyebrow="Fleet" meta={loading ? undefined : `${sites.length} ${sites.length === 1 ? "site" : "sites"}`} />
              {loading ? (
                <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
                  {[0, 1, 2].map((i) => <CardSkeleton key={i} />)}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
                  {sites.map((site, i) => (
                    <SiteCard key={site.siteId} site={site} index={i} />
                  ))}
                </div>
              )}
            </section>
          )}
        </>
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
