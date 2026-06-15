"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { Badge } from "../../../components/ui/Badge";
import { Icon } from "../../../components/Icons";
import type { BrandDetail } from "./types";

const FIELD =
  "w-full rounded-lg border border-line bg-void/60 px-3.5 py-2.5 text-[14px] text-ink placeholder:text-ink-faint outline-none transition focus:border-signal/50 focus:ring-2 focus:ring-signal/15";
const LABEL = "label-eyebrow mb-2 block text-[10px]";

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
        <div className="flex flex-col gap-2.5">
          <ConnRow label="Shopify store" hint={site.shopifyDomain ?? "*.myshopify.com"} connected={!!site.shopifyDomain} />
          <ConnRow label="CJ Dropshipping" hint="fulfillment + tracking" connected={false} />
          <ConnRow label="Ayrshare" hint="automated publishing" connected={false} />
          <ConnRow label="Custom domain" hint={site.customDomain ?? "not set"} connected={!!site.customDomain} />
        </div>
        <p className="mt-4 flex items-start gap-2 text-[12px] leading-relaxed text-ink-faint">
          <Icon.settings size={14} className="mt-0.5 shrink-0" />
          Connection wiring lands in a later pass. Until a store is connected, distribution stays semi-manual.
        </p>
      </aside>
    </div>
  );
}
