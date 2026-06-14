import type { ReactNode } from "react";

// Intentional empty state — never a blank screen. A framed, atmospheric panel
// with an icon glyph, headline, supporting copy and an optional action slot.

export function EmptyState({
  glyph,
  title,
  body,
  children,
}: {
  glyph: ReactNode;
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-dashed border-line bg-panel/40 px-6 py-16 text-center sm:py-20">
      {/* faint concentric guide rings behind the glyph */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[72px] -translate-x-1/2 opacity-[0.5]"
      >
        <div className="h-[260px] w-[260px] rounded-full border border-line" />
        <div className="absolute inset-8 rounded-full border border-line/70" />
        <div className="absolute inset-16 rounded-full border border-line/50" />
      </div>

      <div className="relative mx-auto flex max-w-md flex-col items-center">
        <div className="mb-6 grid h-16 w-16 place-items-center rounded-2xl border border-signal/25 bg-signal/10 text-signal">
          {glyph}
        </div>
        <h3 className="font-display text-2xl font-medium tracking-tight text-ink">
          {title}
        </h3>
        <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-ink-dim">
          {body}
        </p>
        {children && <div className="mt-8">{children}</div>}
      </div>
    </div>
  );
}
