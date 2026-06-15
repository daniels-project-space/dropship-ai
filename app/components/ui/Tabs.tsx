"use client";

import type { ReactNode } from "react";

export type TabItem = {
  key: string;
  label: string;
  count?: number; // optional trailing count pill
};

// Horizontal tab bar with an animated signal-amber underline on the active tab.
// Mono labels, scrolls horizontally on narrow viewports. Controlled component.
export function Tabs({
  items,
  active,
  onChange,
  className = "",
}: {
  items: TabItem[];
  active: string;
  onChange: (key: string) => void;
  className?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <div className="flex items-center gap-1 overflow-x-auto pb-px [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((t) => {
          const on = t.key === active;
          return (
            <button
              key={t.key}
              onClick={() => onChange(t.key)}
              className={`relative flex shrink-0 items-center gap-2 rounded-t-lg px-3.5 py-2.5 text-[13px] font-medium transition-colors ${
                on ? "text-signal" : "text-ink-dim hover:text-ink"
              }`}
            >
              {t.label}
              {t.count != null && t.count > 0 && (
                <span
                  className={`flex h-[17px] min-w-[17px] items-center justify-center rounded-full px-1 font-mono text-[10px] ${
                    on ? "bg-signal/15 text-signal" : "bg-white/5 text-ink-faint"
                  }`}
                >
                  {t.count}
                </span>
              )}
              {on && (
                <span className="absolute inset-x-1 -bottom-px h-[2px] rounded-full bg-signal shadow-[0_0_12px_rgba(232,176,75,0.5)]" />
              )}
            </button>
          );
        })}
      </div>
      <span className="absolute inset-x-0 bottom-0 h-px bg-line" />
    </div>
  );
}

// A simple presentational wrapper so each tab panel gets a consistent rise-in.
export function TabPanel({ children }: { children: ReactNode }) {
  return <div className="animate-rise">{children}</div>;
}
