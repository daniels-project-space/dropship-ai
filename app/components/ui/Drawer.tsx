"use client";

import { useEffect, type ReactNode } from "react";
import { Icon } from "../Icons";

// Right-hand side panel. void/70 backdrop blur, slides in from the right.
// Used for detail inspection (e.g. a product, an order, an audit entry).
export function Drawer({
  open,
  onClose,
  title,
  eyebrow,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  eyebrow?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex justify-end">
      <button
        aria-label="Close panel"
        onClick={onClose}
        className="absolute inset-0 bg-void/70 backdrop-blur-sm"
      />
      <aside
        className="relative z-10 flex h-full w-full max-w-md flex-col border-l border-line bg-panel shadow-[0_0_60px_-12px_rgba(0,0,0,0.9)]"
        style={{ animation: "drawer-in 0.32s cubic-bezier(0.16,1,0.3,1) forwards" }}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line-soft px-6 py-5">
          <div className="min-w-0">
            {eyebrow && <span className="label-eyebrow text-signal">{eyebrow}</span>}
            <div className="mt-1.5 font-display text-xl font-medium tracking-tight text-ink">
              {title}
            </div>
          </div>
          <button
            onClick={onClose}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line text-ink-dim transition hover:border-line/0 hover:bg-white/5 hover:text-ink"
          >
            <Icon.close size={16} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <footer className="border-t border-line-soft px-6 py-4">{footer}</footer>}
      </aside>
    </div>
  );
}
