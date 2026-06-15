"use client";

import { Suspense, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PageContainer } from "../components/ui/PageContainer";
import { SectionHeader } from "../components/ui/SectionHeader";
import { ActivityFeed, type AuditEntry } from "../components/ui/ActivityFeed";
import { Drawer } from "../components/ui/Drawer";
import { Badge } from "../components/ui/Badge";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icons";
import { useBrand } from "../components/shell/useBrand";
import { timeAgo } from "../components/tokens";

const PAGE = 60;

type FeedEntry = AuditEntry & { siteId?: string };

function prettyEvent(e: string) {
  return e.replace(/_/g, " ");
}

function EventSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none rounded-lg border border-line bg-panel-2 px-3.5 py-2 pr-8 text-[12px] text-ink outline-none transition focus:border-signal/50"
      >
        <option value="">All events</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {prettyEvent(o)}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-ink-faint">▾</span>
    </div>
  );
}

function DetailDrawer({ entry, onClose }: { entry: FeedEntry | null; onClose: () => void }) {
  if (!entry) return null;
  let detailStr = "";
  try {
    detailStr =
      entry.detail && typeof entry.detail === "object"
        ? JSON.stringify(entry.detail, null, 2)
        : String(entry.detail ?? "");
  } catch {
    detailStr = "";
  }
  const hasDetail = detailStr && detailStr !== "{}" && detailStr !== "null";
  return (
    <Drawer open={!!entry} onClose={onClose} eyebrow="Audit event" title={<span className="capitalize">{prettyEvent(entry.event)}</span>}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2">
          {entry.siteName && <Badge>{entry.siteName}</Badge>}
          <Badge>{timeAgo(entry.at)}</Badge>
        </div>
        <div className="overflow-hidden rounded-xl border border-line-soft bg-panel">
          <div className="border-b border-line-soft px-4 py-2.5">
            <span className="label-eyebrow text-[9px]">Recorded</span>
            <p className="mt-1 font-mono text-[12px] text-ink-dim">{new Date(entry.at).toUTCString()}</p>
          </div>
          <div className="px-4 py-3">
            <span className="label-eyebrow text-[9px]">Detail payload</span>
            {hasDetail ? (
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink">
                {detailStr}
              </pre>
            ) : (
              <p className="mt-2 font-mono text-[12px] text-ink-faint">No structured payload.</p>
            )}
          </div>
        </div>
        <p className="text-[12px] leading-relaxed text-ink-faint">
          This entry is append-only — it can never be edited or deleted. It is the source of truth for
          what the brain and operators did, and when.
        </p>
      </div>
    </Drawer>
  );
}

function ActivityInner() {
  const { brand, isAll } = useBrand();
  const siteId = isAll ? undefined : (brand as Id<"sites">);
  const [event, setEvent] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [active, setActive] = useState<FeedEntry | null>(null);

  const result = useQuery(api.audit.listAll, {
    limit,
    ...(siteId ? { siteId } : {}),
    ...(event ? { event } : {}),
  });

  const loading = result === undefined;
  const entries = (result?.entries ?? []) as FeedEntry[];
  const hasMore = result?.hasMore ?? false;
  // eventTypes is unfiltered by the current event selection (so the dropdown stays complete)
  const eventTypes = useMemo(() => result?.eventTypes ?? [], [result]);

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
          Every proposed, approved and executed action across {isAll ? "all brands" : "this brand"} —
          plus content, distribution and order events — newest first. Nothing is ever deleted. Click any
          row to inspect its payload.
        </p>
      </section>

      <div className="panel rounded-2xl p-6 sm:p-7">
        <SectionHeader
          eyebrow={isAll ? "All brands" : "Scoped"}
          accent="text-cyan"
          meta={loading ? undefined : `${entries.length}${hasMore ? "+" : ""} events`}
        >
          <EventSelect value={event} options={eventTypes} onChange={(v) => { setEvent(v); setLimit(PAGE); }} />
        </SectionHeader>

        {loading ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 8 }, (_, i) => <div key={i} className="shimmer h-9 rounded-lg" />)}
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            glyph={<Icon.activity size={26} />}
            title={event ? "No events of that type" : "No activity recorded yet"}
            body={
              event
                ? "Nothing matches this event filter yet. Clear the filter to see the full ledger."
                : "As the brain sources, builds, distributes and fulfils across your brands, every event lands here. The ledger fills the moment the loop starts running."
            }
          />
        ) : (
          <>
            <ActivityFeed entries={entries} showSite={isAll} onSelect={(e) => setActive(e as FeedEntry)} />
            {hasMore && (
              <div className="mt-5 flex justify-center border-t border-line-soft pt-5">
                <button
                  onClick={() => setLimit((l) => l + PAGE)}
                  className="inline-flex items-center gap-2 rounded-full border border-line bg-panel/60 px-5 py-2 text-[12px] font-medium text-ink-dim transition hover:border-cyan/40 hover:text-ink"
                >
                  Load more
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <DetailDrawer entry={active} onClose={() => setActive(null)} />
    </PageContainer>
  );
}

export default function ActivityPage() {
  return (
    <Suspense fallback={<PageContainer><div className="shimmer h-64 rounded-2xl" /></PageContainer>}>
      <ActivityInner />
    </Suspense>
  );
}
