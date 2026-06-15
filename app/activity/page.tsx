"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { PageContainer } from "../components/ui/PageContainer";
import { SectionHeader } from "../components/ui/SectionHeader";
import { ActivityFeed, type AuditEntry } from "../components/ui/ActivityFeed";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icons";

export default function ActivityPage() {
  const log = useQuery(api.audit.listRecent, { limit: 80 });
  const loading = log === undefined;
  const entries = (log ?? []) as AuditEntry[];

  return (
    <PageContainer>
      <section className="mb-10">
        <div className="mb-4 flex items-center gap-2">
          <span className="label-eyebrow text-cyan">Activity</span>
          <span className="h-px w-12 bg-line" />
        </div>
        <h1 className="font-display text-[2.2rem] font-medium leading-[1.05] tracking-tight text-ink sm:text-[2.85rem]">
          The fleet&apos;s
          <span className="italic text-cyan"> append-only ledger</span>
        </h1>
        <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-ink-dim">
          Every proposed, approved and executed action across all brands — plus content, distribution
          and order events — newest first. Nothing is ever deleted.
        </p>
      </section>

      {loading ? (
        <div className="panel rounded-2xl p-6">
          <div className="flex flex-col gap-3">
            {Array.from({ length: 8 }, (_, i) => <div key={i} className="shimmer h-9 rounded-lg" />)}
          </div>
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          glyph={<Icon.activity size={26} />}
          title="No activity recorded yet"
          body="As the brain sources, builds, distributes and fulfils across your brands, every event lands here. The ledger fills the moment the loop starts running."
        />
      ) : (
        <div className="panel rounded-2xl p-6 sm:p-7">
          <SectionHeader eyebrow="All brands" meta={`${entries.length} events`} />
          <ActivityFeed entries={entries} showSite />
        </div>
      )}
    </PageContainer>
  );
}
