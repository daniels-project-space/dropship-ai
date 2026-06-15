"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DataTable, type Column } from "../../../components/ui/DataTable";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { StatusDot } from "../../../components/StatusDot";
import { Icon } from "../../../components/Icons";
import {
  PLATFORM,
  POST_STATUS_RING,
  fmtCompact,
  type Platform,
  type PostStatus,
} from "../../../components/tokens";

type PostRow = {
  _id: Id<"posts">;
  platform: Platform;
  status: PostStatus;
  views?: number;
  engagement?: number;
  publishedAt?: number;
};

function statusLabel(s: PostStatus) {
  return s === "awaiting_manual_publish" ? "awaiting publish" : s.replace(/_/g, " ");
}

// Per-brand day-30 content-fit gate strip.
function GateStrip({ siteId }: { siteId: Id<"sites"> }) {
  const gate = useQuery(api.dashboard.contentFitGate, { siteId });
  const loading = gate === undefined;
  const passed = gate?.passed ?? false;
  const best = gate?.bestVideo ?? null;

  return (
    <div className={`panel relative overflow-hidden rounded-2xl p-6 ${passed ? "ring-1 ring-live/30" : ""}`}>
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-20 h-52 w-52 rounded-full blur-3xl"
        style={{ background: passed ? "rgba(68,214,160,0.14)" : "rgba(240,169,59,0.10)" }}
      />
      <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-md">
          <div className="mb-2 flex items-center gap-2">
            <span className="label-eyebrow text-pending">Day-30 viability gate</span>
            <span className="h-px w-10 bg-line" />
          </div>
          <div className="flex items-center gap-2.5">
            <StatusDot className={passed ? "bg-live" : "bg-pending"} hex={passed ? "#44d6a0" : "#f0a93b"} live={passed} size={9} />
            <h3 className="font-display text-2xl font-medium tracking-tight text-ink">
              {loading ? "—" : passed ? "Content fit" : "Not yet proven"}
            </h3>
          </div>
          <p className="mt-2 text-[13px] text-ink-dim">
            Has any post cleared <span className="font-mono text-ink">{fmtCompact(gate?.threshold ?? 10000)}</span> views
            in the trailing 30 days?
          </p>
        </div>
        <div className="flex shrink-0 gap-3">
          <div className="panel-inset flex min-w-[110px] flex-col justify-center rounded-xl px-4 py-3">
            <span className="font-display text-3xl font-medium tabular-nums text-ink">
              {loading ? "—" : gate?.totalPublishedInWindow ?? 0}
            </span>
            <span className="label-eyebrow mt-1.5 text-[9px]">Published · 30d</span>
          </div>
          <div className="panel-inset flex min-w-[110px] flex-col justify-center rounded-xl px-4 py-3">
            <span className={`font-display text-3xl font-medium tabular-nums ${passed ? "text-live" : "text-ink"}`}>
              {loading ? "—" : best ? fmtCompact(best.views) : "0"}
            </span>
            <span className="label-eyebrow mt-1.5 text-[9px]">Best video</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function DistributionTab({ siteId }: { siteId: Id<"sites"> }) {
  const posts = useQuery(api.posts.listBySite, { siteId, limit: 100 });
  const loading = posts === undefined;
  const rows = (posts ?? []) as PostRow[];

  const columns: Column<PostRow>[] = [
    {
      key: "platform",
      header: "Platform",
      render: (r) => {
        const p = PLATFORM[r.platform];
        return (
          <span className="flex items-center gap-2">
            <StatusDot className={p.dot} hex={p.hex} size={6} />
            <span className={`font-medium ${p.text}`}>{p.label}</span>
          </span>
        );
      },
    },
    {
      key: "views",
      header: "Views",
      align: "right",
      sortable: true,
      sortValue: (r) => r.views ?? 0,
      render: (r) => <span className="font-mono tabular-nums text-ink">{fmtCompact(r.views ?? 0)}</span>,
    },
    {
      key: "engage",
      header: "Engage",
      align: "right",
      hideBelow: "sm",
      sortable: true,
      sortValue: (r) => r.engagement ?? 0,
      render: (r) => <span className="font-mono tabular-nums text-ink-dim">{fmtCompact(r.engagement ?? 0)}</span>,
    },
    {
      key: "status",
      header: "Status",
      align: "right",
      render: (r) => (
        <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium capitalize ${POST_STATUS_RING[r.status]}`}>
          {statusLabel(r.status)}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-7">
      <GateStrip siteId={siteId} />
      <div>
        <SectionHeader eyebrow="Post ledger" meta={loading ? undefined : `${rows.length} posts`} />
        <DataTable
          columns={columns}
          rows={rows}
          loading={loading}
          rowKey={(r) => r._id}
          initialSort={{ key: "views", dir: "desc" }}
          empty={{
            glyph: <Icon.distribution size={26} />,
            title: "Nothing distributed yet",
            body: "Approve a creative in the Content tab to push it down the pipeline. Each platform gets a row here — semi-manual at cold-start, automated once Ayrshare is connected — and views feed the gate above.",
          }}
        />
      </div>
    </div>
  );
}
