import type { Id } from "@/convex/_generated/dataModel";
import type { SiteStatus } from "../../../components/tokens";

// Shape returned by api.dashboard.brandDetail (kept in sync with convex/dashboard.ts).
export type BrandDetail = {
  site: {
    _id: Id<"sites">;
    name: string;
    niche: string;
    status: SiteStatus;
    shopifyDomain?: string;
    storeCurrency?: string;
    shopifyAccessVerifiedAt?: number;
    shopifyEconomicsSyncStatus?: "pending" | "current" | "failed" | "incomplete";
    shopifyEconomicsSyncAttemptedAt?: number;
    shopifyEconomicsSyncSucceededAt?: number;
    customDomain?: string;
    minKitPriceUsd: number;
    minBlendedMarginPct: number;
    distributionMode: "semi_manual" | "automated";
    killDate?: number;
    createdAt: number;
  };
  economicsReadiness: "not_connected" | "needs_reverification" | "pending" | "current" | "stale" | "failed" | "incomplete";
  productCount: number;
  activeProductCount: number;
  pendingActionCount: number;
  postCount: number;
  publishedPostCount: number;
  openOrderCount: number;
  orderCount: number;
  reviewCreativeCount: number;
  totalViews: number;
  revenueUsd: number;
};
