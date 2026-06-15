"use client";

// Bespoke conversion funnel — stacked tapering stages with the drop-off rate
// surfaced between them. Each stage bar grows from the left on draw-in; the
// taper (centered width) reads as a true funnel. Step-to-step conversion shown.

import { useDrawIn, useInView } from "./hooks";

export type FunnelStage = { label: string; value: number };

export function Funnel({
  stages,
  color = "#5cc6e8",
  format = (n: number) => n.toLocaleString("en-US"),
  emptyHint = "Funnel populates once traffic flows.",
}: {
  stages: FunnelStage[];
  color?: string;
  format?: (n: number) => string;
  emptyHint?: string;
}) {
  const { ref, inView } = useInView<HTMLDivElement>();
  const progress = useDrawIn(inView, 900);
  const top = stages[0]?.value ?? 0;
  const hasData = stages.length > 0 && top > 0;

  if (!hasData) {
    return (
      <div ref={ref} className="flex flex-col gap-2.5">
        {(stages.length ? stages : [{ label: "Views", value: 0 }, { label: "Add-to-cart", value: 0 }, { label: "Checkout", value: 0 }, { label: "Purchase", value: 0 }]).map((s) => (
          <div key={s.label} className="flex items-center gap-3 opacity-50">
            <span className="w-24 shrink-0 font-mono text-[11px] text-ink-dim">{s.label}</span>
            <div className="h-8 flex-1 rounded-md border border-dashed border-line" />
          </div>
        ))}
        <p className="mt-1 text-[12px] text-ink-faint">{emptyHint}</p>
      </div>
    );
  }

  return (
    <div ref={ref} className="flex flex-col gap-2">
      {stages.map((s, i) => {
        const pctOfTop = (s.value / top) * 100;
        const width = Math.max(pctOfTop, 8) * progress;
        const prev = i > 0 ? stages[i - 1].value : null;
        const stepConv = prev != null && prev > 0 ? (s.value / prev) * 100 : null;
        return (
          <div key={s.label}>
            <div className="flex items-center gap-3">
              <span className="w-24 shrink-0 font-mono text-[11px] text-ink-dim">{s.label}</span>
              <div className="relative flex h-9 flex-1 items-center justify-center">
                <div
                  className="flex h-full items-center justify-between rounded-md px-3 ring-1 ring-white/5"
                  style={{
                    width: `${width}%`,
                    background: `linear-gradient(90deg, ${color}38, ${color}18)`,
                    transition: "width 0.1s linear",
                  }}
                >
                  <span className="font-mono text-[11px] tabular-nums text-ink">{format(s.value)}</span>
                  <span className="font-mono text-[10px] tabular-nums text-ink-faint">{pctOfTop.toFixed(1)}%</span>
                </div>
              </div>
            </div>
            {stepConv != null && i < stages.length && (
              <div className="flex items-center gap-3 py-0.5">
                <span className="w-24 shrink-0" />
                <span className="font-mono text-[9.5px] uppercase tracking-wider text-ink-faint">
                  <span className={stepConv >= 50 ? "text-live" : stepConv >= 20 ? "text-pending" : "text-danger"}>▾ {stepConv.toFixed(1)}%</span> step conversion
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
