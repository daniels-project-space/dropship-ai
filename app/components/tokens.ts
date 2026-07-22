// Shared visual tokens for status / risk-tier rendering.
// Keeps colour logic in one place so cards, dots and badges stay consistent.

export type SiteStatus = "provisioning" | "active" | "paused" | "killed";
export type RiskTier = "auto" | "human_gated";

type Tone = {
  label: string;
  // tailwind text colour token (maps to @theme colours in globals.css)
  text: string;
  dot: string;
  // hex used for the live pulse ring (currentColor source)
  hex: string;
  ring: string; // soft bg for badges
};

export const SITE_STATUS: Record<SiteStatus, Tone> = {
  active: {
    label: "Active",
    text: "text-live",
    dot: "bg-live",
    hex: "#44d6a0",
    ring: "bg-live/10 text-live ring-1 ring-live/25",
  },
  provisioning: {
    label: "Provisioning",
    text: "text-violet",
    dot: "bg-violet",
    hex: "#9b8cff",
    ring: "bg-violet/10 text-violet ring-1 ring-violet/25",
  },
  paused: {
    label: "Paused",
    text: "text-ink-dim",
    dot: "bg-ink-faint",
    hex: "#5d6878",
    ring: "bg-white/5 text-ink-dim ring-1 ring-white/10",
  },
  killed: {
    label: "Killed",
    text: "text-danger",
    dot: "bg-danger",
    hex: "#ef6b6b",
    ring: "bg-danger/10 text-danger ring-1 ring-danger/25",
  },
};

export const RISK_TIER: Record<RiskTier, Tone> = {
  human_gated: {
    label: "Human-gated",
    text: "text-pending",
    dot: "bg-pending",
    hex: "#f0a93b",
    ring: "bg-pending/10 text-pending ring-1 ring-pending/30",
  },
  auto: {
    label: "Auto",
    text: "text-cyan",
    dot: "bg-cyan",
    hex: "#5cc6e8",
    ring: "bg-cyan/10 text-cyan ring-1 ring-cyan/25",
  },
};

// ── product lifecycle ───────────────────────────────────────────────────────
export type ProductStatus = "draft" | "active" | "archived" | "killed";
export const PRODUCT_STATUS: Record<ProductStatus, Tone> = {
  active: { label: "Active", text: "text-live", dot: "bg-live", hex: "#44d6a0", ring: "bg-live/10 text-live ring-1 ring-live/25" },
  draft: { label: "Draft", text: "text-ink-dim", dot: "bg-ink-faint", hex: "#5d6878", ring: "bg-white/5 text-ink-dim ring-1 ring-white/10" },
  archived: { label: "Archived", text: "text-cyan", dot: "bg-cyan", hex: "#5cc6e8", ring: "bg-cyan/10 text-cyan ring-1 ring-cyan/25" },
  killed: { label: "Killed", text: "text-danger", dot: "bg-danger", hex: "#ef6b6b", ring: "bg-danger/10 text-danger ring-1 ring-danger/25" },
};

// ── action lifecycle (full set, for per-brand activity) ─────────────────────
export type ActionStatus =
  | "proposed" | "pending_approval" | "approved" | "rejected" | "executing" | "executed" | "failed" | "superseded";
export const ACTION_STATUS: Record<ActionStatus, Tone> = {
  pending_approval: { label: "Pending", text: "text-pending", dot: "bg-pending", hex: "#f0a93b", ring: "bg-pending/10 text-pending ring-1 ring-pending/30" },
  proposed: { label: "Proposed", text: "text-cyan", dot: "bg-cyan", hex: "#5cc6e8", ring: "bg-cyan/10 text-cyan ring-1 ring-cyan/25" },
  approved: { label: "Approved", text: "text-live", dot: "bg-live", hex: "#44d6a0", ring: "bg-live/10 text-live ring-1 ring-live/25" },
  executing: { label: "Executing", text: "text-violet", dot: "bg-violet", hex: "#9b8cff", ring: "bg-violet/10 text-violet ring-1 ring-violet/25" },
  executed: { label: "Executed", text: "text-live", dot: "bg-live", hex: "#44d6a0", ring: "bg-live/10 text-live ring-1 ring-live/25" },
  rejected: { label: "Rejected", text: "text-ink-dim", dot: "bg-ink-faint", hex: "#5d6878", ring: "bg-white/5 text-ink-dim ring-1 ring-white/10" },
  failed: { label: "Failed", text: "text-danger", dot: "bg-danger", hex: "#ef6b6b", ring: "bg-danger/10 text-danger ring-1 ring-danger/25" },
  superseded: { label: "Superseded", text: "text-ink-dim", dot: "bg-ink-faint", hex: "#5d6878", ring: "bg-white/5 text-ink-dim ring-1 ring-white/10" },
};

// ── distribution: platforms + post status + fulfillment ─────────────────────
export type Platform = "tiktok" | "instagram" | "youtube" | "facebook";
export const PLATFORM: Record<Platform, { label: string; text: string; dot: string; hex: string }> = {
  tiktok: { label: "TikTok", text: "text-cyan", dot: "bg-cyan", hex: "#5cc6e8" },
  instagram: { label: "Instagram", text: "text-violet", dot: "bg-violet", hex: "#9b8cff" },
  youtube: { label: "YouTube", text: "text-danger", dot: "bg-danger", hex: "#ef6b6b" },
  facebook: { label: "Facebook", text: "text-signal", dot: "bg-signal", hex: "#e8b04b" },
};

export type PostStatus = "draft" | "scheduled" | "awaiting_manual_publish" | "published" | "failed";
export const POST_STATUS_RING: Record<PostStatus, string> = {
  published: "bg-live/10 text-live ring-1 ring-live/25",
  scheduled: "bg-cyan/10 text-cyan ring-1 ring-cyan/25",
  awaiting_manual_publish: "bg-pending/10 text-pending ring-1 ring-pending/30",
  draft: "bg-white/5 text-ink-dim ring-1 ring-white/10",
  failed: "bg-danger/10 text-danger ring-1 ring-danger/25",
};

export type FulfillmentStatus = "received" | "sent_to_cj" | "shipped" | "delivered" | "error";
export const FULFILLMENT_STATUS: Record<FulfillmentStatus, Tone> = {
  received: { label: "Received", text: "text-pending", dot: "bg-pending", hex: "#f0a93b", ring: "bg-pending/10 text-pending ring-1 ring-pending/30" },
  sent_to_cj: { label: "Sent to CJ", text: "text-cyan", dot: "bg-cyan", hex: "#5cc6e8", ring: "bg-cyan/10 text-cyan ring-1 ring-cyan/25" },
  shipped: { label: "Shipped", text: "text-violet", dot: "bg-violet", hex: "#9b8cff", ring: "bg-violet/10 text-violet ring-1 ring-violet/25" },
  delivered: { label: "Delivered", text: "text-live", dot: "bg-live", hex: "#44d6a0", ring: "bg-live/10 text-live ring-1 ring-live/25" },
  error: { label: "Error", text: "text-danger", dot: "bg-danger", hex: "#ef6b6b", ring: "bg-danger/10 text-danger ring-1 ring-danger/25" },
};

// shared formatters
export function fmtUsd(n: number, frac = 2): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac })}`;
}
export function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
export function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
// contribution margin from the price ladder (price after COGS+shipping)
export function contributionMargin(price: number, cogs: number, shipping: number): number | null {
  if (!price || price <= 0) return null;
  return ((price - cogs - shipping) / price) * 100;
}
