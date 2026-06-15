"use client";

// Bespoke radial gauge — a 270° arc showing progress toward a target, with an
// animated sweep (draw-in) and a count-up centre value. Used for the content-fit
// milestone (best video views → 10k gate).

import { useCountUp, useDrawIn, useInView, useChartId } from "./hooks";

export function RadialGauge({
  value,
  target,
  label,
  unit = "",
  size = 168,
  color = "#e8b04b",
  trackColor = "#1e2530",
  centerFormat,
  caption,
}: {
  value: number;
  target: number;
  label: string;
  unit?: string;
  size?: number;
  color?: string;
  trackColor?: string;
  centerFormat?: (n: number) => string;
  caption?: string;
}) {
  const { ref, inView } = useInView<HTMLDivElement>();
  const progress = useDrawIn(inView, 1100);
  const pct = Math.max(0, Math.min(1, target > 0 ? value / target : 0));
  const animated = useCountUp(value, 1200, inView);
  const gid = useChartId("gauge");

  const stroke = 12;
  const r = (size - stroke) / 2 - 4;
  const cx = size / 2;
  const cy = size / 2;
  const startAngle = 135; // degrees — bottom-left
  const sweep = 270; // total arc
  const circumference = (sweep / 360) * 2 * Math.PI * r;

  const fmt = centerFormat ?? ((n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : Math.round(n).toString()));
  const reached = pct >= 1;

  // arc path from startAngle for `sweep` degrees
  function pointAt(angle: number) {
    const a = (angle * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }
  const [sx, sy] = pointAt(startAngle);
  const [ex, ey] = pointAt(startAngle + sweep);
  const trackPath = `M${sx},${sy} A${r},${r} 0 1 1 ${ex},${ey}`;

  return (
    <div ref={ref} className="flex flex-col items-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="block">
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.7" />
              <stop offset="100%" stopColor={color} />
            </linearGradient>
          </defs>
          <path d={trackPath} fill="none" stroke={trackColor} strokeWidth={stroke} strokeLinecap="round" />
          <path
            d={trackPath}
            fill="none"
            stroke={`url(#${gid})`}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - pct * progress)}
            style={{ filter: `drop-shadow(0 0 6px ${color}70)` }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-display text-[1.9rem] font-medium tabular-nums leading-none text-ink">
            {fmt(animated)}
            {unit && <span className="ml-0.5 text-[0.9rem] text-ink-dim">{unit}</span>}
          </span>
          <span className="mt-1.5 font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-faint">
            {reached ? "target met" : `of ${fmt(target)}${unit}`}
          </span>
        </div>
      </div>
      <span className={`mt-2 label-eyebrow ${reached ? "text-live" : ""}`}>{label}</span>
      {caption && <span className="mt-1 max-w-[200px] text-center text-[11px] text-ink-faint">{caption}</span>}
    </div>
  );
}
