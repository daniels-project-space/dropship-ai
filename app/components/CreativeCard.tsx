"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AssetPreview } from "./AssetPreview";

export type ReviewCreative = {
  _id: Id<"creatives">;
  siteId: Id<"sites">;
  siteName?: string;
  kind: "product_demo" | "ai_spokesperson" | "ai_broll" | "customer_ugc";
  r2Key: string;
  aiGenerated: boolean;
  aiLabelRequired: boolean;
  labelBurned?: boolean;
  hook?: string;
  status: "generating" | "review" | "approved" | "rejected";
  revision?: number;
  publicationAuthorized?: boolean;
  createdAt: number;
};

const KIND_LABEL: Record<ReviewCreative["kind"], string> = {
  product_demo: "Product demo",
  ai_spokesperson: "AI spokesperson",
  ai_broll: "AI b-roll",
  customer_ugc: "Customer UGC",
};

function timeAgo(ms: number) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function CreativeCard({
  creative,
  index = 0,
  onScheduled,
}: {
  creative: ReviewCreative;
  index?: number;
  onScheduled?: (id: string) => void;
}) {
  const approve = useMutation(api.creatives.approve);
  const reject = useMutation(api.creatives.reject);
  const [busy, setBusy] = useState<null | "approve" | "reject" | "authorize">(null);
  const [error, setError] = useState<string | null>(null);
  const [caption, setCaption] = useState(creative.hook ?? "");
  const [targets, setTargets] = useState<Record<string, string>>({});
  const disclosureVerified = !creative.aiLabelRequired || creative.labelBurned === true;

  async function run(kind: "approve" | "reject") {
    setError(null);
    setBusy(kind);
    try {
      if (kind === "approve") {
        await approve({ creativeId: creative._id, approver: "Daniel" });
      } else {
        await reject({ creativeId: creative._id, approver: "Daniel" });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
      setBusy(null);
    }
  }

  async function authorize() {
    setError(null);
    setBusy("authorize");
    try {
      const destinations = Object.entries(targets)
        .filter(([, targetAccount]) => targetAccount.trim())
        .map(([platform, targetAccount]) => ({ platform, targetAccount: targetAccount.trim() }));
      const response = await fetch("/api/schedule", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creativeId: creative._id, expectedRevision: creative.revision ?? 1, caption, destinations }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok && !result.deferred) throw new Error(result.error ?? "publication authorization failed");
      onScheduled?.(creative._id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authorization failed");
      setBusy(null);
    }
  }

  return (
    <article
      className="panel animate-rise group relative flex flex-col overflow-hidden rounded-2xl transition-transform duration-300 hover:-translate-y-1"
      style={{ animationDelay: `${index * 70}ms` }}
    >
      {/* 9:16 preview */}
      <div className="relative aspect-[9/16] w-full overflow-hidden">
        <AssetPreview r2Key={creative.r2Key} className="h-full w-full" />

        {/* MANDATORY AI-disclosure badge — mirrors the burned-in label, always visible */}
        {creative.aiLabelRequired && (
          <span className="absolute right-3 top-3 z-10 flex items-center gap-1.5 rounded-full bg-black/65 px-2.5 py-1 font-mono text-[10px] font-medium uppercase tracking-wider text-ink ring-1 ring-white/15 backdrop-blur">
            <span className="h-1.5 w-1.5 rounded-full bg-cyan" />
            AI-generated
          </span>
        )}

        {/* gradient scrim for legibility of the meta row */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-void/90 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 px-4 pb-3">
          <span className="rounded-md bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-dim ring-1 ring-white/10 backdrop-blur">
            {KIND_LABEL[creative.kind]}
          </span>
          {creative.siteName && (
            <span className="truncate font-mono text-[10px] text-ink-faint">{creative.siteName}</span>
          )}
        </div>
      </div>

      {/* body */}
      <div className="flex flex-1 flex-col gap-4 p-5">
        <div>
          <p className="line-clamp-2 font-display text-[15px] leading-snug text-ink">
            {creative.hook ?? "Untitled hook"}
          </p>
          <p className="mt-1.5 font-mono text-[10px] text-ink-faint">{timeAgo(creative.createdAt)}</p>
        </div>

        {creative.status === "approved" && creative.publicationAuthorized && (
          <p className="mt-auto rounded-lg border border-live/30 bg-live/10 px-3 py-2 text-[12px] text-live">Publication authorized and durably queued.</p>
        )}

        {creative.status === "approved" && !creative.publicationAuthorized && (
          <div className="mt-auto space-y-2.5">
            <p className="text-[11px] leading-relaxed text-ink-dim">Content approved. Publication still requires this separate exact authorization.</p>
            <textarea value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="Exact publication caption" className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-[12px] text-ink" />
            {(["tiktok", "instagram", "youtube", "facebook"] as const).map((platform) => (
              <input key={platform} value={targets[platform] ?? ""} onChange={(event) => setTargets((current) => ({ ...current, [platform]: event.target.value }))}
                placeholder={`${platform} exact account id / username`} className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-[11px] text-ink" />
            ))}
            <button onClick={authorize} disabled={busy !== null || !caption.trim() || !Object.values(targets).some((value) => value.trim())}
              className="w-full rounded-lg bg-pending/15 px-4 py-2.5 text-[13px] font-semibold text-pending ring-1 ring-pending/30 disabled:opacity-50">
              {busy === "authorize" ? "Authorizing…" : "Authorize exact publication"}
            </button>
          </div>
        )}

        {creative.status === "review" && <div className="mt-auto flex items-center gap-2.5">
          <button
            onClick={() => run("approve")}
            disabled={busy !== null || !disclosureVerified}
            className="flex-1 rounded-lg bg-live/15 px-4 py-2.5 text-[13px] font-semibold text-live ring-1 ring-live/30 transition hover:bg-live/25 disabled:opacity-50"
          >
            {busy === "approve" ? "Scheduling…" : "Approve"}
          </button>
          <button
            onClick={() => run("reject")}
            disabled={busy !== null}
            className="flex-1 rounded-lg bg-white/[0.03] px-4 py-2.5 text-[13px] font-semibold text-ink-dim ring-1 ring-white/10 transition hover:bg-danger/15 hover:text-danger hover:ring-danger/30 disabled:opacity-50"
          >
            {busy === "reject" ? "Rejecting…" : "Reject"}
          </button>
        </div>}

        {!disclosureVerified && (
          <p className="rounded-lg border border-pending/30 bg-pending/10 px-3 py-2 text-[12px] leading-relaxed text-pending">
            Approval blocked: this legacy AI asset has no verified burned-in disclosure. Reassemble it before review.
          </p>
        )}

        {error && (
          <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {error}
          </p>
        )}
      </div>
    </article>
  );
}
