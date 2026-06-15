import type { ReactNode } from "react";
import { Sparkline } from "./Sparkline";
import { MetricDelta } from "./MetricDelta";

// A KPI tile: big display value + mono eyebrow, with optional pulse dot, delta
// chip and an inline sparkline. The atomic unit of every KPI band.
export function StatTile({
  value,
  label,
  accent,
  dotHex,
  pulse = false,
  delta,
  spark,
  sparkColor = "#e8b04b",
  hint,
  className = "",
}: {
  value: ReactNode;
  label: string;
  accent?: string; // tailwind text-* for the value
  dotHex?: string; // show a leading StatusDot in this hex
  pulse?: boolean;
  delta?: number | null;
  spark?: number[];
  sparkColor?: string;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div className="flex items-center gap-2">
        {dotHex && (
          <span className="relative inline-flex h-2 w-2 shrink-0" style={{ color: dotHex }}>
            <span className="h-2 w-2 rounded-full" style={{ background: dotHex }} />
            {pulse && <span className="pulse-ring absolute inset-0" />}
          </span>
        )}
        <span
          className={`font-display text-[2rem] font-medium tabular-nums leading-none tracking-tight sm:text-[2.6rem] ${
            accent ?? "text-ink"
          }`}
        >
          {value}
        </span>
        {delta !== undefined && <MetricDelta value={delta} className="mb-0.5" />}
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="label-eyebrow">{label}</span>
        {spark && spark.length > 1 && (
          <Sparkline data={spark} color={sparkColor} width={72} height={22} />
        )}
      </div>
      {hint && <div className="text-[12px] text-ink-faint">{hint}</div>}
    </div>
  );
}

// StatTile wrapped in its own glass panel — used for free-standing KPI grids.
export function StatTileCard(props: Parameters<typeof StatTile>[0]) {
  return (
    <div className="panel rounded-2xl px-5 py-5">
      <StatTile {...props} />
    </div>
  );
}
