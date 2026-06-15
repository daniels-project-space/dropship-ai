"use client";

// Bespoke conversion funnel — centered tapering stage bars (a true funnel
// silhouette) with the absolute count + cumulative share on each bar, and the
// step-to-step conversion surfaced on a connector BETWEEN stages. Each bar grows
// from the centre on draw-in.

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
    <div ref={ref} className="flex flex-col">
      {stages.map((s, i) => {
        const pctOfTop = (s.value / top) * 100;
        const width = Math.max(pctOfTop, 7) * progress;
        const prev = i > 0 ? stages[i - 1].value : null;
        const stepConv = prev != null && prev > 0 ? (s.value / prev) * 100 : null;
        const stepTone = stepConv == null ? "" : stepConv >= 50 ? "text-live" : stepConv >= 20 ? "text-pending" : "text-danger";
        return (
          <div key={s.label}>
            {/* connector + step conversion between this stage and the previous */}
            {stepConv != null && (
              <div className="flex items-stretch gap-3 py-1">
                <span className="w-24 shrink-0" />
                <div className="flex flex-1 items-center justify-center">
                  <span className="h-3 w-px bg-line" />
                  <span className={`mx-2 num text-[10px] ${stepTone}`}>
                    {stepConv.toFixed(1)}%
                  </span>
                  <span className="caption uppercase tracking-wider text-ink-faint">step</span>
                  <span className="h-3 w-px bg-line" />
                </div>
              </div>
            )}

            <div className="flex items-center gap-3">
              <span className="w-24 shrink-0 font-mono text-[11px] text-ink-dim">{s.label}</span>
              <div className="relative flex h-10 flex-1 items-center justify-center">
                <div
                  className="flex h-full items-center justify-between rounded-md px-3 ring-1 ring-inset ring-white/[0.07]"
                  style={{
                    width: `${width}%`,
                    background: `linear-gradient(90deg, ${color}40, ${color}20)`,
                    boxShadow: `inset 0 0 22px -10px ${color}, 0 0 18px -10px ${color}`,
                    transition: "width 0.1s linear",
                  }}
                >
                  <span className="num text-[12px] text-ink">{format(s.value)}</span>
                  <span className="num text-[10px] text-ink-dim">{pctOfTop.toFixed(1)}%</span>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
