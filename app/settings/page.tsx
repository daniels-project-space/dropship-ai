"use client";

import { PageContainer } from "../components/ui/PageContainer";
import { SectionHeader } from "../components/ui/SectionHeader";
import { Badge } from "../components/ui/Badge";
import { Icon } from "../components/Icons";

function Row({ label, hint, connected }: { label: string; hint: string; connected: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-line-soft bg-void/30 px-4 py-3.5">
      <div className="min-w-0">
        <p className="text-[13px] text-ink">{label}</p>
        <p className="font-mono text-[10px] text-ink-faint">{hint}</p>
      </div>
      {connected ? (
        <Badge ring="bg-live/10 text-live ring-1 ring-live/25" dot="bg-live" hex="#44d6a0" live>Connected</Badge>
      ) : (
        <Badge>Not connected</Badge>
      )}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <PageContainer>
      <section className="mb-10">
        <div className="mb-4 flex items-center gap-2">
          <span className="label-eyebrow text-signal">Settings</span>
          <span className="h-px w-12 bg-line" />
        </div>
        <h1 className="font-display text-[2.2rem] font-medium leading-[1.05] tracking-tight text-ink sm:text-[2.85rem]">
          System &amp;
          <span className="italic text-signal"> integrations</span>
        </h1>
        <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-ink-dim">
          Account-wide connections and brain configuration. Per-brand guardrails (margin floors, kill
          dates, distribution mode) live on each brand&apos;s Settings tab.
        </p>
      </section>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <div>
          <SectionHeader eyebrow="Platform integrations" accent="text-cyan" />
          <div className="flex flex-col gap-2.5">
            <Row label="CJ Dropshipping" hint="sourcing + fulfillment" connected={false} />
            <Row label="Ayrshare" hint="automated social publishing" connected={false} />
            <Row label="Higgsfield" hint="creative generation" connected />
            <Row label="Trigger.dev" hint="orchestration + waitpoints" connected />
          </div>
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
