import {
  creativeGenerationInputDigest,
  type NormalizedCreativeGenerationInput,
  validateCallerGenerationIdentity,
} from "./creativeGeneration";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type PendingIdentity = { version: 1; siteId: string; inputDigest: string; requestId: string };

function storageKey(siteId: string): string {
  return `dropship-ai:creative-generation:pending:${encodeURIComponent(siteId)}`;
}

function parseStoredIdentity(raw: string, siteId: string): PendingIdentity {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("stored generation identity is malformed; generation was not submitted"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stored generation identity is malformed; generation was not submitted");
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "inputDigest,requestId,siteId,version" || row.version !== 1 || row.siteId !== siteId) {
    throw new Error("stored generation identity is malformed; generation was not submitted");
  }
  const identity = validateCallerGenerationIdentity(row.requestId, row.inputDigest);
  return { version: 1, siteId, ...identity };
}

/** Reuse one paid-generation identity across retries and reloads for the exact normalized facts. */
export function getOrCreatePendingCreativeRequest(
  storage: StorageLike,
  input: NormalizedCreativeGenerationInput,
  randomUUID: () => string,
): PendingIdentity {
  const inputDigest = creativeGenerationInputDigest(input);
  const key = storageKey(input.siteId);
  const raw = storage.getItem(key);
  if (raw !== null) {
    const stored = parseStoredIdentity(raw, input.siteId);
    if (stored.inputDigest === inputDigest) return stored;
    // A different exact digest is a real normalized-input change and receives a new identity.
  }
  const identity = validateCallerGenerationIdentity(randomUUID(), inputDigest);
  const pending: PendingIdentity = { version: 1, siteId: input.siteId, ...identity };
  storage.setItem(key, JSON.stringify(pending));
  return pending;
}

/** Clear only the exact request that the server confirmed as a durable identity. */
export function confirmPendingCreativeRequest(
  storage: StorageLike,
  confirmed: Pick<PendingIdentity, "siteId" | "inputDigest" | "requestId">,
): void {
  const key = storageKey(confirmed.siteId);
  const raw = storage.getItem(key);
  if (raw === null) return;
  const stored = parseStoredIdentity(raw, confirmed.siteId);
  if (stored.inputDigest === confirmed.inputDigest && stored.requestId === confirmed.requestId) storage.removeItem(key);
}
