"use client";

import { Suspense, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { NavRail } from "./NavRail";
import { TopStatusBar } from "./TopStatusBar";
import type { BrandOption } from "./BrandSwitcher";
import type { Crumb } from "../ui/Breadcrumb";
import { Icon } from "../Icons";

const RAIL_W = 240;
const RAIL_W_COLLAPSED = 64;

// Static label map for first-level routes (detail crumbs are passed via props).
const ROUTE_LABEL: Record<string, string> = {
  "": "Portfolio",
  approvals: "Approvals",
  content: "Content",
  posts: "Distribution",
  research: "Research",
  activity: "Activity",
  settings: "Settings",
  sites: "Portfolio",
};

function deriveCrumbs(pathname: string, override?: Crumb[]): Crumb[] {
  if (override) return override;
  const seg = pathname.split("/").filter(Boolean);
  if (seg.length === 0) return [{ label: "Portfolio" }];
  const label = ROUTE_LABEL[seg[0]] ?? seg[0];
  return [{ label: "Portfolio", href: "/" }, { label }];
}

// The control-plane frame: persistent rail (desktop) / drawer (mobile) + sticky
// status bar + content well. Every page renders its body as `children`.
function AppShellInner({
  children,
  crumbs: crumbOverride,
}: {
  children: ReactNode;
  crumbs?: Crumb[];
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // persist collapse pref
  useEffect(() => {
    const saved = typeof window !== "undefined" && localStorage.getItem("railCollapsed");
    if (saved === "1") setCollapsed(true);
  }, []);
  function toggleCollapse() {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem("railCollapsed", next ? "1" : "0");
      } catch {}
      return next;
    });
  }
  // close the mobile drawer on route change
  useEffect(() => setMobileOpen(false), [pathname]);

  const portfolio = useQuery(api.dashboard.portfolio);
  const gate = useQuery(api.dashboard.contentFitGate, {});

  const pending = portfolio?.totalPendingActions ?? 0;
  const brandsLoading = portfolio === undefined;
  const brands: BrandOption[] = (portfolio?.sites ?? []).map((s) => ({
    siteId: s.siteId,
    name: s.name,
    status: s.status,
    pendingActionCount: s.pendingActionCount,
  }));
  const gatePassed = gate === undefined ? null : gate.passed;
  const crumbs = deriveCrumbs(pathname, crumbOverride);
  const railWidth = collapsed ? RAIL_W_COLLAPSED : RAIL_W;

  return (
    <div className="relative z-10 min-h-screen">
      {/* desktop rail — fixed, glass, right hairline */}
      <aside
        className="fixed inset-y-0 left-0 z-30 hidden border-r border-line bg-panel/55 backdrop-blur-xl transition-[width] duration-300 lg:block"
        style={{ width: railWidth }}
      >
        <NavRail
          collapsed={collapsed}
          onToggleCollapse={toggleCollapse}
          pending={pending}
          brands={brands}
          brandsLoading={brandsLoading}
        />
      </aside>

      {/* mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
            className="absolute inset-0 bg-void/70 backdrop-blur-sm"
          />
          <aside
            className="absolute inset-y-0 left-0 w-[270px] border-r border-line bg-panel"
            style={{ animation: "drawer-in 0.3s cubic-bezier(0.16,1,0.3,1) forwards" }}
          >
            <div className="flex justify-end px-3 pt-3">
              <button
                onClick={() => setMobileOpen(false)}
                className="grid h-8 w-8 place-items-center rounded-lg border border-line text-ink-dim"
                aria-label="Close"
              >
                <Icon.close size={16} />
              </button>
            </div>
            <NavRail
              mobile
              collapsed={false}
              onToggleCollapse={toggleCollapse}
              pending={pending}
              brands={brands}
              brandsLoading={brandsLoading}
              onNavigate={() => setMobileOpen(false)}
            />
          </aside>
        </div>
      )}

      {/* content column */}
      <div className="transition-[padding] duration-300 lg:pl-[var(--rail)]" style={{ ["--rail" as string]: `${railWidth}px` }}>
        <TopStatusBar
          crumbs={crumbs}
          pending={pending}
          gatePassed={gatePassed}
          onOpenMenu={() => setMobileOpen(true)}
        />
        <main>{children}</main>
      </div>
    </div>
  );
}

export function AppShell(props: { children: ReactNode; crumbs?: Crumb[] }) {
  // useSearchParams (in NavRail/BrandSwitcher) requires a Suspense boundary in Next 16.
  return (
    <Suspense fallback={<div className="relative z-10 min-h-screen" />}>
      <AppShellInner {...props} />
    </Suspense>
  );
}
