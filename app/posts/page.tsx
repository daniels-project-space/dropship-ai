"use client";

import { Suspense, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { EmptyState } from "../components/EmptyState";
import { StatusDot } from "../components/StatusDot";
import { PageContainer } from "../components/ui/PageContainer";
import { Drawer } from "../components/ui/Drawer";
import { Badge } from "../components/ui/Badge";
import { useBrand } from "../components/shell/useBrand";
import { timeAgo } from "../components/tokens";

type BoardPost = {
  _id: Id<"posts">;
  siteId: Id<"sites">;
  siteName: string;
  platform: "tiktok" | "instagram" | "youtube" | "facebook";
  status: "draft" | "scheduled" | "awaiting_manual_publish" | "published" | "failed";
  views?: number;
  engagement?: number;
  scheduledFor?: number;
  publishedAt?: number;
  creativeKind?: string | null;
  aiGenerated?: boolean;
  _creationTime?: number;
};

type GateData = {
  threshold: number;
  trailingDays: number;
  passed: boolean;
  totalPublishedInWindow: number;
  bestVideo: {
    siteName: string;
    platform: string;
    views: number;
    engagement: number;
    r2Key: string | null;
  } | null;
};

const PLATFORM: Record<BoardPost["platform"], { label: string; text: string; dot: string; hex: string }> = {
  tiktok: { label: "TikTok", text: "text-cyan", dot: "bg-cyan", hex: "#5cc6e8" },
  instagram: { label: "Instagram", text: "text-violet", dot: "bg-violet", hex: "#9b8cff" },
  youtube: { label: "YouTube", text: "text-danger", dot: "bg-danger", hex: "#ef6b6b" },
  facebook: { label: "Facebook", text: "text-signal", dot: "bg-signal", hex: "#e8b04b" },
};

const STATUS_RING: Record<BoardPost["status"], string> = {
  published: "bg-live/10 text-live ring-1 ring-live/25",
  scheduled: "bg-cyan/10 text-cyan ring-1 ring-cyan/25",
  awaiting_manual_publish: "bg-pending/10 text-pending ring-1 ring-pending/30",
  draft: "bg-white/5 text-ink-dim ring-1 ring-white/10",
  failed: "bg-danger/10 text-danger ring-1 ring-danger/25",
};

function statusLabel(s: BoardPost["status"]) {
  return s === "awaiting_manual_publish" ? "awaiting publish" : s;
}

function fmtViews(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ── the day-30 content-fit gate readout ──────────────────────────────────────
function ContentFitGate({ gate }: { gate: GateData | undefined }) {
  const loading = gate === undefined;
  const passed = gate?.passed ?? false;
  const best = gate?.bestVideo ?? null;

  return (
    <div
      className={`panel relative overflow-hidden rounded-2xl p-6 sm:p-8 ${
        passed ? "ring-1 ring-live/30" : ""
      }`}
    >
      {/* aurora wash keyed to pass/fail */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full blur-3xl"
        style={{ background: passed ? "rgba(68,214,160,0.14)" : "rgba(240,169,59,0.10)" }}
      />
      <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-md">
          <div className="mb-3 flex items-center gap-2">
            <span className="label-eyebrow text-pending">Day-30 viability gate</span>
            <span className="h-px w-10 bg-line" />
          </div>
          <div className="flex items-center gap-3">
            <StatusDot
              className={passed ? "bg-live" : "bg-pending"}
              hex={passed ? "#44d6a0" : "#f0a93b"}
              live={passed}
              size={10}
            />
            <h2 className="font-display text-3xl font-medium tracking-tight text-ink sm:text-[2.4rem]">
              {loading ? "—" : passed ? "Content fit" : "Not yet proven"}
            </h2>
          </div>
          <p className="mt-3 text-[14px] leading-relaxed text-ink-dim">
            Has any post cleared{" "}
            <span className="font-mono text-ink">{fmtViews(gate?.threshold ?? 10000)}</span> views in
            the trailing 30 days? This is the go/kill signal for the niche.
          </p>
        </div>

        {/* best video proof */}
        <div className="flex shrink-0 items-stretch gap-4">
          <div className="flex min-w-[120px] flex-col justify-center rounded-xl border border-line bg-panel-2/60 px-5 py-4">
            <span className="font-display text-4xl font-medium tabular-nums leading-none text-ink">
              {loading ? "—" : gate?.totalPublishedInWindow ?? 0}
            </span>
            <span className="label-eyebrow mt-2 text-[9.5px]">Published · 30d</span>
          </div>
          <div className="flex min-w-[150px] flex-col justify-center rounded-xl border border-line bg-panel-2/60 px-5 py-4">
            <span
              className={`font-display text-4xl font-medium tabular-nums leading-none ${
                passed ? "text-live" : "text-ink"
              }`}
            >
              {loading ? "—" : best ? fmtViews(best.views) : "0"}
            </span>
            <span className="label-eyebrow mt-2 text-[9.5px]">
              {best ? `Best · ${best.siteName}` : "Best video"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function statusRing(s: BoardPost["status"]) {
  return STATUS_RING[s];
}

function PostDrawer({ post, onClose }: { post: BoardPost | null; onClose: () => void }) {
  if (!post) return null;
  const p = PLATFORM[post.platform];
  return (
    <Drawer open={!!post} onClose={onClose} eyebrow={`${p.label} post`} title={post.siteName}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge dot={p.dot} hex={p.hex}>{p.label}</Badge>
          <span className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-[11px] font-medium capitalize ${statusRing(post.status)}`}>
            {statusLabel(post.status)}
          </span>
          {post.aiGenerated && (
            <Badge ring="bg-cyan/10 text-cyan ring-1 ring-cyan/25" dot="bg-cyan" hex="#5cc6e8">AI-labeled</Badge>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line-soft bg-line-soft">
          {[
            ["Views", fmtViews(post.views ?? 0)],
            ["Engagement", fmtViews(post.engagement ?? 0)],
            ["Creative", (post.creativeKind ?? "creative").replace(/_/g, " ")],
            ["Platform", p.label],
            ["Scheduled", post.scheduledFor ? new Date(post.scheduledFor).toLocaleString() : "—"],
            ["Published", post.publishedAt ? timeAgo(post.publishedAt) : "—"],
          ].map(([k, val]) => (
            <div key={k} className="bg-panel px-4 py-3">
              <dt className="label-eyebrow text-[9px]">{k}</dt>
              <dd className="mt-1 truncate font-mono text-[13px] tabular-nums text-ink">{val}</dd>
            </div>
          ))}
        </dl>
        <p className="text-[12px] leading-relaxed text-ink-faint">
          Views on published posts feed the day-30 viability gate. Cold-start posts publish semi-manual
          until Ayrshare is linked; after that the brain schedules automatically.
        </p>
      </div>
    </Drawer>
  );
}

function PostRow({ post, index, onClick }: { post: BoardPost; index: number; onClick: () => void }) {
  const p = PLATFORM[post.platform];
  return (
    <div
      onClick={onClick}
      className="panel animate-rise flex cursor-pointer items-center gap-4 rounded-xl px-5 py-4 transition-colors hover:bg-white/[0.025]"
      style={{ animationDelay: `${index * 45}ms` }}
    >
      <div className="flex w-32 shrink-0 items-center gap-2">
        <StatusDot className={p.dot} hex={p.hex} size={7} />
        <span className={`text-[13px] font-medium ${p.text}`}>{p.label}</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-ink">{post.siteName}</p>
        <p className="truncate font-mono text-[10px] text-ink-faint">
          {(post.creativeKind ?? "creative").replace(/_/g, " ")}
          {post.aiGenerated ? " · AI-labeled" : ""}
        </p>
      </div>
      <div className="hidden w-28 shrink-0 text-right sm:block">
        <p className="font-mono text-[13px] tabular-nums text-ink">{fmtViews(post.views ?? 0)}</p>
        <p className="label-eyebrow text-[9px]">views</p>
      </div>
      <div className="hidden w-24 shrink-0 text-right md:block">
        <p className="font-mono text-[13px] tabular-nums text-ink-dim">{fmtViews(post.engagement ?? 0)}</p>
        <p className="label-eyebrow text-[9px]">engage</p>
      </div>
      <span
        className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium capitalize ${STATUS_RING[post.status]}`}
      >
        {statusLabel(post.status)}
      </span>
    </div>
  );
}

function DistributionBoardInner() {
  const { brand, isAll } = useBrand();
  const board = useQuery(api.posts.listForBoard, {});
  const gate = useQuery(api.dashboard.contentFitGate, isAll ? {} : { siteId: brand as Id<"sites"> });
  const [active, setActive] = useState<BoardPost | null>(null);

  const loading = board === undefined;
  const allPosts = (board ?? []) as BoardPost[];
  const posts = isAll ? allPosts : allPosts.filter((p) => p.siteId === (brand as string));
  const isEmpty = !loading && posts.length === 0;

  return (
    <PageContainer>
      <section className="mb-10">
          <div className="mb-4 flex items-center gap-2">
            <span className="label-eyebrow text-signal">Distribution</span>
            <span className="h-px w-12 bg-line" />
          </div>
          <h1 className="font-display text-[2.2rem] font-medium leading-[1.05] tracking-tight text-ink sm:text-[2.85rem]">
            Where the work
            <span className="italic text-signal"> lands</span>
          </h1>
          <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-ink-dim">
            Organic-first publishing across TikTok, Instagram and YouTube. Cold-start runs
            semi-manual until Ayrshare is live. The gate below is the only metric that decides whether
            this niche earns more content.
          </p>
        </section>

        <ContentFitGate gate={gate as GateData | undefined} />

        <section className="mt-12">
          <div className="mb-5 flex items-center gap-2">
            <span className="label-eyebrow">{isAll ? "Post ledger" : "Post ledger · scoped"}</span>
            <span className="h-px flex-1 bg-line-soft" />
            {!loading && <span className="font-mono text-[11px] text-ink-faint">{posts.length} posts</span>}
          </div>

          {loading ? (
            <div className="flex flex-col gap-3">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="shimmer h-[68px] rounded-xl border border-line" />
              ))}
            </div>
          ) : isEmpty ? (
            <EmptyState
              glyph={
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12h4l3 8 4-16 3 8h4" />
                </svg>
              }
              title="No posts published yet"
              body="Approve a creative in the Studio to push it down this pipeline. Each platform gets a row here — semi-manual at cold-start, automated once Ayrshare is connected — and views feed the day-30 gate above."
            />
          ) : (
            <div className="flex flex-col gap-3">
              {posts.map((post, i) => (
                <PostRow key={post._id} post={post} index={i} onClick={() => setActive(post)} />
              ))}
            </div>
          )}
        </section>

        <PostDrawer post={active} onClose={() => setActive(null)} />
    </PageContainer>
  );
}

export default function DistributionBoardPage() {
  return (
    <Suspense fallback={<PageContainer><div className="shimmer h-64 rounded-2xl" /></PageContainer>}>
      <DistributionBoardInner />
    </Suspense>
  );
}
