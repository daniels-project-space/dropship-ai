"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { Badge } from "../../../components/ui/Badge";
import { Icon } from "../../../components/Icons";
import type { BrandDetail } from "./types";

const FIELD =
  "w-full rounded-lg border border-line bg-void/60 px-3.5 py-2.5 text-[14px] text-ink placeholder:text-ink-faint outline-none transition focus:border-signal/50 focus:ring-2 focus:ring-signal/15";
const LABEL = "label-eyebrow mb-2 block text-[10px]";

// ── Connect Shopify card ─────────────────────────────────────────────────────
// Not connected → domain + admin token form → POST /api/shopify/connect.
// Recurring access verified → domain, current economic counts, "Sync now".
// Legacy domain only        → visible re-verification form; never presented as connected.
function ConnectShopifyCard({ site }: { site: BrandDetail["site"] }) {
  const detail = useQuery(api.dashboard.brandDetail, { siteId: site._id as Id<"sites"> });
  const recurringVerified = !!site.shopifyDomain && site.storeCurrency === "USD" && !!site.shopifyAccessVerifiedAt;
  const needsReverification = !!site.shopifyDomain && !recurringVerified;
  const economicsSync = detail?.economicsReadiness ?? "pending";

  const [domain, setDomain] = useState(site.shopifyDomain ?? "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    | { kind: "ok"; shopName: string; products: number; orders: number; currency?: string }
    | { kind: "err"; text: string }
    | null
  >(null);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/shopify/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: site._id, shopifyDomain: domain.trim(), accessToken: token.trim() }),
      });
      const data = await res.json();
      if (!res.ok && res.status !== 207) {
        setResult({ kind: "err", text: data.error ?? `Connect failed (HTTP ${res.status})` });
      } else if (data.syncError) {
        setResult({ kind: "err", text: `Connected, but initial sync failed: ${data.syncError}. Try “Sync now”.` });
      } else {
        setResult({
          kind: "ok",
          shopName: data.shop?.name ?? domain,
          products: data.productCount ?? 0,
          orders: data.orderCount ?? 0,
          currency: data.currency,
        });
        setToken("");
      }
    } catch (err) {
      setResult({ kind: "err", text: err instanceof Error ? err.message : "Connect failed" });
    } finally {
      setBusy(false);
    }
  }

  async function syncNow() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/shopify/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: site._id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResult({ kind: "err", text: data.error ?? `Sync failed (HTTP ${res.status})` });
      } else {
        setResult({ kind: "ok", shopName: site.shopifyDomain ?? "", products: data.productCount ?? 0, orders: data.orderCount ?? 0 });
      }
    } catch (err) {
      setResult({ kind: "err", text: err instanceof Error ? err.message : "Sync failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel rounded-2xl p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon.store size={15} className="text-cyan" />
          <span className="text-[13px] font-medium text-ink">Shopify store</span>
        </div>
        {recurringVerified ? (
          <Badge ring="bg-live/10 text-live ring-1 ring-live/25" dot="bg-live" hex="#44d6a0" live>
            Recurring access verified
          </Badge>
        ) : needsReverification ? (
          <Badge ring="bg-pending/10 text-pending ring-1 ring-pending/30" dot="bg-pending" hex="#f0a93b">
            Needs re-verification
          </Badge>
        ) : (
          <Badge>Not connected</Badge>
        )}
      </div>

      {recurringVerified ? (
        <div className="flex flex-col gap-3">
          <p className="font-mono text-[11px] text-ink-dim">{site.shopifyDomain}</p>
          <p className={`rounded-lg border px-3 py-2 text-[11px] ${economicsSync === "current" ? "border-live/25 bg-live/5 text-live" : "border-pending/25 bg-pending/5 text-pending"}`}>
            Economics sync: {economicsSync.replaceAll("_", " ")}. {economicsSync === "current" ? "Complete bounded catalogue and commerce writes are current." : "Revenue and zero-order values are not launch-ready evidence."}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-line-soft bg-void/30 px-3 py-2.5">
              <span className="label-eyebrow text-[9px]">Products</span>
              <p className="mt-0.5 font-mono text-[15px] tabular-nums text-ink">{detail?.productCount ?? "—"}</p>
            </div>
            <div className="rounded-lg border border-line-soft bg-void/30 px-3 py-2.5">
              <span className="label-eyebrow text-[9px]">Orders</span>
              <p className="mt-0.5 font-mono text-[15px] tabular-nums text-ink">{detail?.orderCount ?? "—"}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={syncNow}
            disabled={busy}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-line bg-void/40 px-4 py-2.5 text-[13px] font-medium text-ink-dim transition hover:border-signal/40 hover:text-ink disabled:opacity-50"
          >
            <Icon.refresh size={14} /> {busy ? "Syncing…" : "Sync now"}
          </button>
          {result?.kind === "ok" && (
            <p className="font-mono text-[10px] text-live">
              Synced {result.products} product{result.products === 1 ? "" : "s"} · {result.orders} order{result.orders === 1 ? "" : "s"}
            </p>
          )}
          {result?.kind === "err" && <p className="font-mono text-[10px] text-danger">{result.text}</p>}
          <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-faint">
            <Icon.lock size={12} className="mt-0.5 shrink-0" />
            Recurring vault access and USD store identity were verified. Sync remains read-only.
          </p>
        </div>
      ) : (
        <form onSubmit={connect} className="flex flex-col gap-3">
          {needsReverification && (
            <p className="rounded-lg border border-pending/25 bg-pending/5 px-3 py-2 text-[11px] leading-relaxed text-pending">
              This legacy connection has no current recurring-access/currency proof. Re-verify it before revenue or order readiness is shown.
            </p>
          )}
          <div>
            <label className={LABEL}>*.myshopify.com domain</label>
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="calm-collar.myshopify.com"
              className={FIELD}
              autoComplete="off"
            />
          </div>
          <div>
            <label className={LABEL}>Admin API access token</label>
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="shpat_…"
              type="password"
              className={FIELD}
              autoComplete="off"
            />
            <p className="mt-1.5 font-mono text-[9.5px] text-ink-faint">
              Needs read_products and read_orders. First place this same token at the displayed store&apos;s deterministic server-vault reference; a one-time token check alone does not connect the site.
            </p>
          </div>
          <button
            type="submit"
            disabled={busy || !domain.trim() || !token.trim()}
            className="rounded-lg bg-signal px-5 py-2.5 text-[14px] font-semibold text-void transition hover:bg-signal-deep disabled:opacity-50"
          >
            {busy ? "Verifying…" : needsReverification ? "Verify recurring access" : "Connect recurring access"}
          </button>
          {result?.kind === "ok" && (
            <p className="font-mono text-[10px] text-live">
              {result.shopName} recurring access verified · {result.products} products · {result.orders} orders
              {result.currency ? ` · ${result.currency}` : ""}
            </p>
          )}
          {result?.kind === "err" && <p className="font-mono text-[10px] text-danger">{result.text}</p>}
        </form>
      )}
    </div>
  );
}

type Site = BrandDetail["site"];

function ConnRow({ label, hint, connected }: { label: string; hint: string; connected: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-line-soft bg-void/30 px-4 py-3">
      <div className="min-w-0">
        <p className="text-[13px] text-ink">{label}</p>
        <p className="font-mono text-[10px] text-ink-faint">{hint}</p>
      </div>
      {connected ? (
        <Badge ring="bg-live/10 text-live ring-1 ring-live/25" dot="bg-live" hex="#44d6a0" live>
          Connected
        </Badge>
      ) : (
        <Badge>Not connected</Badge>
      )}
    </div>
  );
}

export function SettingsTab({ site }: { site: Site }) {
  const update = useMutation(api.sites.update);
  const [distributionMode, setDistributionMode] = useState<Site["distributionMode"]>(site.distributionMode);
  const [minKitPriceUsd, setMinKitPriceUsd] = useState(String(site.minKitPriceUsd));
  const [minBlendedMarginPct, setMinBlendedMarginPct] = useState(String(site.minBlendedMarginPct));
  const [killDate, setKillDate] = useState(
    site.killDate ? new Date(site.killDate).toISOString().slice(0, 10) : "",
  );
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      await update({
        siteId: site._id as Id<"sites">,
        distributionMode,
        minKitPriceUsd: Number(minKitPriceUsd),
        minBlendedMarginPct: Number(minBlendedMarginPct),
        killDate: killDate ? new Date(killDate).getTime() : undefined,
      });
      setMsg({ kind: "ok", text: "Saved" });
    } catch (err) {
      setMsg({ kind: "err", text: err instanceof Error ? err.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
      {/* guardrails form */}
      <form onSubmit={save}>
        <SectionHeader eyebrow="Guardrails" accent="text-signal" />
        <div className="panel grid grid-cols-1 gap-5 rounded-2xl p-6 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={LABEL}>Distribution mode</label>
            <div className="grid grid-cols-2 gap-2">
              {(["semi_manual", "automated"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setDistributionMode(mode)}
                  className={`rounded-lg border px-3 py-2.5 text-[13px] font-medium transition ${
                    distributionMode === mode
                      ? "border-signal/50 bg-signal/10 text-signal"
                      : "border-line bg-void/40 text-ink-dim hover:text-ink"
                  }`}
                >
                  {mode === "semi_manual" ? "Semi-manual" : "Automated"}
                </button>
              ))}
            </div>
            <p className="mt-2 font-mono text-[10px] leading-relaxed text-ink-faint">
              Automated never means approval-free: every creative still needs a separate exact publication authorization, verified target accounts, and the deployment live-effects acknowledgement.
            </p>
          </div>
          <div>
            <label className={LABEL}>Min kit price (USD)</label>
            <input type="number" min={1} value={minKitPriceUsd} onChange={(e) => setMinKitPriceUsd(e.target.value)} className={FIELD} />
          </div>
          <div>
            <label className={LABEL}>Min blended margin (%)</label>
            <input type="number" min={1} max={100} value={minBlendedMarginPct} onChange={(e) => setMinBlendedMarginPct(e.target.value)} className={FIELD} />
          </div>
          <div className="sm:col-span-2">
            <label className={LABEL}>Pre-committed kill date</label>
            <input type="date" value={killDate} onChange={(e) => setKillDate(e.target.value)} className={FIELD} />
            <p className="mt-2 font-mono text-[10px] text-ink-faint">
              The date this brand is killed if it hasn&apos;t proven content fit. Leave blank for none.
            </p>
          </div>

          <div className="sm:col-span-2 flex items-center justify-end gap-3">
            {msg && (
              <span className={`font-mono text-[11px] ${msg.kind === "ok" ? "text-live" : "text-danger"}`}>{msg.text}</span>
            )}
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-signal px-5 py-2.5 text-[14px] font-semibold text-void transition hover:bg-signal-deep disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save guardrails"}
            </button>
          </div>
        </div>
      </form>

      {/* connected accounts */}
      <aside>
        <SectionHeader eyebrow="Connected accounts" accent="text-cyan" />
        <ConnectShopifyCard site={site} />
        <div className="mt-2.5 flex flex-col gap-2.5">
          <ConnRow label="CJ Dropshipping" hint="fulfillment + tracking" connected={false} />
          <ConnRow label="Ayrshare" hint="automated publishing" connected={false} />
          <ConnRow label="Custom domain" hint={site.customDomain ?? "not set"} connected={!!site.customDomain} />
        </div>
        <p className="mt-4 flex items-start gap-2 text-[12px] leading-relaxed text-ink-faint">
          <Icon.settings size={14} className="mt-0.5 shrink-0" />
          Account rows are configuration hints, not verification. Use launch readiness for fresh proof; publication always retains its separate exact operator authorization.
        </p>
      </aside>
    </div>
  );
}
