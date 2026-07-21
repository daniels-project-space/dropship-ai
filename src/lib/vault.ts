// Server-only secrets vault reader. Reads the project-hub Convex `secrets` table via its
// authenticated query API. NEVER import this into client components — it returns plaintext secrets.
//
// Pattern (per ops runbook):
//   listByService -> { value: [{ keyName, value }, ...] }
//   getOne        -> { value: { value: "<secret>" } }

const DEFAULT_VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud/api/query";

function vaultUrl(): string {
  return process.env.VAULT_URL ?? DEFAULT_VAULT_URL;
}

type ListResponse = { value?: Array<{ keyName: string; value: string }> };
type OneResponse = { value?: { value: string } | null };
type BundleWriteResponse = { value?: { status?: "written" | "conflict" } };

async function vaultQuery<T>(path: string, args: Record<string, unknown>): Promise<T> {
  const vaultToken = process.env.VAULT_ACCESS_TOKEN;
  if (!vaultToken) throw new Error("VAULT_ACCESS_TOKEN is not configured");
  const res = await fetch(vaultUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, args: { ...args, vaultToken }, format: "json" }),
    // Secrets must never be cached by Next's fetch layer.
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`vault ${path} failed: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Return every key for a service as a flat record: { KEY_NAME: "secret", ... }. */
export async function getService(service: string): Promise<Record<string, string>> {
  const data = await vaultQuery<ListResponse>("secrets:listByService", { service });
  const out: Record<string, string> = {};
  for (const entry of data.value ?? []) {
    out[entry.keyName] = entry.value;
  }
  return out;
}

/** Return a single secret value, or null if absent. */
export async function getKey(service: string, keyName: string): Promise<string | null> {
  const data = await vaultQuery<OneResponse>("secrets:getOne", { service, keyName });
  return data.value?.value ?? null;
}

/** Like getKey but throws when the secret is missing — for hard dependencies. */
export async function requireKey(service: string, keyName: string): Promise<string> {
  const val = await getKey(service, keyName);
  if (!val) throw new Error(`vault: required secret ${service}/${keyName} is missing`);
  return val;
}

/**
 * Atomically replace CJ's rotated access/refresh pair through a narrowly scoped control-plane
 * writer. This app never writes individual credentials: a partial rotation would strand CJ on
 * restart. The writer endpoint is intentionally optional so deployments without the scoped
 * capability fail before contacting CJ's one-time refresh endpoint.
 */
export async function replaceCjTokenBundleAtomically(
  expectedRefreshToken: string | undefined,
  next: { accessToken: string; refreshToken: string; accessTokenExpiryDate?: string; refreshTokenExpiryDate?: string },
): Promise<"written" | "conflict"> {
  const url = process.env.VAULT_TOKEN_BUNDLE_WRITER_URL;
  const token = process.env.VAULT_TOKEN_BUNDLE_WRITER_TOKEN;
  assertCjTokenBundleWriterConfigured();
  // The assertion reads the environment independently; preserve the local narrowing for fetch.
  if (!url || !token) throw new Error("cj: atomic token-bundle writer configuration changed during request");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      operation: "replace_cj_token_bundle",
      service: "cj",
      expectedRefreshToken,
      values: {
        CJ_ACCESS_TOKEN: next.accessToken,
        CJ_REFRESH_TOKEN: next.refreshToken,
        ...(next.accessTokenExpiryDate ? { CJ_ACCESS_TOKEN_EXPIRY_DATE: next.accessTokenExpiryDate } : {}),
        ...(next.refreshTokenExpiryDate ? { CJ_REFRESH_TOKEN_EXPIRY_DATE: next.refreshTokenExpiryDate } : {}),
      },
    }),
    cache: "no-store",
  });
  if (response.status === 409) return "conflict";
  if (!response.ok) throw new Error(`cj: atomic token-bundle write failed: HTTP ${response.status}`);
  const payload = await response.json().catch(() => null) as BundleWriteResponse | null;
  if (payload?.value?.status === "conflict") return "conflict";
  if (payload?.value?.status === "written") return "written";
  throw new Error("cj: atomic token-bundle writer returned an invalid response");
}

/** Check before CJ consumes an authorization code or rotates its one-time refresh token. */
export function assertCjTokenBundleWriterConfigured(): void {
  if (!process.env.VAULT_TOKEN_BUNDLE_WRITER_URL || !process.env.VAULT_TOKEN_BUNDLE_WRITER_TOKEN) {
    throw new Error("cj: automatic token refresh is blocked: atomic control-plane token-bundle writer is not installed/configured");
  }
}
