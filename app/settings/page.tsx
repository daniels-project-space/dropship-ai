"use client";

import { useEffect, useState } from "react";
import { PageContainer } from "../components/ui/PageContainer";
import { SectionHeader } from "../components/ui/SectionHeader";
import { Badge } from "../components/ui/Badge";
import { StatusDot } from "../components/StatusDot";
import { Icon } from "../components/Icons";

type ReadyState = "ready" | "action_needed" | "warn";
type CheckItem = {
  id: string;
  group: string;
  label: string;
  state: ReadyState;
  detail: string;
  next: string;
};
type StatusResponse = {
  checkedAt: number;
  summary: { total: number; ready: number; warn: number; blocking: number; goLive: boolean };
  checks: CheckItem[];
};

const STATE_TONE: Record<ReadyState, { ring: string; dot: string; hex: string; label: string }> = {
  ready: { ring: "bg-live/10 text-live ring-1 ring-live/25", dot: "bg-live", hex: "#44d6a0", label: "Ready" },
  warn: { ring: "bg-pending/10 text-pending ring-1 ring-pending/30", dot: "bg-pending", hex: "#f0a93b", label: "Verify" },
  action_needed: { ring: "bg-danger/10 text-danger ring-1 ring-danger/25", dot: "bg-danger", hex: "#ef6b6b", label: "Action needed" },
};

const GROUP_ACCENT: Record<string, string> = {
  Distribution: "text-cyan",
  Orchestration: "text-violet",
  Generation: "text-signal",
  Commerce: "text-live",
};

function CheckRow({ item }: { item: CheckItem }) {
  const tone = STATE_TONE[item.state];
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-line-soft bg-void/30 px-4 py-3.5">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-1 shrink-0">
          <StatusDot className={tone.dot} hex={tone.hex} live={item.state === "ready"} size={7} />
        </span>
        <div className="min-w-0">
          <p className="text-[13.5px] text-ink">{item.label}</p>
          <p className="mt-0.5 font-mono text-[10.5px] text-ink-faint">{item.detail}</p>
          {item.state !== "ready" && (
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-dim">
              <span className="text-ink-faint">Next →</span> {item.next}
            </p>
          )}
        </div>
      </div>
      <Badge ring={tone.ring} dot={tone.dot} hex={tone.hex} live={item.state === "ready"}>
        {tone.label}
      </Badge>
    </div>
  );
}

function ReadinessHeader({ status, loading }: { status: StatusResponse | null; loading: boolean }) {
  const goLive = status?.summary.goLive ?? false;
  const blocking = status?.summary.blocking ?? 0;
  return (
    <div className={`panel relative overflow-hidden rounded-2xl p-6 sm:p-8 ${goLive ? "ring-1 ring-live/30" : ""}`}>
      <div
        aria-hidden
        className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full blur-3xl"
        style={{ background: goLive ? "rgba(68,214,160,0.14)" : "rgba(239,107,107,0.08)" }}
      />
      <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-md">
          <div className="mb-3 flex items-center gap-2">
            <span className="label-eyebrow text-signal">Go-live readiness</span>
            <span className="h-px w-10 bg-line" />
          </div>
          <div className="flex items-center gap-3">
            <StatusDot className={goLive ? "bg-live" : "bg-danger"} hex={goLive ? "#44d6a0" : "#ef6b6b"} live={goLive} size={10} />
            <h2 className="font-display text-3xl font-medium tracking-tight text-ink sm:text-[2.4rem]">
              {loading ? "Checking…" : goLive ? "Cleared for launch" : "Blocked"}
            </h2>
          </div>
          <p className="mt-3 text-[14px] leading-relaxed text-ink-dim">
            {loading
              ? "Probing the vault and live integrations…"
              : goLive
                ? "Every required connection is live. The brain can source, build, distribute and fulfil end-to-end."
                : `${blocking} connection${blocking === 1 ? "" : "s"} ${blocking === 1 ? "is" : "are"} blocking go-live. Clear the red items below.`}
          </p>
        </div>
        <div className="flex shrink-0 items-stretch gap-3">
          {[
            { k: "ready", label: "Ready", color: "text-live" },
            { k: "warn", label: "Verify", color: "text-pending" },
            { k: "blocking", label: "Blocking", color: "text-danger" },
          ].map((c) => (
            <div key={c.k} className="flex min-w-[88px] flex-col justify-center rounded-xl border border-line bg-panel-2/60 px-5 py-4">
              <span className={`font-display text-4xl font-medium tabular-nums leading-none ${c.color}`}>
                {loading ? "—" : (status?.summary as unknown as Record<string, number>)?.[c.k] ?? 0}
              </span>
              <span className="label-eyebrow mt-2 text-[9.5px]">{c.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/status", { cache: "no-store" });
        const d = await r.json();
        if (r.ok) setStatus(d as StatusResponse);
        else setError(d?.error ?? "Could not read connection status");
      } catch {
        setError("Network error reading connection status");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const groups = ["Distribution", "Orchestration", "Generation", "Commerce"];
  const byGroup = (g: string) => (status?.checks ?? []).filter((c) => c.group === g);

  return (
    <PageContainer>
      <section className="mb-10">
        <div className="mb-4 flex items-center gap-2">
          <span className="label-eyebrow text-signal">Settings</span>
          <span className="h-px w-12 bg-line" />
        </div>
        <h1 className="font-display text-[2.2rem] font-medium leading-[1.05] tracking-tight text-ink sm:text-[2.85rem]">
          Connections &amp;
          <span className="italic text-signal"> go-live readiness</span>
        </h1>
        <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-ink-dim">
          The single source of truth for what is blocking launch. Each row is checked live against the
          vault and the real integrations — connection state only, never a secret. Green means ready;
          anything else carries the exact next step.
        </p>
      </section>

      <ReadinessHeader status={status} loading={loading} />

      {error && (
        <div className="mt-6 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 font-mono text-[12px] text-danger">
          {error}
        </div>
      )}

      <div className="mt-12 grid grid-cols-1 gap-x-8 gap-y-10 lg:grid-cols-2">
        {groups.map((g) => {
          const items = byGroup(g);
          return (
            <div key={g}>
              <SectionHeader eyebrow={g} accent={GROUP_ACCENT[g] ?? "text-ink-faint"} meta={loading ? undefined : `${items.length} checks`} />
              {loading ? (
                <div className="flex flex-col gap-2.5">
                  {[0, 1].map((i) => <div key={i} className="shimmer h-[68px] rounded-xl" />)}
                </div>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {items.map((it) => <CheckRow key={it.id} item={it} />)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* global defaults + brain */}
      <div className="mt-14 grid grid-cols-1 gap-8 lg:grid-cols-2">
        <div>
          <SectionHeader eyebrow="Global defaults" accent="text-violet" />
          <div className="panel flex flex-col gap-px overflow-hidden rounded-2xl">
            {[
              ["Distribution mode (cold-start)", "semi-manual until Ayrshare linked"],
              ["Min blended margin floor", "70% (per-brand override on brand Settings)"],
              ["AI-disclosure label", "mandatory · burned into every AI frame"],
              ["Risk policy", "money / ban-risk moves human-gated"],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-4 bg-panel px-5 py-4">
                <span className="text-[13px] text-ink-dim">{k}</span>
                <span className="text-right font-mono text-[11px] text-ink-faint">{v}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-ink-faint">
            These are account-wide. Per-brand guardrails (kit-price floor, kill date, distribution mode)
            live on each brand&apos;s Settings tab and override these where set.
          </p>
        </div>
        <div>
          <SectionHeader eyebrow="Brain" accent="text-violet" />
          <div className="panel flex flex-col gap-4 rounded-2xl p-6">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-violet/10 text-violet">
                <Icon.spark size={16} />
              </span>
              <div>
                <p className="text-[14px] text-ink">Risk-tiered autonomy</p>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-faint">
                  Auto-tier actions run without stopping. Money- and ban-risk moves are human-gated and
                  pause on a Trigger waitpoint until you approve them.
                </p>
              </div>
            </div>
            <div className="border-t border-line-soft pt-4">
              <Badge ring="bg-live/10 text-live ring-1 ring-live/25" dot="bg-live" hex="#44d6a0" live>
                Brain online
              </Badge>
            </div>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
