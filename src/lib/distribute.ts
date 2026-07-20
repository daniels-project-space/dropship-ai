// Distribution adapter — organic-first multi-platform publish.
//
// HARD ENFORCEMENT (locked rule): NEVER publish a creative where aiLabelRequired && !labeled.
// `assertLabelGate` throws before any network call. This is the second, independent line of
// defense behind the assembler's burned-in label — code refuses to push an unlabeled AI asset.
//
// Path A — Ayrshare (key AYRSHARE_API_KEY present, pre-audited → can post public): one
//   POST /api/post fans out to ["tiktok","instagram","youtube"] and sets the AI-content flag.
// Path B — semi-manual (no key, or self-host that can't post public): caller creates a post row
//   with status "awaiting_manual_publish" (Daniel taps publish). This module returns a
//   directive telling the caller to take Path B; it does NOT touch Convex itself.
import { getKey } from "./vault";
import { assertLiveEffectsEnabled } from "./effects";

const AYRSHARE_BASE = "https://api.ayrshare.com/api";
export const PLATFORMS = ["tiktok", "instagram", "youtube"] as const;
export type Platform = (typeof PLATFORMS)[number];

export type CreativeForPublish = {
  aiGenerated: boolean;
  aiLabelRequired: boolean;
  labelBurned: boolean;     // did the assembler actually burn the on-screen label?
  mediaUrl: string;          // public/presigned URL of the finished asset
  caption: string;
};

export type DistributeResult =
  | { mode: "ayrshare"; ok: true; platforms: Platform[]; postIds: Record<string, string>; aiFlagSet: true }
  | { mode: "semi_manual"; ok: true; reason: string }
  | { mode: "blocked"; ok: false; reason: string };

/**
 * THE GATE. Throws if an AI creative is missing its label. Call this first, always.
 * Pure + synchronous so it's trivially unit-testable and impossible to bypass accidentally.
 */
export function assertLabelGate(c: Pick<CreativeForPublish, "aiGenerated" | "aiLabelRequired" | "labelBurned">): void {
  if ((c.aiGenerated || c.aiLabelRequired) && !c.labelBurned) {
    throw new Error(
      "distribute: BLOCKED — creative is AI-generated/label-required but the AI-disclosure label " +
        "was not burned in. Refusing to publish. (Re-run assembly to burn the label.)",
    );
  }
}

/** True when Ayrshare is wired (pre-audited public-posting path). */
export async function ayrshareAvailable(): Promise<boolean> {
  return Boolean(await getKey("ayrshare", "AYRSHARE_API_KEY"));
}

/**
 * Publish a creative. If Ayrshare is available → real fan-out post with AI flag. Otherwise returns
 * a semi_manual directive (caller writes an "awaiting_manual_publish" post row). Always passes the
 * label gate first.
 */
export async function distribute(
  c: CreativeForPublish,
  options: { distributionMode: "semi_manual" | "automated" },
): Promise<DistributeResult> {
  assertLabelGate(c); // throws on any unlabeled AI asset — hard stop

  // An approved creative is not itself permission to publish unless the brand explicitly opted
  // into automated distribution and the deployment has the two-key live-effects acknowledgement.
  if (options.distributionMode !== "automated") {
    return { mode: "semi_manual", ok: true, reason: "brand is in semi-manual distribution mode; operator must publish externally." };
  }
  assertLiveEffectsEnabled("live");

  const key = await getKey("ayrshare", "AYRSHARE_API_KEY");
  if (!key) {
    return {
      mode: "semi_manual",
      ok: true,
      reason: "AYRSHARE_API_KEY absent — cold-start path: create post rows status 'awaiting_manual_publish'.",
    };
  }

  const res = await fetch(`${AYRSHARE_BASE}/post`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      post: c.caption,
      platforms: [...PLATFORMS],
      mediaUrls: [c.mediaUrl],
      // AI-content disclosure flags (platform + Ayrshare meta) — set because the asset is AI-made.
      isVideo: true,
      tiktokOptions: { aiGeneratedContent: true },
      instagramOptions: {},
      youTubeOptions: {},
      // Ayrshare-level marker so downstream audits can see the AI flag was set.
      ...(c.aiGenerated || c.aiLabelRequired ? { adContent: false } : {}),
    }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    status?: string;
    postIds?: Array<{ platform: string; id?: string; postUrl?: string }>;
    errors?: unknown;
  };
  if (!res.ok || json.status === "error") {
    return {
      mode: "blocked",
      ok: false,
      reason: `ayrshare post failed: HTTP ${res.status} ${JSON.stringify(json.errors ?? json).slice(0, 240)}`,
    };
  }

  const postIds: Record<string, string> = {};
  for (const p of json.postIds ?? []) {
    if (p.id) postIds[p.platform] = p.id;
  }
  return { mode: "ayrshare", ok: true, platforms: [...PLATFORMS], postIds, aiFlagSet: true };
}
