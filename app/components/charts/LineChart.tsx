"use client";

// Bespoke multi-series line chart. Smooth strokes over whisper-quiet value
// gridlines, a faint per-series area tint for legibility, synchronized
// left→right draw-in, end-point dots, a shared hover crosshair with a multi-row
// tooltip, an inline legend and y-axis value ticks. Each series carries its own
// themed colour. Text lives in HTML overlays (the SVG is non-uniformly scaled).

import { useMemo, useRef, useState } from "react";
import { useDrawIn, useInView, smoothPath, useChartId, type Pt } from "./hooks";

export type Series = { name: string; color: string; data: number[]; format?: (n: number) => string };

export function LineChart({
  series,
  labels,
  height = 200,
  emptyHint = "No data yet.",
  yTicks = 3,
}: {
  series: Series[];
  labels: string[];
  height?: number;
  emptyHint?: string;
  yTicks?: number;
}) {
  const { ref, inView } = useInView<HTMLDivElement>();
  const progress = useDrawIn(inView, 950);
  const gid = useChartId("line");
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const W = 640;
  const H = height;
  const padL = 4;
  const padR = 10;
  const padT = 12;
  const padB = 22;

  const geom = useMemo(() => {
    const n = labels.length;
    if (n < 2 || series.length === 0) return null;
    const all = series.flatMap((s) => s.data);
    const max = Math.max(...all, 1);
    const min = Math.min(...all, 0);
    const span = max - min || 1;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const baseY = H - padB;
    const stepX = innerW / (n - 1);
    const lines = series.map((s) => {
      const pts: Pt[] = s.data.map((v, i) => {
        const x = padL + i * stepX;
        const y = padT + (1 - (v - min) / span) * innerH;
        return [x, y] as const;
      });
      const path = smoothPath(pts, 0.5);
      const area = `${path} L${pts[pts.length - 1][0]},${baseY} L${pts[0][0]},${baseY} Z`;
      return { ...s, pts, path, area };
    });
    const ticks = Array.from({ length: yTicks + 1 }, (_, i) => {
      const t = i / yTicks;
      const v = min + span * (1 - t);
      const y = padT + t * innerH;
      return { v, y };
    });
    return { lines, stepX, max, min, baseY, ticks };
  }, [series, labels, H, yTicks]);

  if (!geom) {
    return (
      <div ref={ref} className="flex items-center justify-center rounded-xl border border-dashed border-line text-[12px] text-ink-faint" style={{ height }}>
        {emptyHint}
      </div>
    );
  }

  const { lines, ticks } = geom;
  const dash = 2200;
  const fmtTick = series[0]?.format ?? ((n: number) => n.toLocaleString("en-US"));

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    const idx = Math.round(xRatio * (labels.length - 1));
    setHover(Math.max(0, Math.min(labels.length - 1, idx)));
  }

  const hoverX = hover != null ? lines[0]?.pts[hover]?.[0] ?? null : null;
  const yPx = (y: number) => (y / H) * height;

  return (
    <div ref={ref}>
      {/* legend */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {series.map((s) => (
          <span key={s.name} className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
            <span className="h-1.5 w-3.5 rounded-full" style={{ background: s.color, boxShadow: `0 0 6px -1px ${s.color}` }} />
            {s.name}
          </span>
        ))}
      </div>

      <div ref={wrapRef} className="relative" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="Line chart">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={height} preserveAspectRatio="none" className="block">
          <defs>
            {lines.map((l) => (
              <linearGradient key={l.name} id={`${gid}-${l.name}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={l.color} stopOpacity="0.16" />
                <stop offset="100%" stopColor={l.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>

          {ticks.map((t, i) => (
            <line
              key={i}
              x1={padL}
              x2={W - padR}
              y1={t.y}
              y2={t.y}
              stroke="#1e2530"
              strokeOpacity={i === ticks.length - 1 ? 0.85 : 0.3}
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {/* faint area tint under each series */}
          {lines.map((l) => (
            <path key={`a-${l.name}`} d={l.area} fill={`url(#${gid}-${l.name})`} opacity={progress} />
          ))}

          {lines.map((l) => (
            <path
              key={l.name}
              d={l.path}
              fill="none"
              stroke={l.color}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              style={{ strokeDasharray: dash, strokeDashoffset: dash * (1 - progress) }}
            />
          ))}

          {/* end-point dots */}
          {lines.map((l) => {
            const p = l.pts[l.pts.length - 1];
            return (
              <circle
                key={`e-${l.name}`}
                cx={p[0]}
                cy={p[1]}
                r="3"
                fill={l.color}
                opacity={progress}
                vectorEffect="non-scaling-stroke"
                style={{ filter: `drop-shadow(0 0 4px ${l.color})` }}
              />
            );
          })}

          {hoverX != null && (
            <line x1={hoverX} x2={hoverX} y1={padT} y2={geom.baseY} stroke="#9aa6b6" strokeOpacity="0.32" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          )}
          {hover != null &&
            lines.map((l) => {
              const p = l.pts[hover];
              if (!p) return null;
              return <circle key={l.name} cx={p[0]} cy={p[1]} r="4" fill="#0b0e13" stroke={l.color} strokeWidth="2" vectorEffect="non-scaling-stroke" />;
            })}
        </svg>

        {/* y-axis value ticks — HTML overlay */}
        <div className="pointer-events-none absolute inset-0" style={{ opacity: progress }}>
          {ticks.map((t, i) => (
            <span key={i} className="caption absolute -translate-y-1/2 pl-1 text-ink-faint/80" style={{ top: yPx(t.y), left: 0 }}>
              {fmtTick(t.v)}
            </span>
          ))}
        </div>

        {hover != null && hoverX != null && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-line bg-panel/95 px-3 py-2 shadow-[0_12px_30px_-12px_rgba(0,0,0,0.9)] backdrop-blur-sm"
            style={{ left: `${Math.min(90, Math.max(10, (hoverX / W) * 100))}%`, top: 0 }}
          >
            <div className="caption uppercase tracking-wider text-ink-faint">{labels[hover]}</div>
            {lines.map((l) => (
              <div key={l.name} className="mt-1 flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: l.color }} />
                <span className="font-mono text-[10px] text-ink-dim">{l.name}</span>
                <span className="ml-auto font-mono text-[11px] tabular-nums text-ink">
                  {(l.format ?? ((n: number) => n.toLocaleString("en-US")))(l.data[hover])}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-2 flex justify-between font-mono text-[10px] text-ink-faint">
        <span>{labels[0]}</span>
        {labels.length > 2 && <span>{labels[Math.floor(labels.length / 2)]}</span>}
        <span>{labels[labels.length - 1]}</span>
      </div>
    </div>
  );
}
