import type { ReactNode } from "react";
import { StatusDot } from "../StatusDot";

// Pill badge driven by a tone `ring` class from tokens.ts. Optional leading dot.
export function Badge({
  children,
  ring,
  dot,
  hex,
  live = false,
  className = "",
}: {
  children: ReactNode;
  ring?: string; // full ring/text/bg class set from a Tone
  dot?: string; // bg-* for the leading StatusDot
  hex?: string;
  live?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${
        ring ?? "bg-white/5 text-ink-dim ring-1 ring-white/10"
      } ${className}`}
    >
      {dot && <StatusDot className={dot} hex={hex} live={live} size={6} />}
      {children}
    </span>
  );
}
