"use client";

// Bespoke radial gauge — a 270° arc showing progress toward a target, with tick
// marks around the dial, an animated sweep (draw-in) and a count-up centre value.
// When the target is met the arc + centre gain a subtle live glow. Used for the
// content-fit milestone (best video views → 10k gate).

import { useCountUp, useDrawIn, useInView, useChartId } from "./hooks";

export function RadialGauge({
  value,
  target,
  label,
  unit = "",
  size = 176,
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
  const r = (size - stroke) / 2 - 6;
  const cx = size / 2;
  const cy = size / 2;
  const startAngle = 135; // degrees — bottom-left
  const sweep = 270; // total arc
  const circumference = (sweep / 360) * 2 * Math.PI * r;

  const fmt = centerFormat ?? ((n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : Math.round(n).toString()));
  const reached = pct >= 1;

  function pointAt(angle: number, radius: number) {
    const a = (angle * Math.PI) / 180;
    return [cx + radius * Math.cos(a), cy + radius * Math.sin(a)];
  }
  const [sx, sy] = pointAt(startAngle, r);
  const [ex, ey] = pointAt(startAngle + sweep, r);
  const trackPath = `M${sx},${sy} A${r},${r} 0 1 1 ${ex},${ey}`;

  // tick marks around the dial (every ~10% of the sweep)
  const TICKS = 9;
  const ticks = Array.from({ length: TICKS + 1 }, (_, i) => {
    const t = i / TICKS;
    const angle = startAngle + sweep * t;
    const rOuter = r + stroke / 2 + 3;
    const rInner = r + stroke / 2 - (i % (TICKS / 3) === 0 ? 6 : 3); // longer ticks at thirds
    const [x1, y1] = pointAt(angle, rInner);
    const [x2, y2] = pointAt(angle, rOuter);
    const lit = t <= pct;
    return { x1, y1, x2, y2, lit, major: i % (TICKS / 3) === 0 };
  });

  return (
    <div ref={ref} className="flex flex-col items-center">
      <div className="relative" style={{ width: size, height: size }}>
        {/* cleared glow halo */}
        {reached && (
          <span
            className="pointer-events-none absolute inset-4 rounded-full blur-2xl"
            style={{ background: `radial-gradient(circle, ${color}33, transparent 70%)`, opacity: progress }}
          />
        )}
        <svg width={size} height={size} className="relative block">
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.7" />
              <stop offset="100%" stopColor={color} />
            </linearGradient>
          </defs>

          {/* tick marks */}
          {ticks.map((t, i) => (
            <line
              key={i}
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
              stroke={t.lit ? color : trackColor}
              strokeOpacity={t.lit ? 0.7 * progress + 0.3 : 0.6}
              strokeWidth={t.major ? 1.5 : 1}
              strokeLinecap="round"
            />
          ))}

          <path d={trackPath} fill="none" stroke={trackColor} strokeWidth={stroke} strokeLinecap="round" />
          <path
            d={trackPath}
            fill="none"
            stroke={`url(#${gid})`}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - pct * progress)}
            style={{ filter: `drop-shadow(0 0 ${reached ? 9 : 6}px ${color}${reached ? "90" : "70"})` }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={`font-display text-[2rem] font-medium tabular-nums leading-none ${reached ? "text-live" : "text-ink"}`}>
            {fmt(animated)}
            {unit && <span className="ml-0.5 text-[0.9rem] text-ink-dim">{unit}</span>}
          </span>
          <span className="mt-1.5 caption uppercase tracking-[0.18em] text-ink-faint">
            {reached ? "target met" : `of ${fmt(target)}${unit}`}
          </span>
        </div>
      </div>
      <span className={`mt-3 label-eyebrow ${reached ? "text-live" : ""}`}>{label}</span>
      {caption && <span className="mt-1.5 max-w-[210px] text-center text-[11px] leading-relaxed text-ink-dim/80">{caption}</span>}
    </div>
  );
}
