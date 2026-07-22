// Server-only launch-integrity evidence. Secret presence is "configured", never "verified";
// verified means a fresh harmless read completed against the actual runtime contract.
import { NextResponse } from "next/server";
import { getKey, getService } from "@/src/lib/vault";
import { requireOperator } from "@/src/lib/auth/server";
import { convexClient, api } from "@/src/lib/convexClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ReadinessState = "configured" | "unverified" | "verified" | "blocked";
type CheckItem = { id: string; group: string; label: string; state: ReadinessState; detail: string; next: string };

async function vaultGetValue(service: string, keyName: string): Promise<string | null> {
  try { return await getKey(service, keyName); } catch { return null; }
}
async function vaultKeyNames(service: string): Promise<string[]> {
  try { return Object.keys(await getService(service)); } catch { return []; }
}

export async function GET(request: Request) {
  const guard = await requireOperator(request, { csrf: false });
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const checks: CheckItem[] = [];

  const ayrKey = await vaultGetValue("ayrshare", "AYRSHARE_API_KEY");
  if (!ayrKey) checks.push({ id: "ayrshare", group: "Distribution", label: "Ayrshare publishing", state: "blocked", detail: "API key is not configured", next: "Configure the server-side Ayrshare key, then verify linked target accounts." });
  else {
    try {
      const response = await fetch("https://api.ayrshare.com/api/user", { headers: { Authorization: `Bearer ${ayrKey}` }, cache: "no-store" });
      const body = response.ok ? await response.json() : null;
      const linked = Array.isArray(body?.displayNames) ? body.displayNames.filter((item: { platform?: unknown; id?: unknown }) => typeof item.platform === "string" && typeof item.id === "string") : [];
      checks.push(response.ok && linked.length
        ? { id: "ayrshare", group: "Distribution", label: "Ayrshare publishing", state: "verified", detail: `${linked.length} linked account identity record(s) verified by fresh read`, next: "Publication still requires an exact per-creative operator authorization." }
        : { id: "ayrshare", group: "Distribution", label: "Ayrshare publishing", state: "unverified", detail: response.ok ? "Credential works but no exact linked account identities were returned" : `Credential configured; probe returned HTTP ${response.status}`, next: "Verify the account and link the intended social targets." });
    } catch {
      checks.push({ id: "ayrshare", group: "Distribution", label: "Ayrshare publishing", state: "unverified", detail: "Credential configured; fresh read probe failed", next: "Retry the harmless account probe before launch." });
    }
  }

  const triggerConfigured = Boolean(process.env.TRIGGER_SECRET_KEY);
  checks.push({ id: "trigger", group: "Orchestration", label: "Trigger.dev application handoff", state: triggerConfigured ? "configured" : "blocked", detail: triggerConfigured ? "The Vercel runtime has a Trigger key; project/revision execution is not proven here" : "TRIGGER_SECRET_KEY is missing from the application runtime", next: triggerConfigured ? "Verify this commit in project proj_ebwgqvfufapbqnhjxhnc during the operator-authorized provider phase." : "Configure the project-scoped Trigger key in the application runtime." });

  const jwtInputs = ["DROPSHIP_AI_AUTH_ISSUER", "DROPSHIP_AI_AUTH_AUDIENCE", "DROPSHIP_AI_AUTH_KID", "DROPSHIP_AI_AUTH_PRIVATE_KEY"] as const;
  const jwtConfigured = jwtInputs.every((name) => Boolean(process.env[name])) && Boolean(process.env.NEXT_PUBLIC_CONVEX_URL ?? process.env.CONVEX_URL);
  if (!jwtConfigured) checks.push({ id: "service-auth", group: "Orchestration", label: "RS256 service JWT → Convex", state: "blocked", detail: "One or more issuer/audience/kid/private-key/Convex URL inputs are missing", next: "Configure the same named RS256 inputs in Vercel, Convex verifier config, and Trigger." });
  else {
    try {
      await convexClient().query(api.sites.list, {});
      checks.push({ id: "service-auth", group: "Orchestration", label: "RS256 service JWT → Convex", state: "verified", detail: "Fresh authenticated Convex read succeeded", next: "Trigger must still verify the same inputs after its separately authorized deployment." });
    } catch {
      checks.push({ id: "service-auth", group: "Orchestration", label: "RS256 service JWT → Convex", state: "unverified", detail: "Inputs are configured but a fresh authenticated Convex read failed", next: "Align issuer, audience, kid, JWKS and private key before launch." });
    }
  }

  for (const [id, label, service, keys] of [
    ["fal", "fal creative generation", "fal", ["FAL_KEY", "FAL_API_KEY"]],
    ["elevenlabs", "ElevenLabs voiceover", "elevenlabs", ["ELEVENLABS_API_KEY"]],
  ] as const) {
    const configured = (await Promise.all(keys.map((key) => vaultGetValue(service, key)))).some(Boolean);
    checks.push({ id, group: "Generation", label, state: configured ? "configured" : "blocked", detail: configured ? "Caller credential is configured; quota/model execution is not probed" : "Caller credential is missing", next: configured ? "Run the bounded non-billable validation available to the operator, or retain this as unverified." : `Configure ${service} for the active caller.` });
  }

  const cjKeys = await vaultKeyNames("cj");
  checks.push({ id: "cj", group: "Commerce", label: "CJ supplier", state: cjKeys.includes("CJ_ACCESS_TOKEN") ? "configured" : "blocked", detail: cjKeys.includes("CJ_ACCESS_TOKEN") ? "Credential bundle is configured; no supplier write or token rotation was attempted" : "CJ access token is missing", next: cjKeys.includes("CJ_ACCESS_TOKEN") ? "Validate read-only catalogue/freight access in the separate provider phase." : "Configure the scoped CJ credential bundle." });
  const shopKeys = await vaultKeyNames("shopify");
  checks.push({ id: "shopify", group: "Commerce", label: "Shopify storefront", state: shopKeys.length ? "configured" : "blocked", detail: shopKeys.length ? "At least one store credential reference is configured; store reads are not globally proven" : "No Shopify store token is configured", next: shopKeys.length ? "Use each site's read-only sync to verify its USD store identity." : "Connect a USD Shopify store through the operator flow." });

  const counts = { verified: 0, configured: 0, unverified: 0, blocked: 0 };
  for (const check of checks) counts[check.state]++;
  return NextResponse.json({
    checkedAt: Date.now(),
    summary: { total: checks.length, ...counts, goLive: counts.blocked === 0 && counts.unverified === 0 && counts.configured === 0 },
    checks,
  });
}
