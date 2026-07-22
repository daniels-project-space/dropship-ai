/**
 * The single policy boundary for provider writes.
 *
 * An environment being "production" must never be enough to turn on effects. Each live
 * operation needs both an explicit caller intent and a deployment-time acknowledgement. This
 * makes a copied preview environment fail closed as well.
 */
export type EffectMode = "sandbox" | "live";

export function liveEffectsEnabled(): boolean {
  return process.env.DROPSHIP_AI_LIVE_EFFECTS === "enabled"
    && process.env.DROPSHIP_AI_LIVE_EFFECTS_CONFIRM === "I_UNDERSTAND_THIS_CAN_CREATE_EXTERNAL_EFFECTS";
}

export function assertLiveEffectsEnabled(mode: EffectMode): void {
  if (mode !== "live") return;
  if (!liveEffectsEnabled()) {
    throw new Error(
      "live effects are disabled; set DROPSHIP_AI_LIVE_EFFECTS=enabled and acknowledge DROPSHIP_AI_LIVE_EFFECTS_CONFIRM at deployment time",
    );
  }
}

/** Sandbox writes are additionally limited to an explicit allowlist of development shops. */
export function sandboxShopAllowed(shop: string): boolean {
  if (process.env.DROPSHIP_AI_SANDBOX_EFFECTS !== "enabled") return false;
  const allowed = (process.env.SHOPIFY_SANDBOX_SHOPS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(shop.trim().toLowerCase());
}
