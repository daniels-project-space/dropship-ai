// Server-only GO-LIVE READINESS check. Reads the project-hub Convex vault for
// connection BOOLEANS (never secret values) and probes Ayrshare for which social
// accounts are actually linked. The client receives only connection state + the
// exact next-step text — secret values never cross this boundary.
import { NextResponse } from "next/server";
import { getKey, getService } from "@/src/lib/vault";
import { getTriggerAccessToken } from "@/src/lib/triggerAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ReadyState = "ready" | "action_needed" | "warn";

type CheckItem = {
  id: string;
  group: string;
  label: string;
  state: ReadyState;
  detail: string; // human status (never a secret)
  next: string; // the exact next step to take
};

// Pull a single secret VALUE server-side (used only to probe a live API; never returned).
async function vaultGetValue(service: string, keyName: string): Promise<string | null> {
  try {
    return await getKey(service, keyName);
  } catch {
    return null;
  }
}

// Does a service have ANY key present? (boolean only — no values leave the server.)
async function vaultHasService(service: string, keyNames: string[]): Promise<boolean> {
  for (const k of keyNames) {
    const v = await vaultGetValue(service, k);
    if (v) return true;
  }
  return false;
}

// List the keyNames a service holds (names only, never values).
async function vaultKeyNames(service: string): Promise<string[]> {
  try {
    return Object.keys(await getService(service));
  } catch {
    return [];
  }
}

export async function GET() {
  const checks: CheckItem[] = [];

  // ── Ayrshare: key present + which social accounts are LIVE ──────────────────
  const ayrKey = await vaultGetValue("ayrshare", "AYRSHARE_API_KEY");
  if (!ayrKey) {
    checks.push({
      id: "ayrshare",
      group: "Distribution",
      label: "Ayrshare publishing",
      state: "action_needed",
      detail: "No API key in vault",
      next: "Add ayrshare/AYRSHARE_API_KEY to the vault.",
    });
  } else {
    let connected: string[] = [];
    let probeOk = false;
    try {
      const r = await fetch("https://api.ayrshare.com/api/user", {
        headers: { Authorization: `Bearer ${ayrKey}` },
        cache: "no-store",
      });
      if (r.ok) {
        probeOk = true;
        const u = await r.json();
        const fromActive = Array.isArray(u?.activeSocialAccounts) ? u.activeSocialAccounts : [];
        const fromDisplay = Array.isArray(u?.displayNames)
          ? u.displayNames.map((d: { platform?: string }) => d?.platform).filter(Boolean)
          : [];
        connected = Array.from(new Set([...fromActive, ...fromDisplay])) as string[];
      }
    } catch {
      probeOk = false;
    }
    const wanted = ["tiktok", "instagram", "youtube"];
    const linked = wanted.filter((p) => connected.includes(p));
    if (!probeOk) {
      checks.push({
        id: "ayrshare",
        group: "Distribution",
        label: "Ayrshare publishing",
        state: "warn",
        detail: "Key present — account probe failed",
        next: "Verify the Ayrshare key is valid and the account is active.",
      });
    } else if (linked.length === 0) {
      checks.push({
        id: "ayrshare",
        group: "Distribution",
        label: "Ayrshare publishing",
        state: "action_needed",
        detail: "Key valid · 0 social accounts linked",
        next: "Link TikTok, Instagram and YouTube in the Ayrshare dashboard (Social Accounts).",
      });
    } else {
      const missing = wanted.filter((p) => !linked.includes(p));
      checks.push({
        id: "ayrshare",
        group: "Distribution",
        label: "Ayrshare publishing",
        state: missing.length ? "warn" : "ready",
        detail: `Linked: ${linked.join(", ")}${missing.length ? ` · missing: ${missing.join(", ")}` : ""}`,
        next: missing.length
          ? `Link the remaining platform(s): ${missing.join(", ")}.`
          : "All three platforms linked — automated publishing is ready.",
      });
    }
  }

  // ── Trigger runtime key ────────────────────────────────────────────────────
  // Use the exact same resolution path as the enqueue routes. A key merely
  // existing under an unrelated vault name must not make this check look ready.
  const hasDropshipTrigger = Boolean(await getTriggerAccessToken());
  checks.push({
    id: "trigger",
    group: "Orchestration",
    label: "Trigger.dev runtime key",
    state: hasDropshipTrigger ? "ready" : "action_needed",
    detail: hasDropshipTrigger
      ? "Project Trigger key available to server"
      : "Project Trigger key unavailable to server",
    next: hasDropshipTrigger
      ? "Server can enqueue the content-factory + brain tasks."
      : "Add trigger/DROPSHIP_AI_TRIGGER_SECRET_KEY to the vault or set TRIGGER_SECRET_KEY on the server.",
  });

  // ── Generation sources ──────────────────────────────────────────────────────
  const higgs = await vaultHasService("higgsfield", ["HIGGSFIELD_API_KEY"]);
  checks.push({
    id: "higgsfield",
    group: "Generation",
    label: "Higgsfield (video creative)",
    state: higgs ? "ready" : "action_needed",
    detail: higgs ? "Key present (funded)" : "No key in vault",
    next: higgs ? "Primary creative source is live." : "Add higgsfield/HIGGSFIELD_API_KEY to the vault.",
  });

  const fal = await vaultHasService("fal", ["FAL_KEY", "FAL_API_KEY"]);
  checks.push({
    id: "fal",
    group: "Generation",
    label: "fal (fallback gen)",
    state: fal ? "warn" : "action_needed",
    detail: fal ? "Key present — credits not verified" : "No key in vault",
    next: fal ? "Confirm the fal account has credits before relying on it." : "Add fal/FAL_KEY to the vault.",
  });

  const replicate = await vaultHasService("replicate", ["REPLICATE_API_TOKEN"]);
  checks.push({
    id: "replicate",
    group: "Generation",
    label: "Replicate (fallback gen)",
    state: replicate ? "ready" : "action_needed",
    detail: replicate ? "Token present" : "No token in vault",
    next: replicate ? "Available as a fallback model host." : "Add replicate/REPLICATE_API_TOKEN to the vault.",
  });

  const eleven = await vaultHasService("elevenlabs", ["ELEVENLABS_API_KEY"]);
  checks.push({
    id: "elevenlabs",
    group: "Generation",
    label: "ElevenLabs (voiceover)",
    state: eleven ? "ready" : "action_needed",
    detail: eleven ? "Key present" : "No key in vault",
    next: eleven ? "Voiceover generation is available." : "Add elevenlabs/ELEVENLABS_API_KEY to the vault.",
  });

  // ── Per-brand commerce (store + supplier) ───────────────────────────────────
  const cjKeys = await vaultKeyNames("cj");
  const hasCj = cjKeys.length > 0;
  checks.push({
    id: "cj",
    group: "Commerce",
    label: "CJ Dropshipping (supplier)",
    state: hasCj ? "ready" : "action_needed",
    detail: hasCj ? "Credentials present" : "No CJ credentials in vault",
    next: hasCj ? "Sourcing + fulfillment can run." : "Connect a CJ account: add cj/* credentials to the vault.",
  });

  const shopKeys = await vaultKeyNames("shopify");
  const hasShop = shopKeys.length > 0;
  checks.push({
    id: "shopify",
    group: "Commerce",
    label: "Shopify (storefront)",
    state: hasShop ? "ready" : "action_needed",
    detail: hasShop ? "Store token present" : "No Shopify token in vault",
    next: hasShop ? "Orders can flow into the fulfillment loop." : "Connect a store: add shopify/* admin token to the vault.",
  });

  const ready = checks.filter((c) => c.state === "ready").length;
  const blocking = checks.filter((c) => c.state === "action_needed").length;
  const warn = checks.filter((c) => c.state === "warn").length;

  return NextResponse.json({
    checkedAt: Date.now(),
    summary: { total: checks.length, ready, warn, blocking, goLive: blocking === 0 },
    checks,
  });
}
