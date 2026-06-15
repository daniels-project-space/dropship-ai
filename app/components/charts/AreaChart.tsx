"use client";

// Bespoke area chart — the Command Center's primary readout. Layered gradient
// fill under a smooth curve, whisper-quiet value/date gridlines, a glowing
// end-point marker with a live value label, min/max micro-annotations, hover
// crosshair + tooltip and a faint baseline. Reads like a financial terminal's
// hero chart. Responsive via a fixed viewBox scaled by the SVG; all text lives
// in HTML overlays (the SVG uses preserveAspectRatio="none", which would
// distort glyphs) positioned by percentage — the same pattern as the tooltip.

import { useMemo, useRef, useState } from "react";
import { useDrawIn, useInView, smoothPath, useChartId, type Pt } from "./hooks";

export type AreaPoint = { label: string; value: number };

export function AreaChart({
  data,
  height = 260,
  color = "#e8b04b",
  format = (n: number) => n.toLocaleString("en-US"),
  valuePrefix = "",
  emptyHint = "No data in this window yet.",
  yTicks = 4,
}: {
  data: AreaPoint[];
  height?: number;
  color?: string;
  format?: (n: number) => string;
  valuePrefix?: string;
  emptyHint?: string;
  yTicks?: number;
}) {
  const { ref, inView } = useInView<HTMLDivElement>();
  const progress = useDrawIn(inView, 1000);
  const gid = useChartId("area");
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // fixed internal coordinate space; SVG scales it to the container width.
  // a little left gutter holds the y-axis value ticks.
  const W = 720;
  const H = height;
  const padL = 4;
  const padR = 10;
  const padT = 18;
  const padB = 24;

  const geom = useMemo(() => {
    if (!data || data.length < 2) return null;
    const vals = data.map((d) => d.value);
    const max = Math.max(...vals, 1);
    const min = Math.min(...vals, 0);
    const span = max - min || 1;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const stepX = innerW / (data.length - 1);
    const pts: Pt[] = data.map((d, i) => {
      const x = padL + i * stepX;
      const y = padT + (1 - (d.value - min) / span) * innerH;
      return [x, y] as const;
    });
    const line = smoothPath(pts, 0.5);
    const baseY = H - padB;
    const area = `${line} L${pts[pts.length - 1][0]},${baseY} L${pts[0][0]},${baseY} Z`;
    // y ticks (value gridlines), top-of-range first
    const ticks = Array.from({ length: yTicks + 1 }, (_, i) => {
      const t = i / yTicks;
      const v = min + span * (1 - t);
      const y = padT + t * innerH;
      return { v, y };
    });
    // peak / trough indices for micro-annotations
    let hiIdx = 0;
    let loIdx = 0;
    vals.forEach((v, i) => {
      if (v > vals[hiIdx]) hiIdx = i;
      if (v < vals[loIdx]) loIdx = i;
    });
    return { pts, line, area, max, min, span, stepX, innerH, baseY, ticks, hiIdx, loIdx };
  }, [data, H, yTicks]);

  if (!geom) {
    return (
      <div
        ref={ref}
        className="flex items-center justify-center rounded-xl border border-dashed border-line text-[12px] text-ink-faint"
        style={{ height }}
      >
        {emptyHint}
      </div>
    );
  }

  const { pts, line, area, ticks, hiIdx, loIdx } = geom;
  const last = pts[pts.length - 1];
  const lastVal = data[data.length - 1].value;
  const hi = hover != null ? data[hover] : null;
  const hp = hover != null ? pts[hover] : null;

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    const idx = Math.round(xRatio * (data.length - 1));
    setHover(Math.max(0, Math.min(data.length - 1, idx)));
  }

  // helpers to convert internal coords → overlay percentages
  const xPct = (x: number) => (x / W) * 100;
  const yPx = (y: number) => (y / H) * height;

  const dashTotal = 2600;
  const midIdx = Math.floor(data.length / 2);
  const qIdx = Math.floor(data.length / 4);
  const q3Idx = Math.floor((data.length * 3) / 4);
  const xTickIdx = Array.from(new Set([0, qIdx, midIdx, q3Idx, data.length - 1])).filter(
    (i) => i >= 0 && i < data.length,
  );

  return (
    <div ref={ref}>
      <div
        ref={wrapRef}
        className="relative"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="Revenue area chart"
      >
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={height} preserveAspectRatio="none" className="block">
          <defs>
            {/* layered fill: a stronger amber wash near the curve fading to nothing */}
            <linearGradient id={`${gid}-fill`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.34" />
              <stop offset="32%" stopColor={color} stopOpacity="0.16" />
              <stop offset="68%" stopColor={color} stopOpacity="0.05" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
            <linearGradient id={`${gid}-stroke`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={color} stopOpacity="0.5" />
              <stop offset="55%" stopColor={color} stopOpacity="0.85" />
              <stop offset="100%" stopColor={color} stopOpacity="1" />
            </linearGradient>
          </defs>

          {/* value gridlines — whisper-quiet hairlines; baseline a touch stronger */}
          {ticks.map((t, i) => (
            <line
              key={i}
              x1={padL}
              x2={W - padR}
              y1={t.y}
              y2={t.y}
              stroke="#1e2530"
              strokeWidth="1"
              strokeOpacity={i === ticks.length - 1 ? 0.85 : 0.32}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {/* area fill — fades up with progress */}
          <path d={area} fill={`url(#${gid}-fill)`} opacity={progress} />

          {/* stroke — draws left→right */}
          <path
            d={line}
            fill="none"
            stroke={`url(#${gid}-stroke)`}
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            style={{ strokeDasharray: dashTotal, strokeDashoffset: dashTotal * (1 - progress) }}
          />

          {/* drop-line from the end point to the baseline */}
          <line
            x1={last[0]}
            x2={last[0]}
            y1={last[1]}
            y2={geom.baseY}
            stroke={color}
            strokeOpacity={0.28 * progress}
            strokeWidth="1"
            strokeDasharray="2 3"
            vectorEffect="non-scaling-stroke"
          />

          {/* glowing end-point marker */}
          <circle cx={last[0]} cy={last[1]} r="9" fill={color} opacity={0.14 * progress} vectorEffect="non-scaling-stroke" />
          <circle
            cx={last[0]}
            cy={last[1]}
            r="3.5"
            fill={color}
            opacity={progress}
            vectorEffect="non-scaling-stroke"
            style={{ filter: `drop-shadow(0 0 5px ${color})` }}
          />

          {/* hover crosshair */}
          {hp && (
            <g vectorEffect="non-scaling-stroke">
              <line
                x1={hp[0]}
                x2={hp[0]}
                y1={padT}
                y2={geom.baseY}
                stroke={color}
                strokeOpacity="0.45"
                strokeWidth="1"
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
              <circle cx={hp[0]} cy={hp[1]} r="4.5" fill="#0b0e13" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
            </g>
          )}
        </svg>

        {/* y-axis value ticks — HTML overlay, kept crisp (SVG is non-uniformly scaled) */}
        <div className="pointer-events-none absolute inset-0" style={{ opacity: progress }}>
          {ticks.map((t, i) => (
            <span
              key={i}
              className="caption absolute -translate-y-1/2 pl-1 text-ink-faint/80"
              style={{ top: yPx(t.y), left: 0 }}
            >
              {valuePrefix}
              {format(t.v)}
            </span>
          ))}
        </div>

        {/* peak / trough micro-annotations */}
        {hover == null && (
          <div className="pointer-events-none absolute inset-0" style={{ opacity: progress }}>
            {hiIdx !== loIdx && (
              <span
                className="caption absolute -translate-x-1/2 whitespace-nowrap rounded-full bg-base/70 px-1.5 py-px text-live ring-1 ring-live/20"
                style={{ left: `${xPct(pts[hiIdx][0])}%`, top: Math.max(0, yPx(pts[hiIdx][1]) - 20) }}
              >
                ▲ {valuePrefix}
                {format(data[hiIdx].value)}
              </span>
            )}
          </div>
        )}

        {/* live end-point value label */}
        {hover == null && (
          <div
            className="pointer-events-none absolute z-10 -translate-y-1/2"
            style={{ left: `${xPct(last[0])}%`, top: yPx(last[1]), opacity: progress }}
          >
            <span
              className="num absolute right-2 top-0 -translate-y-1/2 whitespace-nowrap rounded-md border px-2 py-1 text-[11px] text-ink shadow-[0_8px_24px_-12px_rgba(0,0,0,0.9)] backdrop-blur-sm"
              style={{ borderColor: `${color}40`, background: "rgba(11,14,19,0.85)" }}
            >
              {valuePrefix}
              {format(lastVal)}
            </span>
          </div>
        )}

        {/* tooltip (HTML overlay, positioned via percentage) */}
        {hi && hp && (
          <div
            className="pointer-events-none absolute z-20 -translate-x-1/2 rounded-lg border border-line bg-panel/95 px-3 py-2 shadow-[0_12px_30px_-12px_rgba(0,0,0,0.9)] backdrop-blur-sm"
            style={{ left: `${Math.min(92, Math.max(8, xPct(hp[0])))}%`, top: 0 }}
          >
            <div className="caption uppercase tracking-wider text-ink-faint">{hi.label}</div>
            <div className="mt-0.5 font-display text-[15px] tabular-nums text-ink">
              {valuePrefix}
              {format(hi.value)}
            </div>
          </div>
        )}
      </div>

      {/* x-axis date ticks — evenly sampled, mono */}
      <div className="relative mt-2 h-3.5">
        {xTickIdx.map((i) => (
          <span
            key={i}
            className="caption absolute -translate-x-1/2 text-ink-faint"
            style={{
              left: `${Math.min(96, Math.max(4, xPct(pts[i][0])))}%`,
            }}
          >
            {data[i].label}
          </span>
        ))}
      </div>
    </div>
  );
}
