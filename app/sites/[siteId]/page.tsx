"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PageContainer } from "../../components/ui/PageContainer";
import { Tabs, TabPanel, type TabItem } from "../../components/ui/Tabs";
import { Icon } from "../../components/Icons";
import { StatusDot } from "../../components/StatusDot";
import { SITE_STATUS, type SiteStatus } from "../../components/tokens";
import type { BrandDetail } from "./tabs/types";
import { OverviewTab } from "./tabs/OverviewTab";
import { ProductsTab } from "./tabs/ProductsTab";
import { ContentTab } from "./tabs/ContentTab";
import { DistributionTab } from "./tabs/DistributionTab";
import { OrdersTab } from "./tabs/OrdersTab";
import { ResearchTab } from "./tabs/ResearchTab";
import { ActivityTab } from "./tabs/ActivityTab";
import { SettingsTab } from "./tabs/SettingsTab";

const TAB_KEYS = [
  "overview",
  "products",
  "content",
  "distribution",
  "orders",
  "research",
  "activity",
  "settings",
] as const;
type TabKey = (typeof TAB_KEYS)[number];

export default function BrandDetailPage({
  params,
}: {
  params: Promise<{ siteId: string }>;
}) {
  const { siteId: raw } = use(params);
  const siteId = raw as Id<"sites">;
  const detail = useQuery(api.dashboard.brandDetail, { siteId });
  const [tab, setTab] = useState<TabKey>("overview");

  const loading = detail === undefined;
  const site = detail?.site ?? null;
  const status = (site?.status ?? "provisioning") as SiteStatus;
  const tone = SITE_STATUS[status];

  const tabs: TabItem[] = [
    { key: "overview", label: "Overview" },
    { key: "products", label: "Products", count: detail?.productCount },
    { key: "content", label: "Content", count: detail?.reviewCreativeCount },
    { key: "distribution", label: "Distribution", count: detail?.postCount },
    { key: "orders", label: "Orders", count: detail?.orderCount },
    { key: "research", label: "Research" },
    { key: "activity", label: "Activity" },
    { key: "settings", label: "Settings" },
  ];

  if (!loading && !site) {
    return (
      <PageContainer>
        <div className="panel rounded-2xl px-6 py-20 text-center">
          <h1 className="font-display text-2xl text-ink">Brand not found</h1>
          <p className="mt-2 text-[14px] text-ink-dim">This site may have been removed.</p>
          <Link href="/" className="mt-6 inline-block text-[13px] font-medium text-signal hover:text-signal-deep">
            &larr; Back to portfolio
          </Link>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer wide>
      {/* breadcrumb-in-page (brand name) */}
      <Link
        href="/"
        className="mb-6 inline-flex items-center gap-1.5 font-mono text-[11px] text-ink-faint transition-colors hover:text-ink-dim"
      >
        <Icon.chevron size={13} className="rotate-90" /> Portfolio
      </Link>

      {/* brand identity header */}
      <header className="mb-9 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="mb-3 flex items-center gap-3">
            <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${tone.ring}`}>
              <StatusDot className={tone.dot} hex={tone.hex} live={status === "active"} size={6} />
              {tone.label}
            </span>
            {site && (
              <span className="rounded-md bg-white/[0.04] px-2 py-0.5 text-[11px] text-ink-dim ring-1 ring-white/5">
                {site.niche}
              </span>
            )}
          </div>
          <h1 className="font-display text-[2.2rem] font-medium leading-[1.05] tracking-tight text-ink sm:text-[2.85rem]">
            {loading ? "—" : site?.name}
          </h1>
          {site && (
            <p className="mt-2 font-mono text-[12px] text-ink-faint">
              {site.customDomain ?? site.shopifyDomain ?? "domain pending"} ·{" "}
              {site.distributionMode === "automated" ? "automated" : "semi-manual"}
            </p>
          )}
        </div>
        <button
          onClick={() => setTab("settings")}
          className="inline-flex w-fit items-center gap-2 rounded-full border border-line bg-panel/60 px-4 py-2.5 text-[13px] font-medium text-ink-dim transition hover:border-signal/40 hover:text-ink"
        >
          <Icon.settings size={15} /> Settings
        </button>
      </header>

      {/* tabs */}
      <Tabs items={tabs} active={tab} onChange={(k) => setTab(k as TabKey)} className="mb-8" />

      {/* panels */}
      {tab === "overview" && <TabPanel><OverviewTab siteId={siteId} detail={detail ?? undefined} /></TabPanel>}
      {tab === "products" && <TabPanel><ProductsTab siteId={siteId} /></TabPanel>}
      {tab === "content" && <TabPanel><ContentTab siteId={siteId} /></TabPanel>}
      {tab === "distribution" && <TabPanel><DistributionTab siteId={siteId} /></TabPanel>}
      {tab === "orders" && <TabPanel><OrdersTab siteId={siteId} /></TabPanel>}
      {tab === "research" && <TabPanel><ResearchTab siteId={siteId} /></TabPanel>}
      {tab === "activity" && <TabPanel><ActivityTab siteId={siteId} /></TabPanel>}
      {tab === "settings" && site && <TabPanel><SettingsTab site={site} /></TabPanel>}
    </PageContainer>
  );
}
