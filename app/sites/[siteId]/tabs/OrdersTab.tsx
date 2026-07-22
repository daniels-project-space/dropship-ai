"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DataTable, type Column } from "../../../components/ui/DataTable";
import { Badge } from "../../../components/ui/Badge";
import { Drawer } from "../../../components/ui/Drawer";
import { Icon } from "../../../components/Icons";
import { FULFILLMENT_STATUS, type FulfillmentStatus, timeAgo } from "../../../components/tokens";

type OrderRow = {
  _id: Id<"orders">;
  shopifyOrderId: string;
  cjOrderId?: string;
  fulfillmentStatus: FulfillmentStatus;
  trackingNumber?: string;
  trackingUrl?: string;
  totalUsd?: number;
  currentTotal?: number;
  currencyCode?: string;
  financialStatus?: string;
  test?: boolean;
  cancelled?: boolean;
  creditAdjustmentState?: "none" | "partial" | "full";
  createdAt: number;
};

type ApprovedSandboxAction = { _id: Id<"actions">; type: string; params: { orderId?: Id<"orders">; orderNumber?: string; isSandbox?: number; payType?: number } };

function ApprovedSandboxDispatches({ siteId }: { siteId: Id<"sites"> }) {
  const actions = useQuery(api.actions.listBySite, { siteId, status: "approved", limit: 50 });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const dispatches = ((actions ?? []) as ApprovedSandboxAction[]).filter((action) => action.type === "dispatch_cj_sandbox_order" && action.params.isSandbox === 1 && action.params.payType === 3);
  if (!dispatches.length) return null;
  async function dispatch(action: ApprovedSandboxAction) {
    setBusy(action._id); setMessage(null);
    try {
      const response = await fetch("/api/orders/dispatch-sandbox", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actionId: action._id }) });
      const result = await response.json() as { error?: string; runId?: string };
      if (!response.ok) throw new Error(result.error ?? "sandbox dispatch failed");
      setMessage(`Sandbox-only CJ dispatch queued (${result.runId ?? "existing run"}). No payment, reservation, fulfillment, or messaging is enabled.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "sandbox dispatch failed"); }
    finally { setBusy(null); }
  }
  return <section className="mb-6 rounded-2xl border border-pending/25 bg-pending/[0.04] p-5">
    <p className="label-eyebrow text-pending">Approved CJ sandbox dispatches</p>
    <p className="mt-2 text-[13px] text-ink-dim">Approval is the human gate. Start only the exact approved, create-only CJ sandbox action; customer details stay server-side.</p>
    <div className="mt-4 flex flex-col gap-2">{dispatches.map((action) => <div key={action._id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line-soft px-4 py-3"><span className="font-mono text-[11px] text-ink-faint">{action.params.orderNumber}</span><button onClick={() => dispatch(action)} disabled={busy !== null} className="rounded-lg bg-pending/15 px-3 py-2 text-[12px] font-semibold text-pending ring-1 ring-pending/30 disabled:opacity-50">{busy === action._id ? "Queueing…" : "Run CJ sandbox dispatch"}</button></div>)}</div>
    {message && <p className="mt-3 text-[12px] text-ink-dim">{message}</p>}
  </section>;
}

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
            ["Current total", row.currentTotal !== undefined && row.currencyCode ? `${row.currencyCode} ${row.currentTotal.toFixed(2)}` : "not observed"],
            ["Financial status", row.financialStatus ?? "not observed"],
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
      sortValue: (r) => r.currentTotal ?? -1,
      render: (r) => <span className="font-mono tabular-nums text-ink">{r.currentTotal !== undefined && r.currencyCode ? `${r.currencyCode} ${r.currentTotal.toFixed(2)}` : "—"}</span>,
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
      <ApprovedSandboxDispatches siteId={siteId} />
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
          body: "Orders are mirrored here once a Shopify store is connected. CJ dispatch requires an explicit approved workflow; tracking lands here through the CJ webhook after dispatch.",
        }}
      />
      <OrderDrawer row={active} onClose={() => setActive(null)} />
    </>
  );
}
