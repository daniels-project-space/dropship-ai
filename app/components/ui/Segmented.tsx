"use client";

// Segmented control — a compact pill group with a sliding active indicator.
// Used for the timeframe toggle (7d/30d/90d) and platform filter. Controlled.

export type SegOption<T extends string> = { value: T; label: string };

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  className = "",
}: {
  options: SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const pad = size === "sm" ? "px-2.5 py-1 text-[10.5px]" : "px-3 py-1.5 text-[11.5px]";
  return (
    <div className={`relative inline-flex items-center rounded-full border border-line bg-void/50 p-0.5 ring-1 ring-inset ring-white/[0.02] ${className}`}>
      {/* sliding indicator */}
      <span
        className="absolute inset-y-0.5 rounded-full bg-panel-2 shadow-[0_1px_0_rgba(255,255,255,0.05)_inset,0_4px_12px_-6px_rgba(0,0,0,0.8)] ring-1 ring-signal/20 transition-transform duration-300"
        style={{ width: `calc((100% - 4px) / ${options.length})`, transform: `translateX(calc(${idx} * 100%))`, left: 2 }}
      />
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={`relative z-10 flex-1 whitespace-nowrap rounded-full font-mono font-medium uppercase tracking-wider transition-colors ${pad} ${
              on ? "text-signal" : "text-ink-faint hover:text-ink-dim"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
