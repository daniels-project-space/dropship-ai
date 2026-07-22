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
      {detail?.economicsReadiness === "needs_reverification" && (
        <div className="mb-5 rounded-xl border border-pending/30 bg-pending/5 px-4 py-3 text-[12px] leading-relaxed text-pending">
          Shopify recurring access, store currency, and current order economics need re-verification. Zero values below are not launch-ready revenue evidence.
        </div>
      )}
      <CommandCenter scope={siteId} />
    </>
  );
}
