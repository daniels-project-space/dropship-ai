"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DataTable, type Column } from "../../../components/ui/DataTable";
import { Badge } from "../../../components/ui/Badge";
import { Drawer } from "../../../components/ui/Drawer";
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

function OrderDrawer({ row, onClose }: { row: OrderRow | null; onClose: () => void }) {
  if (!row) return null;
  const t = FULFILLMENT_STATUS[row.fulfillmentStatus];
  return (
    <Drawer open={!!row} onClose={onClose} eyebrow="Order" title={<span className="font-mono">#{row.shopifyOrderId}</span>}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge ring={t.ring} dot={t.dot} hex={t.hex} live={row.fulfillmentStatus === "delivered"}>{t.label}</Badge>
        </div>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line-soft bg-line-soft">
          {[
            ["Order total", fmtUsd(row.totalUsd)],
            ["Received", timeAgo(row.createdAt)],
            ["Shopify ID", `#${row.shopifyOrderId}`],
            ["CJ order", row.cjOrderId ? `CJ ${row.cjOrderId}` : "not dispatched"],
          ].map(([k, val]) => (
            <div key={k} className="bg-panel px-4 py-3">
              <dt className="label-eyebrow text-[9px]">{k}</dt>
              <dd className="mt-1 font-mono text-[13px] tabular-nums text-ink">{val}</dd>
            </div>
          ))}
        </dl>
        <div className="rounded-xl border border-line-soft bg-panel px-4 py-3">
          <span className="label-eyebrow text-[9px]">Tracking</span>
          {row.trackingNumber ? (
            <a
              href={row.trackingUrl ?? "#"}
              target="_blank"
              rel="noreferrer"
              className="mt-1.5 inline-flex items-center gap-1.5 font-mono text-[12px] text-cyan hover:text-ink"
            >
              {row.trackingNumber} <Icon.external size={12} />
            </a>
          ) : (
            <p className="mt-1.5 font-mono text-[12px] text-ink-faint">Awaiting CJ tracking webhook.</p>
          )}
        </div>
      </div>
    </Drawer>
  );
}

export function OrdersTab({ siteId }: { siteId: Id<"sites"> }) {
  const orders = useQuery(api.orders.listBySite, { siteId, limit: 200 });
  const loading = orders === undefined;
  const rows = (orders ?? []) as OrderRow[];
  const [active, setActive] = useState<OrderRow | null>(null);

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
    <>
      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        rowKey={(r) => r._id}
        onRowClick={(r) => setActive(r)}
        initialSort={{ key: "age", dir: "desc" }}
        empty={{
          glyph: <Icon.truck size={26} />,
          title: "No orders yet",
          body: "Orders flow in once a Shopify store is connected. Each order auto-dispatches to CJ for fulfillment, and tracking lands here via the CJ webhook — nothing to do until then.",
        }}
      />
      <OrderDrawer row={active} onClose={() => setActive(null)} />
    </>
  );
}
