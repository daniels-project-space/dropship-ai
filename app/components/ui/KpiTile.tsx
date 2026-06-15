"use client";

import type { ReactNode } from "react";
import { CountUp } from "../charts/CountUp";
import { Sparkline } from "./Sparkline";
import { MetricDelta } from "./MetricDelta";

// Hero KPI tile — the headline metric unit of the Command Center. Big count-up
// value, mono eyebrow, optional status dot, delta-vs-prior chip and an animated
// inline sparkline. Designed to sit in a 4–5 wide strip on its own glass panel.
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
  spark?: number[];
  sparkColor?: string;
  hint?: ReactNode;
  loading?: boolean;
}) {
  return (
    <div className="panel group relative overflow-hidden rounded-2xl px-5 py-5 transition-colors hover:border-line/80">
      {/* faint corner glow on hover */}
      <span
        className="pointer-events-none absolute -right-8 -top-10 h-24 w-24 rounded-full opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-100"
        style={{ background: dotHex ?? sparkColor }}
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

      <div className="mt-3 flex items-end gap-2">
        <span className={`font-display text-[2.1rem] font-medium tabular-nums leading-none tracking-tight sm:text-[2.5rem] ${accent ?? "text-ink"}`}>
          {loading ? (
            "—"
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
        {delta !== undefined && !loading && <MetricDelta value={delta} suffix={deltaSuffix} className="mb-1" />}
      </div>

      <div className="mt-2.5 flex items-end justify-between gap-3">
        {hint ? <span className="text-[11.5px] leading-tight text-ink-faint">{hint}</span> : <span />}
        {spark && spark.length > 1 && <Sparkline data={spark} color={sparkColor} width={76} height={26} animate glow />}
      </div>
    </div>
  );
}
