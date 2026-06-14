"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";

const FIELD =
  "w-full rounded-lg border border-line bg-void/60 px-3.5 py-2.5 text-[14px] text-ink placeholder:text-ink-faint outline-none transition focus:border-signal/50 focus:ring-2 focus:ring-signal/15";
const LABEL = "label-eyebrow mb-2 block text-[10px]";

export function CreateBrandDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const createSite = useMutation(api.sites.create);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [niche, setNiche] = useState("");
  const [minKitPriceUsd, setMinKitPriceUsd] = useState("45");
  const [minBlendedMarginPct, setMinBlendedMarginPct] = useState("70");
  const [distributionMode, setDistributionMode] =
    useState<"semi_manual" | "automated">("semi_manual");

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createSite({
        name: name.trim(),
        niche: niche.trim(),
        minKitPriceUsd: Number(minKitPriceUsd),
        minBlendedMarginPct: Number(minBlendedMarginPct),
        distributionMode,
      });
      onClose();
      setName("");
      setNiche("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create brand");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-void/70 backdrop-blur-sm"
      />
      <div className="panel animate-rise relative z-10 m-3 w-full max-w-lg rounded-2xl p-7 sm:m-0">
        <span className="label-eyebrow text-signal">New brand-site</span>
        <h2 className="mt-2 font-display text-2xl font-medium tracking-tight text-ink">
          Provision a brand
        </h2>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-dim">
          The brain begins sourcing, building creatives and proposing actions the
          moment a site exists. Guardrails below are enforced on every move.
        </p>

        <form onSubmit={handleSubmit} className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={LABEL}>Brand name</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Aurora Pet Co."
              className={FIELD}
            />
          </div>
          <div className="sm:col-span-2">
            <label className={LABEL}>Niche</label>
            <input
              required
              value={niche}
              onChange={(e) => setNiche(e.target.value)}
              placeholder="calming dog accessories"
              className={FIELD}
            />
          </div>
          <div>
            <label className={LABEL}>Min kit price (USD)</label>
            <input
              required
              type="number"
              min={1}
              value={minKitPriceUsd}
              onChange={(e) => setMinKitPriceUsd(e.target.value)}
              className={FIELD}
            />
          </div>
          <div>
            <label className={LABEL}>Min blended margin (%)</label>
            <input
              required
              type="number"
              min={1}
              max={100}
              value={minBlendedMarginPct}
              onChange={(e) => setMinBlendedMarginPct(e.target.value)}
              className={FIELD}
            />
          </div>
          <div className="sm:col-span-2">
            <label className={LABEL}>Distribution mode</label>
            <div className="grid grid-cols-2 gap-2">
              {(["semi_manual", "automated"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setDistributionMode(mode)}
                  className={`rounded-lg border px-3 py-2.5 text-[13px] font-medium transition ${
                    distributionMode === mode
                      ? "border-signal/50 bg-signal/10 text-signal"
                      : "border-line bg-void/40 text-ink-dim hover:text-ink"
                  }`}
                >
                  {mode === "semi_manual" ? "Semi-manual" : "Automated"}
                </button>
              ))}
            </div>
          </div>

          {error && (
            <p className="sm:col-span-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
              {error}
            </p>
          )}

          <div className="sm:col-span-2 mt-1 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2.5 text-[14px] text-ink-dim transition hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-signal px-5 py-2.5 text-[14px] font-semibold text-void transition hover:bg-signal-deep disabled:opacity-50"
            >
              {submitting ? "Provisioning…" : "Provision brand"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
