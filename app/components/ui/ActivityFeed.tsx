import { timeAgo } from "../tokens";

export type AuditEntry = {
  _id: string;
  event: string;
  detail?: unknown;
  at: number;
  siteName?: string;
};

// Maps audit events → a tone hex so the feed reads at a glance.
function eventTone(event: string): { hex: string; bg: string } {
  if (event.includes("approved") || event.includes("executed") || event.includes("published") || event.includes("delivered"))
    return { hex: "#44d6a0", bg: "bg-live" };
  if (event.includes("rejected") || event.includes("failed") || event.includes("killed") || event.includes("error"))
    return { hex: "#ef6b6b", bg: "bg-danger" };
  if (event.includes("proposed") || event.includes("requested") || event.includes("pending"))
    return { hex: "#f0a93b", bg: "bg-pending" };
  if (event.includes("created") || event.includes("provision"))
    return { hex: "#9b8cff", bg: "bg-violet" };
  return { hex: "#5cc6e8", bg: "bg-cyan" };
}

function prettyEvent(event: string) {
  return event.replace(/_/g, " ");
}

function summarize(detail: unknown): string | null {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  const bits: string[] = [];
  if (typeof d.title === "string") bits.push(d.title);
  if (typeof d.type === "string") bits.push(String(d.type).replace(/_/g, " "));
  if (typeof d.platform === "string") bits.push(String(d.platform));
  if (typeof d.kind === "string") bits.push(String(d.kind).replace(/_/g, " "));
  if (typeof d.approver === "string") bits.push(`by ${d.approver}`);
  return bits.length ? bits.join(" · ") : null;
}

// Vertical timeline of audit events with a connecting spine. Used on the
// Portfolio recent-activity strip and the per-brand Activity tab. Pass `onSelect`
// to make each row clickable (opens a detail drawer on the global Activity page).
export function ActivityFeed({
  entries,
  showSite = false,
  dense = false,
  onSelect,
}: {
  entries: AuditEntry[];
  showSite?: boolean;
  dense?: boolean;
  onSelect?: (entry: AuditEntry) => void;
}) {
  return (
    <ol className="relative flex flex-col">
      {/* connecting spine */}
      <span aria-hidden className="absolute left-[6px] top-3 bottom-3 w-px bg-gradient-to-b from-line-soft via-line-soft to-transparent" />
      {entries.map((e) => {
        const tone = eventTone(e.event);
        const sub = summarize(e.detail);
        const clickable = !!onSelect;
        return (
          <li
            key={e._id}
            onClick={clickable ? () => onSelect!(e) : undefined}
            className={`group relative flex items-start gap-3.5 ${dense ? "py-2" : "py-2.5"} ${
              clickable ? "-mx-2 cursor-pointer rounded-lg px-2 transition-colors hover:bg-white/[0.025]" : ""
            }`}
          >
            {/* status node — dot in a well so the connecting spine reads behind it */}
            <span className="relative z-10 mt-[3px] grid h-[13px] w-[13px] shrink-0 place-items-center rounded-full bg-base ring-1 ring-line-soft">
              <span className={`h-[6px] w-[6px] rounded-full ${tone.bg}`} style={{ boxShadow: `0 0 6px -1px ${tone.hex}` }} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-[13px] capitalize text-ink">{prettyEvent(e.event)}</span>
                <span className="shrink-0 num text-[10px] text-ink-faint">{timeAgo(e.at)}</span>
              </div>
              {(sub || (showSite && e.siteName)) && (
                <p className="mt-1 flex items-center gap-1.5 truncate font-mono text-[11px] text-ink-faint">
                  {showSite && e.siteName ? (
                    <span className="inline-flex shrink-0 items-center rounded-full border border-line-soft bg-white/[0.02] px-1.5 py-px text-[10px] text-ink-dim">
                      {e.siteName}
                    </span>
                  ) : null}
                  {sub ? <span className="truncate">{sub}</span> : null}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
