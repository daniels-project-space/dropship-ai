"use client";

// Bespoke bar chart with three modes:
//  • horizontal (default) — labelled rows with value at the end, grows on draw-in
//  • vertical — columns with x labels
//  • mini — tiny inline column strip (no labels), for table cells
// Each bar can carry its own colour; rounded caps; staggered grow-in.

import { useDrawIn, useInView } from "./hooks";

export type Bar = { label: string; value: number; color?: string; sublabel?: string };

export function BarChart({
  data,
  orientation = "horizontal",
  height,
  color = "#e8b04b",
  format = (n: number) => n.toLocaleString("en-US"),
  emptyHint = "No data yet.",
}: {
  data: Bar[];
  orientation?: "horizontal" | "vertical";
  height?: number;
  color?: string;
  format?: (n: number) => string;
  emptyHint?: string;
}) {
  const { ref, inView } = useInView<HTMLDivElement>();
  const progress = useDrawIn(inView, 850);
  const max = Math.max(...data.map((d) => d.value), 1);

  if (!data || data.length === 0) {
    return (
      <div ref={ref} className="flex items-center justify-center rounded-xl border border-dashed border-line py-8 text-[12px] text-ink-faint">
        {emptyHint}
      </div>
    );
  }

  if (orientation === "vertical") {
    const H = height ?? 180;
    return (
      <div ref={ref} className="flex items-end gap-3" style={{ height: H }}>
        {data.map((d, i) => {
          const h = (d.value / max) * (H - 28) * progress;
          return (
            <div key={d.label} className="flex flex-1 flex-col items-center justify-end gap-2">
              <span className="font-mono text-[10px] tabular-nums text-ink-dim">{progress > 0.6 ? format(d.value) : ""}</span>
              <div
                className="w-full rounded-t-md"
                style={{
                  height: Math.max(h, 2),
                  background: `linear-gradient(180deg, ${d.color ?? color}, ${d.color ?? color}55)`,
                  transitionDelay: `${i * 60}ms`,
                }}
              />
              <span className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">{d.label}</span>
            </div>
          );
        })}
      </div>
    );
  }

  // horizontal
  return (
    <div ref={ref} className="flex flex-col gap-3">
      {data.map((d, i) => {
        const w = (d.value / max) * 100 * progress;
        const c = d.color ?? color;
        return (
          <div key={d.label} className="flex items-center gap-3">
            <span className="w-24 shrink-0 truncate font-mono text-[11px] text-ink-dim" title={d.label}>
              {d.label}
            </span>
            <div className="h-6 flex-1 overflow-hidden rounded-md bg-void/40 ring-1 ring-white/5">
              <div
                className="flex h-full items-center justify-end rounded-md px-2"
                style={{
                  width: `${Math.max(w, w > 0 ? 4 : 0)}%`,
                  background: `linear-gradient(90deg, ${c}40, ${c})`,
                  boxShadow: `0 0 16px -4px ${c}90`,
                  transitionDelay: `${i * 50}ms`,
                }}
              >
                {progress > 0.7 && <span className="font-mono text-[10px] tabular-nums text-void/90 mix-blend-luminosity">{format(d.value)}</span>}
              </div>
            </div>
            {d.sublabel && <span className="w-14 shrink-0 text-right font-mono text-[10px] text-ink-faint">{d.sublabel}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** Inline mini column strip for table cells — no labels, fixed small height. */
export function MiniBars({ data, color = "#5cc6e8", width = 64, height = 22 }: { data: number[]; color?: string; width?: number; height?: number }) {
  if (!data || data.length === 0) return <span className="font-mono text-[10px] text-ink-faint">—</span>;
  const max = Math.max(...data, 1);
  const gap = 2;
  const bw = (width - gap * (data.length - 1)) / data.length;
  return (
    <svg width={width} height={height} aria-hidden className="block">
      {data.map((v, i) => {
        const h = Math.max(2, (v / max) * height);
        return <rect key={i} x={i * (bw + gap)} y={height - h} width={bw} height={h} rx={1} fill={color} opacity={0.45 + 0.55 * (v / max)} />;
      })}
    </svg>
  );
}
