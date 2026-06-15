"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { CreativeCard, type ReviewCreative } from "../../../components/CreativeCard";
import { EmptyState } from "../../../components/EmptyState";
import { Icon } from "../../../components/Icons";

export function ContentTab({ siteId }: { siteId: Id<"sites"> }) {
  // all creatives for this brand (any status) so approved/rejected history shows too
  const creatives = useQuery(api.creatives.listByStatus, { siteId, limit: 100 });
  const loading = creatives === undefined;
  const rows = (creatives ?? []) as ReviewCreative[];

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="shimmer aspect-[9/16] rounded-2xl border border-line" />
        ))}
      </div>
    );
  }

  if (!rows.length) {
    return (
      <EmptyState
        glyph={<Icon.content size={26} />}
        title="No creatives for this brand yet"
        body="Generate a batch from the Content studio. The factory builds product-first vertical assets — each with a burned-in AI-disclosure label — and they appear here for review and approval."
      >
        <a
          href="/content"
          className="inline-flex items-center gap-2 rounded-full bg-signal px-5 py-2.5 text-[13px] font-semibold text-void transition hover:bg-signal-deep"
        >
          Open Content studio &rarr;
        </a>
      </EmptyState>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map((c, i) => (
        <CreativeCard key={c._id} creative={c} index={i} />
      ))}
    </div>
  );
}
