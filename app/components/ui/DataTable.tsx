"use client";

import { useMemo, useState, type ReactNode } from "react";
import { EmptyState } from "../EmptyState";

export type Column<Row> = {
  key: string;
  header: string;
  align?: "left" | "right" | "center";
  width?: string; // tailwind width class e.g. "w-28"
  sortable?: boolean;
  // value used for sorting (number/string). Falls back to no-sort if omitted.
  sortValue?: (row: Row) => number | string;
  render: (row: Row) => ReactNode;
  className?: string; // applied to the cell
  hideBelow?: "sm" | "md" | "lg"; // responsive hide
};

const HIDE: Record<NonNullable<Column<unknown>["hideBelow"]>, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
};

// Sortable, empty-state-aware table. Mono eyebrow headers, hairline rows,
// tabular-nums data, hover wash. Sorting is client-side on `sortValue`.
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  onRowClick,
  loading = false,
  empty,
  initialSort,
}: {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row, i: number) => string;
  onRowClick?: (row: Row) => void;
  loading?: boolean;
  empty: { glyph: ReactNode; title: string; body: string; children?: ReactNode };
  initialSort?: { key: string; dir: "asc" | "desc" };
}) {
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(
    initialSort ?? null,
  );

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = col.sortValue!(a);
      const bv = col.sortValue!(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [rows, sort, columns]);

  function toggleSort(col: Column<Row>) {
    if (!col.sortable || !col.sortValue) return;
    setSort((s) =>
      s?.key === col.key
        ? { key: col.key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key: col.key, dir: "desc" },
    );
  }

  if (loading) {
    return (
      <div className="panel overflow-hidden rounded-2xl">
        <div className="flex flex-col gap-px">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="shimmer h-[52px]" />
          ))}
        </div>
      </div>
    );
  }

  if (!rows.length) {
    return (
      <EmptyState glyph={empty.glyph} title={empty.title} body={empty.body}>
        {empty.children}
      </EmptyState>
    );
  }

  return (
    <div className="panel overflow-hidden rounded-2xl">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-line">
              {columns.map((c) => {
                const active = sort?.key === c.key;
                const alignCls =
                  c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left";
                return (
                  <th
                    key={c.key}
                    className={`label-eyebrow whitespace-nowrap px-4 py-3 text-[9.5px] font-medium ${alignCls} ${
                      c.width ?? ""
                    } ${c.hideBelow ? HIDE[c.hideBelow] : ""} ${
                      c.sortable && c.sortValue ? "cursor-pointer select-none transition-colors hover:text-ink-dim" : ""
                    }`}
                    onClick={() => toggleSort(c)}
                  >
                    <span className={`inline-flex items-center gap-1 ${c.align === "right" ? "flex-row-reverse" : ""}`}>
                      {c.header}
                      {c.sortable && c.sortValue && (
                        <span className={`text-[8px] leading-none ${active ? "text-signal" : "text-ink-faint/50"}`}>
                          {active ? (sort!.dir === "asc" ? "▲" : "▼") : "▾"}
                        </span>
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => (
              <tr
                key={rowKey(row, i)}
                onClick={() => onRowClick?.(row)}
                className={`border-b border-line-soft/70 transition-colors last:border-0 ${
                  onRowClick ? "cursor-pointer hover:bg-white/[0.025]" : ""
                }`}
              >
                {columns.map((c) => {
                  const alignCls =
                    c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left";
                  return (
                    <td
                      key={c.key}
                      className={`px-4 py-3.5 text-[13px] text-ink ${alignCls} ${
                        c.hideBelow ? HIDE[c.hideBelow] : ""
                      } ${c.className ?? ""}`}
                    >
                      {c.render(row)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
