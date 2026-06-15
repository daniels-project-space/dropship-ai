"use client";

// Bespoke area chart — smooth gradient-filled series with an animated draw-in
// reveal, hover crosshair + value tooltip, and baseline grid. Responsive via a
// viewBox + ResizeObserver-free percentage layout (fixed internal coordinate
// space, scaled by the SVG). Themed through the control-plane token palette.

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

  // fixed internal coordinate space; SVG scales it to the container width
  const W = 720;
  const H = height;
  const padL = 8;
  const padR = 8;
  const padT = 16;
  const padB = 26;

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
    const area = `${line} L${pts[pts.length - 1][0]},${H - padB} L${pts[0][0]},${H - padB} Z`;
    const ticks = Array.from({ length: yTicks + 1 }, (_, i) => {
      const v = min + (span * i) / yTicks;
      const y = padT + (1 - (v - min) / span) * innerH;
      return { v, y };
    });
    return { pts, line, area, max, min, stepX, innerH };
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

  const { pts, line, area, max, min } = geom;
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

  // total path length approximation for the draw-in stroke dash
  const dashTotal = 2600;

  return (
    <div ref={ref}>
      <div
        ref={wrapRef}
        className="relative"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="Area chart"
      >
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={height} preserveAspectRatio="none" className="block">
          <defs>
            <linearGradient id={`${gid}-fill`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.28" />
              <stop offset="55%" stopColor={color} stopOpacity="0.08" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
            <linearGradient id={`${gid}-stroke`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={color} stopOpacity="0.55" />
              <stop offset="100%" stopColor={color} stopOpacity="1" />
            </linearGradient>
          </defs>

          {/* baseline grid — faint horizontal hairlines */}
          {Array.from({ length: yTicks + 1 }, (_, i) => {
            const y = padT + ((H - padT - padB) * i) / yTicks;
            return (
              <line
                key={i}
                x1={padL}
                x2={W - padR}
                y1={y}
                y2={y}
                stroke="#1e2530"
                strokeWidth="1"
                strokeOpacity={i === yTicks ? 0.9 : 0.4}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}

          {/* area fill — fades up with progress */}
          <path d={area} fill={`url(#${gid}-fill)`} opacity={progress} />

          {/* stroke — draws left→right */}
          <path
            d={line}
            fill="none"
            stroke={`url(#${gid}-stroke)`}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            style={{
              strokeDasharray: dashTotal,
              strokeDashoffset: dashTotal * (1 - progress),
            }}
          />

          {/* latest point marker */}
          <circle
            cx={pts[pts.length - 1][0]}
            cy={pts[pts.length - 1][1]}
            r="3"
            fill={color}
            opacity={progress}
            vectorEffect="non-scaling-stroke"
          />

          {/* hover crosshair */}
          {hp && (
            <g vectorEffect="non-scaling-stroke">
              <line
                x1={hp[0]}
                x2={hp[0]}
                y1={padT}
                y2={H - padB}
                stroke={color}
                strokeOpacity="0.4"
                strokeWidth="1"
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
              <circle cx={hp[0]} cy={hp[1]} r="4.5" fill="#0b0e13" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
            </g>
          )}
        </svg>

        {/* tooltip (HTML overlay, positioned via percentage) */}
        {hi && hp && (
          <div
            className="pointer-events-none absolute -translate-x-1/2 rounded-lg border border-line bg-panel/95 px-3 py-2 shadow-[0_12px_30px_-12px_rgba(0,0,0,0.9)] backdrop-blur-sm"
            style={{ left: `${(hp[0] / W) * 100}%`, top: 0 }}
          >
            <div className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">{hi.label}</div>
            <div className="mt-0.5 font-display text-[15px] tabular-nums text-ink">
              {valuePrefix}
              {format(hi.value)}
            </div>
          </div>
        )}
      </div>

      {/* x-axis labels — first / mid / last, mono */}
      <div className="mt-2 flex justify-between font-mono text-[10px] text-ink-faint">
        <span>{data[0].label}</span>
        {data.length > 2 && <span>{data[Math.floor(data.length / 2)].label}</span>}
        <span>{data[data.length - 1].label}</span>
      </div>
    </div>
  );
}
