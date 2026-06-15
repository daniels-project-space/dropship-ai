"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ActivityFeed, type AuditEntry } from "../../../components/ui/ActivityFeed";
import { EmptyState } from "../../../components/EmptyState";
import { Icon } from "../../../components/Icons";

export function ActivityTab({ siteId }: { siteId: Id<"sites"> }) {
  const log = useQuery(api.audit.listBySite, { siteId, limit: 100 });
  const loading = log === undefined;
  const entries = (log ?? []) as AuditEntry[];

  if (loading) {
    return (
      <div className="panel rounded-2xl p-6">
        <div className="flex flex-col gap-3">
          {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="shimmer h-9 rounded-lg" />)}
        </div>
      </div>
    );
  }

  if (!entries.length) {
    return (
      <EmptyState
        glyph={<Icon.activity size={26} />}
        title="No activity recorded yet"
        body="Every proposed, approved and executed action lands in this append-only ledger — along with content, distribution and order events. The feed fills as the brand's loop runs."
      />
    );
  }

  return (
    <div className="panel rounded-2xl p-6 sm:p-7">
      <ActivityFeed entries={entries} />
    </div>
  );
}
