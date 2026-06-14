"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { StatusDot } from "./StatusDot";

const NAV = [
  { href: "/", label: "Portfolio" },
  { href: "/approvals", label: "Approvals" },
];

export function TopBar({ pendingCount = 0 }: { pendingCount?: number }) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-line/80 bg-base/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1240px] items-center justify-between gap-3 px-5 sm:h-[72px] sm:px-8">
        {/* identity */}
        <Link href="/" className="group flex items-center gap-3 min-w-0">
          <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border border-signal/30 bg-signal/10">
            <span className="font-display text-[17px] italic leading-none text-signal">
              d
            </span>
            <span className="pulse-ring absolute inset-0 rounded-[10px] text-signal/40" />
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate font-display text-[15px] font-medium tracking-tight text-ink sm:text-base">
              Dropship&nbsp;AI
            </span>
            <span className="label-eyebrow hidden text-[10px] sm:block">
              Autonomous Control Plane
            </span>
          </span>
        </Link>

        {/* nav + status */}
        <div className="flex items-center gap-2 sm:gap-3">
          <nav className="flex items-center rounded-full border border-line bg-panel/60 p-1">
            {NAV.map((item) => {
              const active = pathname === item.href;
              const isApprovals = item.href === "/approvals";
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`relative flex items-center gap-2 rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors sm:px-4 ${
                    active
                      ? "bg-signal/15 text-signal"
                      : "text-ink-dim hover:text-ink"
                  }`}
                >
                  {item.label}
                  {isApprovals && pendingCount > 0 && (
                    <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-pending px-1 font-mono text-[10px] font-semibold text-void">
                      {pendingCount}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>

          {/* system heartbeat */}
          <div className="hidden items-center gap-2 rounded-full border border-line bg-panel/60 px-3 py-2 md:flex">
            <StatusDot className="bg-live" hex="#44d6a0" live size={7} />
            <span className="label-eyebrow text-[10px] text-ink-dim">
              Brain online
            </span>
          </div>
        </div>
      </div>
    </header>
  );
}
