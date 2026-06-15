"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSearchParams } from "next/navigation";
import { Icon, type IconKey } from "../Icons";
import { BrandSwitcher, type BrandOption } from "./BrandSwitcher";

type NavItem = { href: string; label: string; icon: IconKey; badge?: number };

// Nav order matches the IA: portfolio → the work pipeline → ops → settings.
function navItems(pending: number): NavItem[] {
  return [
    { href: "/", label: "Portfolio", icon: "portfolio" },
    { href: "/approvals", label: "Approvals", icon: "approvals", badge: pending },
    { href: "/content", label: "Content", icon: "content" },
    { href: "/posts", label: "Distribution", icon: "distribution" },
    { href: "/research", label: "Research", icon: "research" },
    { href: "/activity", label: "Activity", icon: "activity" },
    { href: "/settings", label: "Settings", icon: "settings" },
  ];
}

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

// Persistent left rail. Collapsible (icon-only ↔ icon+label). On mobile it is
// rendered inside an off-canvas drawer by AppShell (see `onNavigate`).
export function NavRail({
  collapsed,
  onToggleCollapse,
  pending,
  brands,
  brandsLoading,
  onNavigate,
  mobile = false,
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
  pending: number;
  brands: BrandOption[];
  brandsLoading: boolean;
  onNavigate?: () => void;
  mobile?: boolean;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const brandQs = params.get("brand");
  const showLabels = mobile || !collapsed;

  // preserve ?brand= across rail navigation so the active brand stays scoped
  const withBrand = (href: string) =>
    brandQs ? `${href}?brand=${brandQs}` : href;

  return (
    <div className="flex h-full flex-col">
      {/* identity */}
      <div className={`flex items-center gap-3 px-4 ${showLabels ? "" : "justify-center px-0"} pb-4 pt-5`}>
        <Link
          href={withBrand("/")}
          onClick={onNavigate}
          className="relative grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border border-signal/30 bg-signal/10"
          aria-label="Dropship AI home"
        >
          <span className="font-display text-[17px] italic leading-none text-signal">d</span>
          <span className="pulse-ring absolute inset-0 rounded-[10px] text-signal/40" />
        </Link>
        {showLabels && (
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate font-display text-[15px] font-medium tracking-tight text-ink">
              Dropship&nbsp;AI
            </span>
            <span className="label-eyebrow text-[9px]">Control Plane</span>
          </span>
        )}
      </div>

      {/* brand switcher */}
      <div className={`px-3 ${showLabels ? "" : "px-2"}`}>
        <BrandSwitcher
          brands={brands}
          loading={brandsLoading}
          collapsed={!showLabels}
          onNavigate={onNavigate}
        />
      </div>

      <div className="mx-3 my-4 h-px bg-line-soft" />

      {/* nav */}
      <nav className="flex flex-1 flex-col gap-1 px-3">
        {navItems(pending).map((item) => {
          const active = isActive(pathname, item.href);
          const I = Icon[item.icon];
          return (
            <Link
              key={item.href}
              href={withBrand(item.href)}
              onClick={onNavigate}
              title={!showLabels ? item.label : undefined}
              className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-colors ${
                showLabels ? "" : "justify-center px-0"
              } ${active ? "bg-signal/10 text-signal" : "text-ink-dim hover:bg-white/[0.03] hover:text-ink"}`}
            >
              {active && (
                <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-signal shadow-[0_0_10px_rgba(232,176,75,0.6)]" />
              )}
              <span className="relative shrink-0">
                <I size={18} className={active ? "text-signal" : ""} />
                {item.badge != null && item.badge > 0 && !showLabels && (
                  <span className="absolute -right-1.5 -top-1.5 h-2 w-2 rounded-full bg-pending ring-2 ring-base" />
                )}
              </span>
              {showLabels && <span className="truncate">{item.label}</span>}
              {showLabels && item.badge != null && item.badge > 0 && (
                <span className="ml-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-pending px-1 font-mono text-[10px] font-semibold text-void">
                  {item.badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* collapse toggle (desktop only) */}
      {!mobile && (
        <div className="px-3 pb-4 pt-2">
          <button
            onClick={onToggleCollapse}
            title={collapsed ? "Expand" : "Collapse"}
            className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[12px] font-medium text-ink-faint transition-colors hover:bg-white/[0.03] hover:text-ink-dim ${
              showLabels ? "" : "justify-center px-0"
            }`}
          >
            <Icon.collapse size={17} className={collapsed ? "rotate-180" : ""} />
            {showLabels && <span>Collapse</span>}
          </button>
        </div>
      )}
    </div>
  );
}
