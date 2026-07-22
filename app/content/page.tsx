"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { creativeGenerationInputDigest, normalizeCreativeGenerationInput } from "@/src/lib/creativeGeneration";
import { CreativeCard, type ReviewCreative } from "../components/CreativeCard";
import { EmptyState } from "../components/EmptyState";
import { StatusDot } from "../components/StatusDot";
import { PageContainer } from "../components/ui/PageContainer";

function CardSkeleton() {
  return <div className="shimmer aspect-[9/16] rounded-2xl border border-line" />;
}

function GenerateBar({
  sites,
}: {
  sites: { siteId: string; name: string }[];
}) {
  const [siteId, setSiteId] = useState("");
  const [state, setState] = useState<null | "running" | "done" | "error">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const pendingRequestId = useRef<string | null>(null);

  async function generate() {
    if (!siteId) return;
    setState("running");
    setMsg(null);
    try {
      const normalized = normalizeCreativeGenerationInput({ siteId, variants: 3 });
      const requestId = pendingRequestId.current ?? crypto.randomUUID();
      pendingRequestId.current = requestId;
      const r = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...normalized, requestId, inputDigest: creativeGenerationInputDigest(normalized) }),
      });
      const d = await r.json();
      if (r.ok) {
        pendingRequestId.current = null;
        setState("done");
        setMsg(`Batch ${String(d.intentId).slice(0, 12)} ${d.state === "deferred" ? "saved · handoff deferred" : "queued"}`);
      } else {
        setState("error");
        setMsg(d.error ?? "Generation could not be queued");
      }
    } catch {
      setState("error");
      setMsg("Network error queuing batch");
    }
  }

  return (
    <div className="panel mt-10 flex flex-col gap-4 rounded-2xl px-6 py-6 sm:flex-row sm:items-end sm:justify-between sm:px-8">
      <div className="max-w-md">
        <span className="label-eyebrow text-signal">Content factory</span>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-dim">
          Generate 3 <span className="text-ink">product-first</span> variants — mat ASMR, freeze-mold
          pour, hands-only demo — each assembled 9:16 with a burned-in AI-disclosure label, queued for
          your review.
        </p>
      </div>
      <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative">
          <select
            value={siteId}
            onChange={(e) => { setSiteId(e.target.value); pendingRequestId.current = null; setState(null); setMsg(null); }}
            className="w-full appearance-none rounded-lg border border-line bg-panel-2 px-4 py-2.5 pr-9 text-[13px] text-ink outline-none transition focus:border-signal/50 sm:w-52"
          >
            <option value="">Select brand…</option>
            {sites.map((s) => (
              <option key={s.siteId} value={s.siteId}>
                {s.name}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint">▾</span>
        </div>
        <button
          onClick={generate}
          disabled={!siteId || state === "running"}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-signal px-5 py-2.5 text-[13px] font-semibold text-void transition hover:bg-signal-deep disabled:cursor-not-allowed disabled:opacity-40"
        >
          {state === "running" ? "Queuing…" : "Generate batch"}
        </button>
      </div>
      {msg && (
        <p
          className={`w-full font-mono text-[11px] sm:order-last ${
            state === "error" ? "text-danger" : "text-live"
          }`}
        >
          {msg}
        </p>
      )}
    </div>
  );
}

type GenerationProjection = {
  intentId: Id<"creativeGenerationIntents">;
  requested: number; active: number; ready: number; failed: number; needsAttention: number;
  status: string; handoffStatus: string; updatedAt: number;
  variants: Array<{ variantId: Id<"creativeGenerationVariants">; index: number; stage: string; retryEligible: boolean; lastErrorCode?: string }>;
};

function GenerationStatus({ rows }: { rows: GenerationProjection[] }) {
  const retry = useMutation(api.creativeGenerations.retryFailedVariant);
  const [retrying, setRetrying] = useState<string | null>(null);
  if (!rows.length) return null;
  return (
    <div className="mb-10 space-y-3">
      <span className="label-eyebrow text-ink-faint">Durable generation state</span>
      {rows.map((row) => (
        <div key={row.intentId} className="panel rounded-xl px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
            <span className="font-mono text-ink">{String(row.intentId).slice(0, 12)} · {row.status.replace(/_/g, " ")}</span>
            <span className="font-mono text-ink-dim">requested {row.requested} · active {row.active} · ready {row.ready} · failed {row.failed} · attention {row.needsAttention}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {row.variants.map((variant) => (
              <span key={variant.variantId} className="rounded-md border border-line px-2.5 py-1 font-mono text-[10px] text-ink-dim">
                v{variant.index + 1} · {variant.stage.replace(/_/g, " ")}
                {variant.retryEligible && (
                  <button
                    type="button"
                    disabled={retrying === variant.variantId}
                    onClick={async () => { setRetrying(variant.variantId); try { await retry({ variantId: variant.variantId }); } finally { setRetrying(null); } }}
                    className="ml-2 text-signal hover:text-signal-deep disabled:opacity-50"
                  >retry proven pre-submit failure</button>
                )}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function CreativeStudioPage() {
  const reviews = useQuery(api.creatives.listForReview, {});
  const publicationAuthorizations = useQuery(api.creatives.listForPublicationAuthorization, {});
  const portfolio = useQuery(api.dashboard.portfolio, {});
  const generations = useQuery(api.creativeGenerations.listOperatorProjection, { limit: 10 });

  const loading = reviews === undefined || publicationAuthorizations === undefined;
  const creatives = ([...(reviews ?? []), ...(publicationAuthorizations ?? [])]) as ReviewCreative[];
  const isEmpty = !loading && creatives.length === 0;
  const sites = (portfolio?.sites ?? []).map((s) => ({ siteId: s.siteId, name: s.name }));
  const aiCount = creatives.filter((c) => c.aiLabelRequired).length;

  return (
    <PageContainer wide>
      <section className="mb-10 sm:mb-12">
          <div className="mb-4 flex items-center gap-2">
            <span className="label-eyebrow text-signal">Creative studio</span>
            <span className="h-px w-12 bg-line" />
          </div>
          <h1 className="font-display text-[2.4rem] font-medium leading-[1.05] tracking-tight text-ink sm:text-[3.25rem]">
            Product-first creatives,
            <br />
            <span className="italic text-signal">awaiting your eye</span>
          </h1>
          <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-ink-dim">
            The factory builds hero assets around the product itself — never uncanny AI dogs. Every
            AI-touched frame carries a mandatory disclosure label, enforced in code. Approve
            the content first; publication remains blocked until a separate exact caption, platform,
            and target-account authorization.
          </p>

          {!isEmpty && !loading && (
            <div className="mt-7 flex flex-wrap items-center gap-x-8 gap-y-3 font-mono text-[13px] text-ink-dim">
              <span>
                <span className="font-display text-2xl text-ink">{creatives.length}</span> awaiting a decision
              </span>
              <span className="flex items-center gap-2">
                <StatusDot className="bg-cyan" hex="#5cc6e8" size={7} />
                <span className="font-display text-2xl text-cyan">{aiCount}</span> AI-labeled
              </span>
            </div>
          )}

          <GenerateBar sites={sites} />
        </section>

        <GenerationStatus rows={(generations ?? []) as GenerationProjection[]} />

        {loading ? (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        ) : isEmpty ? (
          <EmptyState
            glyph={
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="16" rx="3" />
                <path d="m10 9 5 3-5 3z" />
              </svg>
            }
            title="No creatives in review"
            body="Pick a brand and generate a batch above. The factory produces three product-first variants, each assembled vertical with a burned-in AI-disclosure label, and drops them here for your call."
          />
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {creatives.map((c, i) => (
              <CreativeCard key={c._id} creative={c} index={i} />
            ))}
          </div>
        )}
    </PageContainer>
  );
}
