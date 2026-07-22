"use client";

import type { Id } from "@/convex/_generated/dataModel";
import { CommandCenter } from "../../../components/CommandCenter";
import type { BrandDetail } from "./types";

// Per-brand Overview = the Command Center scoped to this site. All KPI tiles,
// charts, funnel, content-fit gauge, platform breakdown, top products, insights
// and activity re-query against this siteId and respond to the timeframe /
// platform controls. (detail is accepted for parity with the tab API.)
export function OverviewTab({ siteId, detail }: { siteId: Id<"sites">; detail?: BrandDetail | undefined }) {
  return (
    <>
      {detail && detail.economicsReadiness !== "current" && (
        <div className="mb-5 rounded-xl border border-pending/30 bg-pending/5 px-4 py-3 text-[12px] leading-relaxed text-pending">
          Shopify economics sync is {detail.economicsReadiness.replaceAll("_", " ")}. Zero values below are not launch-ready revenue evidence until a complete current catalogue and order sync succeeds.
        </div>
      )}
      <CommandCenter scope={siteId} />
    </>
  );
}
