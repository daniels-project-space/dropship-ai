// Server-only secrets vault reader. Reads the project-hub Convex `secrets` table via its
// public query API. NEVER import this into client components — it returns plaintext secrets.
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

async function vaultQuery<T>(path: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(vaultUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
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
