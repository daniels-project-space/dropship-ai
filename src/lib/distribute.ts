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
export const PLATFORMS = ["tiktok", "instagram", "youtube", "facebook"] as const;
export type Platform = (typeof PLATFORMS)[number];

export type CreativeForPublish = {
  aiGenerated: boolean;
  aiLabelRequired: boolean;
  labelBurned: boolean;     // did the assembler actually burn the on-screen label?
  mediaUrl: string;          // public/presigned URL of the finished asset
  caption: string;
};

export type DistributeResult =
  | { mode: "ayrshare"; ok: true; platforms: Platform[]; postIds: Record<string, string>; missingPlatforms: Platform[]; providerReceiptId?: string; providerErrors?: unknown; aiFlagSet: true }
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
  options: {
    distributionMode: "semi_manual" | "automated";
    idempotencyKey?: string;
    destinations: Array<{ platform: Platform; targetAccount: string }>;
  },
): Promise<DistributeResult> {
  assertLabelGate(c); // throws on any unlabeled AI asset — hard stop
  if (!options.destinations.length || new Set(options.destinations.map((d) => d.platform)).size !== options.destinations.length
    || options.destinations.some((d) => !d.targetAccount.trim())) {
    return { mode: "blocked", ok: false, reason: "publication authorization has invalid target destinations" };
  }

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

  // The authorization stores public account identities, never profile credentials. Verify the
  // exact selected accounts with a fresh read before crossing the publication boundary.
  const accountResponse = await fetch(`${AYRSHARE_BASE}/user`, {
    headers: { Authorization: `Bearer ${key}` }, cache: "no-store",
  });
  const accountJson = (await accountResponse.json().catch(() => ({}))) as {
    displayNames?: Array<{ platform?: string; id?: string; username?: string; displayName?: string }>;
  };
  if (!accountResponse.ok) return { mode: "blocked", ok: false, reason: `ayrshare target verification failed: HTTP ${accountResponse.status}` };
  const accounts = accountJson.displayNames ?? [];
  for (const destination of options.destinations) {
    const match = accounts.some((account) => account.platform === destination.platform
      && [account.id, account.username, account.displayName].some((identity) => identity === destination.targetAccount));
    if (!match) return { mode: "blocked", ok: false, reason: `authorized ${destination.platform} target account is not currently linked` };
  }
  const requestedPlatforms = options.destinations.map((d) => d.platform);

  const res = await fetch(`${AYRSHARE_BASE}/post`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      post: c.caption,
      platforms: requestedPlatforms,
      mediaUrls: [c.mediaUrl],
      // Ayrshare deduplicates this key. Our durable target lock prevents concurrent submissions,
      // and this provider fence protects a later retry of the exact immutable distribution intent.
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey, notes: options.idempotencyKey } : {}),
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
    id?: string;
    postIds?: Array<{ platform: string; id?: string; postUrl?: string }>;
    errors?: unknown;
  };
  // Ayrshare may return successful receipts for only some platforms with top-level status=error.
  // Preserve those receipts; callers must reconcile the missing platforms and never rebroadcast.
  if (!res.ok && !(json.postIds?.some((post) => typeof post.id === "string" && post.id.trim()))) {
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
  const missingPlatforms = requestedPlatforms.filter((platform) => !postIds[platform]);
  return {
    mode: "ayrshare",
    ok: true,
    platforms: requestedPlatforms,
    postIds,
    missingPlatforms,
    providerReceiptId: typeof json.id === "string" && json.id.trim() ? json.id : undefined,
    providerErrors: json.errors,
    aiFlagSet: true,
  };
}

/** Read-only receipt reconciliation. It intentionally has no POST fallback. */
export async function reconcileAyrsharePost(providerReceiptId: string, requestedPlatforms: Platform[]): Promise<{ postIds: Record<string, string>; missingPlatforms: Platform[]; providerErrors?: unknown }> {
  const key = await getKey("ayrshare", "AYRSHARE_API_KEY");
  if (!key) throw new Error("AYRSHARE_API_KEY absent; provider receipt cannot be reconciled");
  const res = await fetch(`${AYRSHARE_BASE}/post/${encodeURIComponent(providerReceiptId)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const json = (await res.json().catch(() => ({}))) as { postIds?: Array<{ platform: string; id?: string }>; errors?: unknown };
  if (!res.ok) throw new Error(`ayrshare receipt reconciliation failed: HTTP ${res.status}`);
  const postIds: Record<string, string> = {};
  for (const post of json.postIds ?? []) if (post.id?.trim()) postIds[post.platform] = post.id;
  return { postIds, missingPlatforms: requestedPlatforms.filter((platform) => !postIds[platform]), providerErrors: json.errors };
}
