"use client";

import { useState } from "react";
import { StatusDot } from "../StatusDot";
import { Icon } from "../Icons";
import { Breadcrumb, type Crumb } from "../ui/Breadcrumb";
import { SampleDataPill } from "../ui/SampleDataPill";

// Top status bar: mobile menu trigger + breadcrumb (left), and the system rail
// (right): content-fit gate chip, brain heartbeat, alerts bell.
export function TopStatusBar({
  crumbs,
  pending,
  gatePassed,
  onOpenMenu,
}: {
  crumbs: Crumb[];
  pending: number;
  gatePassed: boolean | null; // null = unknown/loading
  onOpenMenu: () => void;
}) {
  const [bellOpen, setBellOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-line/80 bg-base/70 backdrop-blur-xl">
      <div className="flex h-14 items-center justify-between gap-3 px-4 sm:h-16 sm:px-6">
        {/* left: mobile menu + breadcrumb */}
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={onOpenMenu}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line text-ink-dim transition hover:text-ink lg:hidden"
            aria-label="Open navigation"
          >
            <Icon.menu size={18} />
          </button>
          <Breadcrumb items={crumbs} />
        </div>

        {/* right: system rail */}
        <div className="flex shrink-0 items-center gap-2 sm:gap-2.5">
          {/* sample-data honesty marker (auto-hides when no seeded data) */}
          <span className="hidden sm:inline-flex">
            <SampleDataPill compact />
          </span>

          {/* content-fit gate */}
          <div
            className={`hidden items-center gap-2 rounded-full border px-3 py-1.5 sm:flex ${
              gatePassed
                ? "border-live/30 bg-live/5"
                : "border-line bg-panel/60"
            }`}
            title="Day-30 content-fit gate"
          >
            <StatusDot
              className={gatePassed ? "bg-live" : "bg-pending"}
              hex={gatePassed ? "#44d6a0" : "#f0a93b"}
              live={!!gatePassed}
              size={6}
            />
            <span className="label-eyebrow text-[9.5px]">
              {gatePassed == null ? "Gate —" : gatePassed ? "Content fit" : "Gate pending"}
            </span>
          </div>

          {/* brain heartbeat */}
          <div className="flex items-center gap-2 rounded-full border border-line bg-panel/60 px-3 py-1.5">
            <StatusDot className="bg-live" hex="#44d6a0" live size={6} />
            <span className="label-eyebrow text-[9.5px] text-ink-dim">Brain online</span>
          </div>

          {/* alerts bell */}
          <div className="relative">
            <button
              onClick={() => setBellOpen((o) => !o)}
              className="relative grid h-9 w-9 place-items-center rounded-lg border border-line text-ink-dim transition hover:text-ink"
              aria-label="Alerts"
            >
              <Icon.bell size={17} />
              {pending > 0 && (
                <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-pending ring-2 ring-base" />
              )}
            </button>
            {bellOpen && (
              <>
                <button className="fixed inset-0 z-40 cursor-default" aria-hidden onClick={() => setBellOpen(false)} />
                <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-72 overflow-hidden rounded-xl border border-line bg-panel p-1.5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.9)]">
                  <div className="px-3 py-2">
                    <span className="label-eyebrow text-signal">Alerts</span>
                  </div>
                  {pending > 0 ? (
                    <a
                      href="/approvals"
                      className="flex items-start gap-3 rounded-lg px-3 py-2.5 transition hover:bg-white/[0.03]"
                    >
                      <span className="mt-0.5">
                        <StatusDot className="bg-pending" hex="#f0a93b" live size={7} />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[13px] text-ink">
                          {pending} action{pending > 1 ? "s" : ""} awaiting approval
                        </span>
                        <span className="block font-mono text-[10px] text-ink-faint">
                          Money / ban-risk moves paused for your call
                        </span>
                      </span>
                    </a>
                  ) : (
                    <p className="px-3 py-4 text-center text-[12px] text-ink-faint">
                      No alerts. The queue is clear.
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
