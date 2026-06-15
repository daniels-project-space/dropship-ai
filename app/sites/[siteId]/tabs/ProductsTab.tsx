"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DataTable, type Column } from "../../../components/ui/DataTable";
import { Badge } from "../../../components/ui/Badge";
import { Drawer } from "../../../components/ui/Drawer";
import { Icon } from "../../../components/Icons";
import { PRODUCT_STATUS, type ProductStatus, fmtUsd, contributionMargin } from "../../../components/tokens";

type ProductRow = {
  _id: Id<"products">;
  title: string;
  cjProductId?: string;
  cjFromUsWarehouse: boolean;
  cogsUsd: number;
  shippingUsd: number;
  priceUsd: number;
  contributionMarginPct?: number;
  status: ProductStatus;
};

function ProductDrawer({ row, onClose }: { row: ProductRow | null; onClose: () => void }) {
  if (!row) return null;
  const m = row.contributionMarginPct ?? contributionMargin(row.priceUsd, row.cogsUsd, row.shippingUsd);
  const t = PRODUCT_STATUS[row.status];
  return (
    <Drawer open={!!row} onClose={onClose} eyebrow="Product" title={row.title}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge ring={t.ring} dot={t.dot} hex={t.hex} live={row.status === "active"}>{t.label}</Badge>
          {row.cjFromUsWarehouse ? (
            <Badge ring="bg-live/10 text-live ring-1 ring-live/25" dot="bg-live" hex="#44d6a0">US warehouse</Badge>
          ) : (
            <Badge>CN / other</Badge>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line-soft bg-line-soft">
          {[
            ["Price", fmtUsd(row.priceUsd)],
            ["Contribution margin", m == null ? "—" : `${m.toFixed(0)}%`],
            ["COGS", fmtUsd(row.cogsUsd)],
            ["Shipping", fmtUsd(row.shippingUsd)],
            ["CJ source", row.cjProductId ? `CJ ${row.cjProductId}` : "not sourced"],
            ["Status", t.label],
          ].map(([k, val]) => (
            <div key={k} className="bg-panel px-4 py-3">
              <dt className="label-eyebrow text-[9px]">{k}</dt>
              <dd className="mt-1 font-mono text-[13px] tabular-nums text-ink">{val}</dd>
            </div>
          ))}
        </dl>
        <p className="text-[12px] leading-relaxed text-ink-faint">
          Margin is computed after COGS + shipping. Below the 70% blended floor the brain holds the
          product out of distribution.
        </p>
      </div>
    </Drawer>
  );
}

export function ProductsTab({ siteId }: { siteId: Id<"sites"> }) {
  const products = useQuery(api.products.listBySite, { siteId, limit: 200 });
  const loading = products === undefined;
  const rows = (products ?? []) as ProductRow[];
  const [active, setActive] = useState<ProductRow | null>(null);

  const columns: Column<ProductRow>[] = [
    {
      key: "title",
      header: "Product",
      sortable: true,
      sortValue: (r) => r.title.toLowerCase(),
      render: (r) => (
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line-soft bg-void/40 text-ink-faint">
            <Icon.package size={15} />
          </span>
          <div className="min-w-0">
            <p className="truncate font-medium text-ink">{r.title}</p>
            <p className="truncate font-mono text-[10px] text-ink-faint">
              {r.cjProductId ? `CJ ${r.cjProductId}` : "no CJ source"}
            </p>
          </div>
        </div>
      ),
    },
    {
      key: "source",
      header: "Source",
      hideBelow: "md",
      render: (r) =>
        r.cjFromUsWarehouse ? (
          <Badge ring="bg-live/10 text-live ring-1 ring-live/25" dot="bg-live" hex="#44d6a0">
            US warehouse
          </Badge>
        ) : (
          <Badge>CN / other</Badge>
        ),
    },
    {
      key: "cogs",
      header: "COGS",
      align: "right",
      hideBelow: "lg",
      sortable: true,
      sortValue: (r) => r.cogsUsd,
      render: (r) => <span className="font-mono tabular-nums text-ink-dim">{fmtUsd(r.cogsUsd)}</span>,
    },
    {
      key: "ship",
      header: "Ship",
      align: "right",
      hideBelow: "lg",
      render: (r) => <span className="font-mono tabular-nums text-ink-dim">{fmtUsd(r.shippingUsd)}</span>,
    },
    {
      key: "price",
      header: "Price",
      align: "right",
      sortable: true,
      sortValue: (r) => r.priceUsd,
      render: (r) => <span className="font-mono tabular-nums text-ink">{fmtUsd(r.priceUsd)}</span>,
    },
    {
      key: "margin",
      header: "Margin",
      align: "right",
      sortable: true,
      sortValue: (r) => r.contributionMarginPct ?? contributionMargin(r.priceUsd, r.cogsUsd, r.shippingUsd) ?? -1,
      render: (r) => {
        const m = r.contributionMarginPct ?? contributionMargin(r.priceUsd, r.cogsUsd, r.shippingUsd);
        if (m == null) return <span className="font-mono text-ink-faint">—</span>;
        const tone = m >= 70 ? "text-live" : m >= 50 ? "text-pending" : "text-danger";
        return <span className={`font-mono tabular-nums ${tone}`}>{m.toFixed(0)}%</span>;
      },
    },
    {
      key: "status",
      header: "Status",
      align: "right",
      render: (r) => {
        const t = PRODUCT_STATUS[r.status];
        return <Badge ring={t.ring} dot={t.dot} hex={t.hex} live={r.status === "active"}>{t.label}</Badge>;
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
        initialSort={{ key: "margin", dir: "desc" }}
        empty={{
          glyph: <Icon.package size={26} />,
          title: "No products in this catalog yet",
          body: "The brain sources US-warehouse candidates that clear the margin rubric, then proposes imports for your approval. Approved products land here with live COGS, shipping and contribution margin.",
        }}
      />
      <ProductDrawer row={active} onClose={() => setActive(null)} />
    </>
  );
}
