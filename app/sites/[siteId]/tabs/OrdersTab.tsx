"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DataTable, type Column } from "../../../components/ui/DataTable";
import { Badge } from "../../../components/ui/Badge";
import { Icon } from "../../../components/Icons";
import { FULFILLMENT_STATUS, type FulfillmentStatus, fmtUsd, timeAgo } from "../../../components/tokens";

type OrderRow = {
  _id: Id<"orders">;
  shopifyOrderId: string;
  cjOrderId?: string;
  fulfillmentStatus: FulfillmentStatus;
  trackingNumber?: string;
  trackingUrl?: string;
  totalUsd: number;
  createdAt: number;
};

export function OrdersTab({ siteId }: { siteId: Id<"sites"> }) {
  const orders = useQuery(api.orders.listBySite, { siteId, limit: 200 });
  const loading = orders === undefined;
  const rows = (orders ?? []) as OrderRow[];

  const columns: Column<OrderRow>[] = [
    {
      key: "order",
      header: "Order",
      render: (r) => (
        <div className="min-w-0">
          <p className="truncate font-mono text-[12px] text-ink">#{r.shopifyOrderId}</p>
          <p className="truncate font-mono text-[10px] text-ink-faint">{r.cjOrderId ? `CJ ${r.cjOrderId}` : "not dispatched"}</p>
        </div>
      ),
    },
    {
      key: "total",
      header: "Total",
      align: "right",
      sortable: true,
      sortValue: (r) => r.totalUsd,
      render: (r) => <span className="font-mono tabular-nums text-ink">{fmtUsd(r.totalUsd)}</span>,
    },
    {
      key: "tracking",
      header: "Tracking",
      hideBelow: "md",
      render: (r) =>
        r.trackingNumber ? (
          <a
            href={r.trackingUrl ?? "#"}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 font-mono text-[11px] text-cyan hover:text-ink"
          >
            {r.trackingNumber} <Icon.external size={12} />
          </a>
        ) : (
          <span className="font-mono text-[11px] text-ink-faint">—</span>
        ),
    },
    {
      key: "age",
      header: "Received",
      align: "right",
      hideBelow: "lg",
      sortable: true,
      sortValue: (r) => r.createdAt,
      render: (r) => <span className="font-mono text-[11px] text-ink-faint">{timeAgo(r.createdAt)}</span>,
    },
    {
      key: "status",
      header: "Fulfillment",
      align: "right",
      render: (r) => {
        const t = FULFILLMENT_STATUS[r.fulfillmentStatus];
        return <Badge ring={t.ring} dot={t.dot} hex={t.hex} live={r.fulfillmentStatus === "delivered"}>{t.label}</Badge>;
      },
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      loading={loading}
      rowKey={(r) => r._id}
      initialSort={{ key: "age", dir: "desc" }}
      empty={{
        glyph: <Icon.truck size={26} />,
        title: "No orders yet",
        body: "Orders flow in once a Shopify store is connected. Each order auto-dispatches to CJ for fulfillment, and tracking lands here via the CJ webhook — nothing to do until then.",
      }}
    />
  );
}
