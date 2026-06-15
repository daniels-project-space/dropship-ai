"use client";

// Bespoke calendar-style heatmap — a 7×N grid (day-of-week × week) where cell
// intensity encodes a metric (posting cadence / engagement). Cells fade+scale in
// on a diagonal stagger. Hover shows the day + value.

import { useState } from "react";
import { useDrawIn, useInView } from "./hooks";

export type HeatCell = { date: string; value: number };

const DOW = ["S", "M", "T", "W", "T", "F", "S"];

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

  const cell = 13;
  const gap = 3;
  const gridW = weeks * (cell + gap);
  const gridH = 7 * (cell + gap);

  function intensity(v: number) {
    if (v <= 0) return 0.06;
    return 0.18 + (v / max) * 0.82;
  }

  return (
    <div ref={ref} className="relative">
      <div className="flex gap-2">
        <div className="flex flex-col justify-between py-[1px]" style={{ height: gridH }}>
          {DOW.map((d, i) => (
            <span key={i} className="font-mono text-[8.5px] leading-none text-ink-faint" style={{ opacity: i % 2 ? 1 : 0 }}>
              {d}
            </span>
          ))}
        </div>
        <svg width={gridW} height={gridH} className="block">
          {grid.map((g, i) => {
            const op = intensity(g.value);
            const delay = (g.col + g.row) / (weeks + 7);
            const reveal = Math.max(0, Math.min(1, (progress - delay * 0.5) / 0.5));
            return (
              <rect
                key={i}
                x={g.col * (cell + gap)}
                y={g.row * (cell + gap)}
                width={cell}
                height={cell}
                rx={3}
                fill={g.value > 0 ? color : "#161c25"}
                fillOpacity={g.value > 0 ? op * reveal : 0.5 * reveal}
                stroke={g.value > 0 ? color : "#1e2530"}
                strokeOpacity={g.value > 0 ? 0.25 : 0.4}
                strokeWidth="1"
                style={{ cursor: g.value > 0 ? "pointer" : "default", transform: `scale(${0.6 + 0.4 * reveal})`, transformOrigin: "center", transformBox: "fill-box" }}
                onMouseEnter={() => setHover(g)}
                onMouseLeave={() => setHover(null)}
              />
            );
          })}
        </svg>
      </div>

      <div className="mt-3 flex items-center justify-between">
        <span className="font-mono text-[10px] text-ink-faint">{total} posts · trailing {weeks}w</span>
        <span className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wider text-ink-faint">
          less
          {[0.12, 0.35, 0.6, 0.9].map((o) => (
            <span key={o} className="h-2.5 w-2.5 rounded-sm" style={{ background: color, opacity: o }} />
          ))}
          more
        </span>
      </div>

      {hover && (
        <div className="pointer-events-none absolute left-0 top-0 rounded-md border border-line bg-panel/95 px-2.5 py-1.5 font-mono text-[10px] shadow-lg backdrop-blur-sm">
          <span className="text-ink">{format(hover.value)}</span> <span className="text-ink-faint">· {hover.date}</span>
        </div>
      )}
    </div>
  );
}
