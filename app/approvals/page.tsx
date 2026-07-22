"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { ActionCard, type PendingAction } from "../components/ActionCard";
import { EmptyState } from "../components/EmptyState";
import { PageContainer } from "../components/ui/PageContainer";

function RowSkeleton() {
  return <div className="shimmer h-[180px] rounded-2xl border border-line" />;
}

export default function ApprovalsPage() {
  const pending = useQuery(api.actions.listPending, {});
  const portfolio = useQuery(api.dashboard.portfolio, {});

  const loading = pending === undefined;
  const actions = (pending ?? []) as PendingAction[];
  const isEmpty = !loading && actions.length === 0;

  // siteId → display name (falls back to a short id if portfolio not yet loaded)
  const siteNames = new Map<string, string>();
  for (const s of portfolio?.sites ?? []) siteNames.set(s.siteId, s.name);

  const gated = actions.filter((a) => a.riskTier === "human_gated").length;

  return (
    <PageContainer>
      <section className="mb-10 sm:mb-12">
          <div className="mb-4 flex items-center gap-2">
            <span className="label-eyebrow text-pending">Approval queue</span>
            <span className="h-px w-12 bg-line" />
          </div>
          <h1 className="font-display text-[2.2rem] font-medium leading-[1.05] tracking-tight text-ink sm:text-[2.85rem]">
            Actions awaiting
            <span className="italic text-pending"> your call</span>
          </h1>
          <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-ink-dim">
            The brain pauses on any move that spends money or carries platform
            ban-risk. Each card waits on a Trigger waitpoint until you approve or
            reject — every decision is written to the audit ledger.
          </p>

          {!isEmpty && !loading && (
            <div className="mt-7 flex flex-wrap items-center gap-x-8 gap-y-3">
              <span className="font-mono text-[13px] text-ink-dim">
                <span className="font-display text-2xl text-ink">{actions.length}</span>{" "}
                queued
              </span>
              <span className="font-mono text-[13px] text-ink-dim">
                <span className="font-display text-2xl text-pending">{gated}</span>{" "}
                human-gated
              </span>
            </div>
          )}
        </section>

        {loading ? (
          <div className="flex flex-col gap-5">
            <RowSkeleton />
            <RowSkeleton />
          </div>
        ) : isEmpty ? (
          <EmptyState
            glyph={
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            }
            title="No actions awaiting approval"
            body="The queue is clear. When the brain proposes a money- or ban-risk move, it will surface here for your decision. Autonomous low-risk actions run without stopping."
          />
        ) : (
          <div className="flex flex-col gap-5">
            {actions.map((action, i) => (
              <ActionCard
                key={action._id}
                action={action}
                siteName={siteNames.get(action.siteId) ?? "Unassigned site"}
                index={i}
              />
            ))}
          </div>
        )}
    </PageContainer>
  );
}
