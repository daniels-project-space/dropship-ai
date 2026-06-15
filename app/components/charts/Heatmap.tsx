"use client";

// Bespoke calendar-style heatmap — a 7×N grid (day-of-week × week) where cell
// intensity encodes a metric (posting cadence). GitHub-contribution-graph feel,
// on-brand: empty cells read as a visible faint inset tile, active cells step up
// through clear brightness bands of the accent colour. Month guides along the
// top, weekday rail on the left, a stepped legend below. Cells fade+scale in on a
// diagonal stagger; hover shows the day + value.

import { useState } from "react";
import { useDrawIn, useInView } from "./hooks";

export type HeatCell = { date: string; value: number };

const DOW = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function Heatmap({
  cells,
  color = "#e8b04b",
  weeks = 12,
  emptyHint = "No posting activity yet.",
  format = (n: number) => `${n}`,
}: {
  cells: HeatCell[];
  color?: string;
  weeks?: number;
  emptyHint?: string;
  format?: (n: number) => string;
}) {
  const { ref, inView } = useInView<HTMLDivElement>();
  const progress = useDrawIn(inView, 1000);
  const [hover, setHover] = useState<HeatCell | null>(null);

  const byDate = new Map(cells.map((c) => [c.date, c.value]));
  const max = Math.max(...cells.map((c) => c.value), 1);
  const total = cells.reduce((s, c) => s + c.value, 0);

  // build a grid ending today, going back `weeks` weeks
  const today = new Date();
  const grid: { date: string; value: number; col: number; row: number }[] = [];
  const end = new Date(today);
  end.setDate(end.getDate() - end.getDay() + 6); // saturday of this week
  for (let w = weeks - 1; w >= 0; w--) {
    for (let d = 0; d < 7; d++) {
      const dt = new Date(end);
      dt.setDate(end.getDate() - w * 7 - (6 - d));
      const iso = dt.toISOString().slice(0, 10);
      grid.push({ date: iso, value: byDate.get(iso) ?? 0, col: weeks - 1 - w, row: d });
    }
  }

  if (cells.length === 0) {
    return (
      <div ref={ref} className="flex items-center justify-center rounded-xl border border-dashed border-line py-8 text-[12px] text-ink-faint">
        {emptyHint}
      </div>
    );
  }

  const cell = 15;
  const gap = 4;
  const gridW = weeks * (cell + gap);
  const gridH = 7 * (cell + gap);

  // month guides — label the first column whose week starts a new month
  const monthMarks: { col: number; label: string }[] = [];
  let lastMonth = -1;
  for (let c = 0; c < weeks; c++) {
    // sunday (row 0) date of this column
    const cellDate = grid.find((g) => g.col === c && g.row === 0)?.date;
    if (!cellDate) continue;
    const m = new Date(cellDate).getMonth();
    if (m !== lastMonth) {
      monthMarks.push({ col: c, label: MONTHS[m] });
      lastMonth = m;
    }
  }

  // 4-band intensity ramp (GitHub-style). Empty handled separately as an inset tile.
  function band(v: number): number {
    if (v <= 0) return 0;
    const r = v / max;
    if (r <= 0.25) return 1;
    if (r <= 0.5) return 2;
    if (r <= 0.75) return 3;
    return 4;
  }
  const BAND_OPACITY = [0, 0.3, 0.52, 0.76, 1];

  return (
    <div ref={ref} className="relative">
      {/* month guides */}
      <div className="mb-1.5 flex" style={{ paddingLeft: 18 }}>
        <div className="relative" style={{ width: gridW, height: 12 }}>
          {monthMarks.map((m) => (
            <span
              key={`${m.col}-${m.label}`}
              className="caption absolute text-ink-faint"
              style={{ left: m.col * (cell + gap) }}
            >
              {m.label}
            </span>
          ))}
        </div>
      </div>

      <div className="flex gap-1.5">
        <div className="flex flex-col justify-between py-[1px]" style={{ height: gridH, width: 12 }}>
          {DOW.map((d, i) => (
            <span key={i} className="font-mono text-[8.5px] leading-none text-ink-faint" style={{ opacity: i % 2 ? 1 : 0 }}>
              {d}
            </span>
          ))}
        </div>
        <svg width={gridW} height={gridH} className="block overflow-visible">
          {grid.map((g, i) => {
            const b = band(g.value);
            const delay = (g.col + g.row) / (weeks + 7);
            const reveal = Math.max(0, Math.min(1, (progress - delay * 0.5) / 0.5));
            const filled = b > 0;
            return (
              <rect
                key={i}
                x={g.col * (cell + gap)}
                y={g.row * (cell + gap)}
                width={cell}
                height={cell}
                rx={3.5}
                fill={filled ? color : "#0f141b"}
                fillOpacity={filled ? BAND_OPACITY[b] * reveal : 0.9 * reveal}
                stroke={filled ? color : "#283040"}
                strokeOpacity={filled ? 0.35 : 0.9}
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
                style={{
                  cursor: filled ? "pointer" : "default",
                  transform: `scale(${0.65 + 0.35 * reveal})`,
                  transformOrigin: "center",
                  transformBox: "fill-box",
                  filter: b >= 3 ? `drop-shadow(0 0 5px ${color}80)` : undefined,
                }}
                onMouseEnter={() => setHover(g)}
                onMouseLeave={() => setHover(null)}
              />
            );
          })}
        </svg>
      </div>

      <div className="mt-3.5 flex items-center justify-between">
        <span className="num text-[10px] text-ink-dim/80">
          {total} posts · trailing {weeks}w
        </span>
        <span className="flex items-center gap-1.5 caption uppercase tracking-wider text-ink-faint">
          less
          {[0, 1, 2, 3, 4].map((b) => (
            <span
              key={b}
              className="h-3 w-3 rounded-[3px]"
              style={
                b === 0
                  ? { background: "#0f141b", border: "1px solid var(--color-line)" }
                  : { background: color, opacity: BAND_OPACITY[b] }
              }
            />
          ))}
          more
        </span>
      </div>

      {hover && hover.value > 0 && (
        <div className="pointer-events-none absolute left-0 top-0 rounded-md border border-line bg-panel/95 px-2.5 py-1.5 font-mono text-[10px] shadow-lg backdrop-blur-sm">
          <span className="text-ink">{format(hover.value)}</span> <span className="text-ink-faint">· {hover.date}</span>
        </div>
      )}
    </div>
  );
}
