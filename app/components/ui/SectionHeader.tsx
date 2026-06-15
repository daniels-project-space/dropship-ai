import type { ReactNode } from "react";

// A mono eyebrow + hairline rule, optional trailing meta/actions. The recurring
// section divider used across detail tabs and lists.
export function SectionHeader({
  eyebrow,
  accent = "text-ink-faint",
  meta,
  children,
  className = "",
}: {
  eyebrow: string;
  accent?: string; // tailwind text-* token for the eyebrow
  meta?: ReactNode; // right-aligned meta (count, etc.)
  children?: ReactNode; // right-aligned actions
  className?: string;
}) {
  return (
    <div className={`mb-5 flex items-center gap-3 ${className}`}>
      <span className={`label-eyebrow ${accent}`}>{eyebrow}</span>
      <span className="h-px flex-1 bg-gradient-to-r from-line to-transparent" />
      {meta && <span className="num text-[11px] text-ink-faint">{meta}</span>}
      {children}
    </div>
  );
}
