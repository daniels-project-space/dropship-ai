import { timeAgo } from "../tokens";
import { StatusDot } from "../StatusDot";

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
// Portfolio recent-activity strip and the per-brand Activity tab.
export function ActivityFeed({
  entries,
  showSite = false,
  dense = false,
}: {
  entries: AuditEntry[];
  showSite?: boolean;
  dense?: boolean;
}) {
  return (
    <ol className="relative flex flex-col">
      {/* connecting spine */}
      <span aria-hidden className="absolute left-[5px] top-2 bottom-2 w-px bg-line-soft" />
      {entries.map((e) => {
        const tone = eventTone(e.event);
        const sub = summarize(e.detail);
        return (
          <li key={e._id} className={`relative flex items-start gap-3.5 ${dense ? "py-2" : "py-2.5"}`}>
            <span className="relative z-10 mt-1 shrink-0">
              <StatusDot className={tone.bg} hex={tone.hex} size={6} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-[13px] capitalize text-ink">{prettyEvent(e.event)}</span>
                <span className="shrink-0 font-mono text-[10px] text-ink-faint">{timeAgo(e.at)}</span>
              </div>
              {(sub || (showSite && e.siteName)) && (
                <p className="mt-0.5 truncate font-mono text-[11px] text-ink-faint">
                  {showSite && e.siteName ? <span className="text-ink-dim">{e.siteName}</span> : null}
                  {showSite && e.siteName && sub ? " · " : ""}
                  {sub}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
