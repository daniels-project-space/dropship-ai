"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

// Honesty marker — a small amber "SAMPLE DATA" pill shown whenever seeded demo
// data is present (dashboard.sampleStatus.present). "Clear" calls
// clearSampleData, which removes ONLY sample-flagged sites + their children.
// Disappears automatically once real data replaces the sample set.
export function SampleDataPill({ compact = false }: { compact?: boolean }) {
  const status = useQuery(api.dashboard.sampleStatus, {});
  const clear = useMutation(api.seed.clearSampleData);
  const [clearing, setClearing] = useState(false);

  if (!status?.present) return null;

  async function onClear() {
    if (clearing) return;
    setClearing(true);
    try {
      await clear({});
    } finally {
      setClearing(false);
    }
  }

  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border border-signal/30 bg-signal/10 px-2.5 py-1"
      title={`Seeded demo data present: ${status.sampleSiteNames.join(", ")}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-signal" />
      <span className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-signal">
        Sample data{compact ? "" : ` · ${status.sampleSiteCount} brand${status.sampleSiteCount > 1 ? "s" : ""}`}
      </span>
      <button
        onClick={onClear}
        disabled={clearing}
        className="rounded-full px-1.5 font-mono text-[9.5px] uppercase tracking-wider text-signal/80 underline-offset-2 transition hover:text-signal hover:underline disabled:opacity-50"
      >
        {clearing ? "clearing…" : "clear"}
      </button>
    </span>
  );
}
