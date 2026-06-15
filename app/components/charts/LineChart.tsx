"use client";

// Bespoke multi-series line chart. Smooth strokes, synchronized left→right
// draw-in, shared hover crosshair with a multi-row tooltip, inline legend.
// Each series carries its own themed colour.

import { useMemo, useRef, useState } from "react";
import { useDrawIn, useInView, smoothPath, type Pt } from "./hooks";

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
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const W = 640;
  const H = height;
  const padL = 8;
  const padR = 8;
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
    const stepX = innerW / (n - 1);
    const lines = series.map((s) => {
      const pts: Pt[] = s.data.map((v, i) => {
        const x = padL + i * stepX;
        const y = padT + (1 - (v - min) / span) * innerH;
        return [x, y] as const;
      });
      return { ...s, pts, path: smoothPath(pts, 0.5) };
    });
    return { lines, stepX, max, min };
  }, [series, labels, H]);

  if (!geom) {
    return (
      <div ref={ref} className="flex items-center justify-center rounded-xl border border-dashed border-line text-[12px] text-ink-faint" style={{ height }}>
        {emptyHint}
      </div>
    );
  }

  const { lines } = geom;
  const dash = 2200;

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    const idx = Math.round(xRatio * (labels.length - 1));
    setHover(Math.max(0, Math.min(labels.length - 1, idx)));
  }

  const hoverX = hover != null ? lines[0]?.pts[hover]?.[0] ?? null : null;

  return (
    <div ref={ref}>
      {/* legend */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {series.map((s) => (
          <span key={s.name} className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
            <span className="h-1.5 w-3 rounded-full" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </div>

      <div ref={wrapRef} className="relative" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="Line chart">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={height} preserveAspectRatio="none" className="block">
          {Array.from({ length: yTicks + 1 }, (_, i) => {
            const y = padT + ((H - padT - padB) * i) / yTicks;
            return <line key={i} x1={padL} x2={W - padR} y1={y} y2={y} stroke="#1e2530" strokeOpacity={i === yTicks ? 0.9 : 0.35} strokeWidth="1" vectorEffect="non-scaling-stroke" />;
          })}

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

          {hoverX != null && (
            <line x1={hoverX} x2={hoverX} y1={padT} y2={H - padB} stroke="#9aa6b6" strokeOpacity="0.3" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          )}
          {hover != null &&
            lines.map((l) => {
              const p = l.pts[hover];
              if (!p) return null;
              return <circle key={l.name} cx={p[0]} cy={p[1]} r="4" fill="#0b0e13" stroke={l.color} strokeWidth="2" vectorEffect="non-scaling-stroke" />;
            })}
        </svg>

        {hover != null && hoverX != null && (
          <div
            className="pointer-events-none absolute -translate-x-1/2 rounded-lg border border-line bg-panel/95 px-3 py-2 shadow-[0_12px_30px_-12px_rgba(0,0,0,0.9)] backdrop-blur-sm"
            style={{ left: `${(hoverX / W) * 100}%`, top: 0 }}
          >
            <div className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">{labels[hover]}</div>
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
