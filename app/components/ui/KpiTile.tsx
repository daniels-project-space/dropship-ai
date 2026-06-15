"use client";

import type { ReactNode } from "react";
import { CountUp } from "../charts/CountUp";
import { Sparkline } from "./Sparkline";
import { MetricDelta } from "./MetricDelta";

// Hero KPI tile — the headline metric unit of the Command Center, built to read
// like an instrument readout: mono eyebrow, big Fraunces tabular value (count-up),
// a delta-vs-prior chip, a hairline-separated footer with the hint + a clean
// area sparkline. Sits in a 4–5 wide strip on its own glass panel.
export function KpiTile({
  label,
  value,
  numericValue,
  format,
  prefix = "",
  suffix = "",
  accent,
  dotHex,
  pulse = false,
  delta,
  deltaSuffix = "%",
  deltaLabel,
  spark,
  sparkColor = "#e8b04b",
  hint,
  loading = false,
}: {
  label: string;
  /** static display value (used when not numeric, e.g. "Fit"/"Pending") */
  value?: ReactNode;
  /** numeric value → drives the count-up animation */
  numericValue?: number;
  format?: (n: number) => string;
  prefix?: string;
  suffix?: string;
  accent?: string;
  dotHex?: string;
  pulse?: boolean;
  delta?: number | null;
  deltaSuffix?: string;
  /** small caption beside the delta chip, e.g. "vs prior 30d" */
  deltaLabel?: string;
  spark?: number[];
  sparkColor?: string;
  hint?: ReactNode;
  loading?: boolean;
}) {
  const accentHex = dotHex ?? sparkColor;
  return (
    <div className="panel group relative overflow-hidden rounded-2xl px-5 py-[1.15rem] transition-colors hover:border-line/80">
      {/* faint top accent hairline — instrument-panel edge */}
      <span
        className="pointer-events-none absolute inset-x-0 top-0 h-px opacity-60"
        style={{ background: `linear-gradient(90deg, transparent, ${accentHex}55, transparent)` }}
      />
      {/* faint corner glow on hover */}
      <span
        className="pointer-events-none absolute -right-8 -top-10 h-24 w-24 rounded-full opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-100"
        style={{ background: accentHex }}
      />

      <div className="flex items-center justify-between gap-2">
        <span className="label-eyebrow">{label}</span>
        {dotHex && (
          <span className="relative inline-flex h-2 w-2 shrink-0" style={{ color: dotHex }}>
            <span className="h-2 w-2 rounded-full" style={{ background: dotHex }} />
            {pulse && <span className="pulse-ring absolute inset-0" />}
          </span>
        )}
      </div>

      <div className="mt-3.5 flex items-end gap-2.5">
        <span className={`font-display text-[2.15rem] font-medium tabular-nums leading-none tracking-tight sm:text-[2.55rem] ${accent ?? "text-ink"}`}>
          {loading ? (
            <span className="text-ink-faint/60">—</span>
          ) : numericValue != null ? (
            <>
              {prefix}
              <CountUp value={numericValue} format={format ?? ((n) => Math.round(n).toLocaleString("en-US"))} />
              {suffix}
            </>
          ) : (
            value
          )}
        </span>
        {delta !== undefined && !loading && (
          <span className="mb-1 inline-flex flex-col items-start leading-none">
            <MetricDelta value={delta} suffix={deltaSuffix} />
            {deltaLabel && <span className="mt-1 caption text-ink-faint/70">{deltaLabel}</span>}
          </span>
        )}
      </div>

      {/* footer: hairline + hint / sparkline readout row */}
      <div className="mt-3.5 border-t border-line-soft/60 pt-3">
        <div className="flex items-end justify-between gap-3">
          {hint ? (
            <span className="text-[11.5px] leading-tight text-ink-dim/80">{hint}</span>
          ) : (
            <span />
          )}
          {spark && spark.length > 1 && (
            <Sparkline data={spark} color={sparkColor} width={80} height={28} animate glow />
          )}
        </div>
      </div>
    </div>
  );
}
