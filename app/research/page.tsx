"use client";

import { Suspense } from "react";
import { PageContainer } from "../components/ui/PageContainer";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icons";
import { useBrand } from "../components/shell/useBrand";

function ResearchInner() {
  const { isAll } = useBrand();
  return (
    <PageContainer>
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
          Rolled-up daily signals from Google Trends, Meta Ad Library, TikTok Creative Center and SERP.
          Per-brand research lives on each brand&apos;s Research tab — open a brand to drill in.
        </p>
      </section>
      <EmptyState
        glyph={<Icon.research size={26} />}
        title={isAll ? "Pick a brand to see its research" : "Per-brand research lives on the brand page"}
        body="Cross-brand research aggregation arrives in a later pass. For now, open a brand from the rail's switcher (or the portfolio) and use its Research tab to read trend signals against the rubric."
      >
        <a href="/" className="inline-flex items-center gap-2 rounded-full border border-line bg-panel/60 px-5 py-2.5 text-[13px] font-medium text-ink-dim transition hover:border-signal/40 hover:text-ink">
          Go to portfolio &rarr;
        </a>
      </EmptyState>
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
