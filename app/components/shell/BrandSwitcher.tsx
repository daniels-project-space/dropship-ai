"use client";

import { useEffect, useRef, useState } from "react";
import { StatusDot } from "../StatusDot";
import { Icon } from "../Icons";
import { SITE_STATUS, type SiteStatus } from "../tokens";
import { useBrand, ALL_BRANDS } from "./useBrand";

export type BrandOption = {
  siteId: string;
  name: string;
  status: SiteStatus;
  pendingActionCount: number;
};

// Active-brand selector at the top of the rail. Scopes every view to the chosen
// brand (URL ?brand=), or "All brands" for the whole portfolio.
export function BrandSwitcher({
  brands,
  loading,
  collapsed = false,
  onNavigate,
}: {
  brands: BrandOption[];
  loading: boolean;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const { brand, setBrand, isAll } = useBrand();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const current = brands.find((b) => b.siteId === brand);
  const tone = current ? SITE_STATUS[current.status] : null;

  function pick(id: string) {
    setBrand(id);
    setOpen(false);
    onNavigate?.();
  }

  if (collapsed) {
    return (
      <button
        onClick={() => setOpen((o) => !o)}
        title={isAll ? "All brands" : current?.name ?? "Brand"}
        className="relative grid h-10 w-10 place-items-center rounded-xl border border-line bg-panel-2/60 text-ink transition hover:border-signal/40"
      >
        {isAll ? (
          <Icon.portfolio size={16} className="text-ink-dim" />
        ) : (
          <StatusDot className={tone?.dot ?? "bg-ink-faint"} hex={tone?.hex} live={current?.status === "active"} size={8} />
        )}
      </button>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={loading}
        className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-panel-2/60 px-3 py-2.5 text-left transition hover:border-signal/40 disabled:opacity-60"
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-line bg-void/50">
          {isAll ? (
            <Icon.portfolio size={14} className="text-ink-dim" />
          ) : (
            <StatusDot className={tone?.dot ?? "bg-ink-faint"} hex={tone?.hex} live={current?.status === "active"} size={7} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">
            {loading ? "Loading…" : isAll ? "All brands" : current?.name ?? "Select brand"}
          </span>
          <span className="label-eyebrow block text-[8.5px]">Active scope</span>
        </span>
        <Icon.chevron size={15} className={`shrink-0 text-ink-faint transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 overflow-hidden rounded-xl border border-line bg-panel p-1.5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.9)]">
          <button
            onClick={() => pick(ALL_BRANDS)}
            className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition ${
              isAll ? "bg-signal/10 text-signal" : "text-ink-dim hover:bg-white/[0.03] hover:text-ink"
            }`}
          >
            <Icon.portfolio size={15} />
            <span className="flex-1">All brands</span>
            <span className="font-mono text-[10px] text-ink-faint">{brands.length}</span>
          </button>
          {brands.length > 0 && <div className="my-1 h-px bg-line-soft" />}
          <div className="max-h-64 overflow-y-auto">
            {brands.map((b) => {
              const t = SITE_STATUS[b.status];
              const on = b.siteId === brand;
              return (
                <button
                  key={b.siteId}
                  onClick={() => pick(b.siteId)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition ${
                    on ? "bg-signal/10 text-signal" : "text-ink-dim hover:bg-white/[0.03] hover:text-ink"
                  }`}
                >
                  <StatusDot className={t.dot} hex={t.hex} live={b.status === "active"} size={7} />
                  <span className="min-w-0 flex-1 truncate">{b.name}</span>
                  {b.pendingActionCount > 0 && (
                    <span className="flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-pending px-1 font-mono text-[9px] font-semibold text-void">
                      {b.pendingActionCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
