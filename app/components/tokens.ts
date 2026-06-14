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
