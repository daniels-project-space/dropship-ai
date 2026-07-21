"use client";

import { useState } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import { StatusDot } from "./StatusDot";
import { RISK_TIER, type RiskTier } from "./tokens";
import { sourcedDraftApprovalFacts } from "@/src/lib/sourcedDraftApprovalFacts";

export type PendingAction = {
  _id: Id<"actions">;
  siteId: Id<"sites">;
  type: string;
  params: unknown;
  riskTier: RiskTier;
  rationale: string;
  confidence?: number;
  proposedAt: number;
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

function prettyType(type: string) {
  return type.replace(/_/g, " ");
}

export function ActionCard({
  action,
  siteName,
  index = 0,
}: {
  action: PendingAction;
  siteName: string;
  index?: number;
}) {
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  const [error, setError] = useState<string | null>(null);

  const tier = RISK_TIER[action.riskTier];
  const confidencePct =
    action.confidence != null ? Math.round(action.confidence * 100) : null;
  const sourceFacts = sourcedDraftApprovalFacts(action.type, action.params);

  async function run(kind: "approve" | "reject") {
    setError(null);
    setBusy(kind);
    try {
      const response = await fetch("/api/approvals/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: action._id, approved: kind === "approve" }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "approval resolution failed");
      // Trigger resumes the persisted waitpoint and writes the state transition; sourced imports
      // remain approved until the separate draft-only executor is explicitly requested.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
      setBusy(null);
    }
  }

  return (
    <article
      className="panel animate-rise relative overflow-hidden rounded-2xl p-6 sm:p-7"
      style={{ animationDelay: `${index * 70}ms` }}
    >
      {/* left risk rail */}
      <span
        aria-hidden
        className={`absolute inset-y-0 left-0 w-1 ${tier.dot} opacity-70`}
      />

      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <span
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${tier.ring}`}
            >
              <StatusDot
                className={tier.dot}
                hex={tier.hex}
                live={action.riskTier === "human_gated"}
                size={6}
              />
              {tier.label}
            </span>
            <h3 className="font-display text-[20px] font-medium capitalize tracking-tight text-ink">
              {prettyType(action.type)}
            </h3>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[11px] text-ink-faint">
            <span className="text-ink-dim">{siteName}</span>
            <span>{timeAgo(action.proposedAt)}</span>
            {confidencePct != null && (
              <span>
                confidence{" "}
                <span className="text-ink-dim">{confidencePct}%</span>
              </span>
            )}
          </div>

          <p className="mt-4 max-w-2xl text-[14px] leading-relaxed text-ink-dim">
            {action.rationale}
          </p>

          {sourceFacts && (
            <div className="mt-4 max-w-2xl rounded-xl border border-signal/25 bg-signal/[0.04] p-3 text-[12px] text-ink-dim">
              <p className="font-medium text-ink">{sourceFacts.title} · Shopify DRAFT only — unpublished</p>
              <p className="mt-1 font-mono text-[10px] text-ink-faint">CJ product {sourceFacts.cjProductId} · exact variant {sourceFacts.cjVariantId} · evidence {timeAgo(sourceFacts.evidenceReadAt)} · US inventory {sourceFacts.inventoryQty}</p>
              <p className="mt-1 font-mono text-[10px] text-ink-faint">COGS ${sourceFacts.cogsUsd.toFixed(2)} · shipping ${sourceFacts.shippingUsd.toFixed(2)} · landed ${sourceFacts.landedCostUsd.toFixed(2)} · retail ${sourceFacts.priceUsd.toFixed(2)} · contribution {sourceFacts.contributionMarginPct.toFixed(1)}%</p>
            </div>
          )}

          {confidencePct != null && (
            <div className="mt-4 h-1 w-full max-w-xs overflow-hidden rounded-full bg-line">
              <div
                className="h-full rounded-full bg-signal/70"
                style={{ width: `${confidencePct}%` }}
              />
            </div>
          )}
        </div>

        {/* actions */}
        <div className="flex shrink-0 items-center gap-2.5 sm:flex-col sm:items-stretch sm:gap-2">
          <button
            onClick={() => run("approve")}
            disabled={busy !== null}
            className="flex-1 rounded-lg bg-live/15 px-5 py-2.5 text-[13px] font-semibold text-live ring-1 ring-live/30 transition hover:bg-live/25 disabled:opacity-50 sm:flex-none"
          >
            {busy === "approve" ? "Approving…" : "Approve"}
          </button>
          <button
            onClick={() => run("reject")}
            disabled={busy !== null}
            className="flex-1 rounded-lg bg-white/[0.03] px-5 py-2.5 text-[13px] font-semibold text-ink-dim ring-1 ring-white/10 transition hover:bg-danger/15 hover:text-danger hover:ring-danger/30 disabled:opacity-50 sm:flex-none"
          >
            {busy === "reject" ? "Rejecting…" : "Reject"}
          </button>
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {error}
        </p>
      )}
    </article>
  );
}
