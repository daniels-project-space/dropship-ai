"use client";

import type { Id } from "@/convex/_generated/dataModel";
import { CommandCenter } from "../../../components/CommandCenter";
import type { BrandDetail } from "./types";

// Per-brand Overview = the Command Center scoped to this site. All KPI tiles,
// charts, funnel, content-fit gauge, platform breakdown, top products, insights
// and activity re-query against this siteId and respond to the timeframe /
// platform controls. (detail is accepted for parity with the tab API.)
export function OverviewTab({ siteId }: { siteId: Id<"sites">; detail?: BrandDetail | undefined }) {
  return <CommandCenter scope={siteId} />;
}
