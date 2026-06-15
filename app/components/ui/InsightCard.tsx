"use client";

import Link from "next/link";
import { Icon, type IconKey } from "../Icons";

// AI-style insight card — icon + headline + supporting stat + suggested action.
// Fed by convex/insights.ts (rule-based, computed). Tone tints the icon chip and
// the left rail. Labelled "computed" upstream so it never reads as magic.
const TONE: Record<string, { text: string; chip: string; rail: string }> = {
  live: { text: "text-live", chip: "bg-live/10 ring-live/25", rail: "from-live/60" },
  pending: { text: "text-pending", chip: "bg-pending/10 ring-pending/30", rail: "from-pending/60" },
  cyan: { text: "text-cyan", chip: "bg-cyan/10 ring-cyan/25", rail: "from-cyan/60" },
  signal: { text: "text-signal", chip: "bg-signal/10 ring-signal/30", rail: "from-signal/60" },
  violet: { text: "text-violet", chip: "bg-violet/10 ring-violet/25", rail: "from-violet/60" },
};

export type InsightData = {
  id: string;
  icon: string;
  tone: string;
  headline: string;
  stat: string;
  action?: { label: string; href: string };
};

export function InsightCard({ insight, index = 0 }: { insight: InsightData; index?: number }) {
  const tone = TONE[insight.tone] ?? TONE.cyan;
  const Glyph = (Icon[insight.icon as IconKey] ?? Icon.spark) as (p: { size?: number; className?: string }) => React.ReactElement;

  return (
    <div
      className="panel animate-rise group relative flex flex-col gap-3 overflow-hidden rounded-2xl p-5"
      style={{ animationDelay: `${index * 70}ms` }}
    >
      {/* left tone rail */}
      <span className={`pointer-events-none absolute inset-y-0 left-0 w-[2px] bg-gradient-to-b ${tone.rail} to-transparent`} />
      <div className="flex items-start gap-3">
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ring-1 ${tone.chip} ${tone.text}`}>
          <Glyph size={17} />
        </span>
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold leading-snug text-ink">{insight.headline}</h3>
        </div>
      </div>
      <p className="text-[12.5px] leading-relaxed text-ink-dim">{insight.stat}</p>
      <div className="mt-auto flex items-center justify-between pt-1">
        <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">computed</span>
        {insight.action && (
          <Link
            href={insight.action.href}
            className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[11.5px] font-medium ring-1 transition hover:bg-white/[0.04] ${tone.text} ${tone.chip}`}
          >
            {insight.action.label}
            <Icon.chevronRight size={12} />
          </Link>
        )}
      </div>
    </div>
  );
}
