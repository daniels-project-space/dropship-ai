// Higgsfield generation adapter — STUB (not wireable as of 2026-06-15).
//
// Vault probe (2026-06-15) found NO higgsfield credential (tried HIGGSFIELD_API_KEY,
// HIGGSFIELD_TOKEN — both absent). Two wiring paths exist but neither is currently usable:
//   1. `@higgsfield/cli` — npm package, would need an auth token we don't have.
//   2. Hosted MCP at https://mcp.higgsfield.ai — requires an account/API key, also absent.
//
// Until a key lands in the vault under service `higgsfield`, every call throws a CLEAR,
// actionable error. Callers should treat Higgsfield as OPTIONAL and fall back to fal.ts
// (Kling/Veo) for motion. When a key is added, replace the body of `higgsfieldClip` with a
// real call (the signature is intentionally fal-compatible to make the swap a one-liner).
import { getKey } from "../vault";
import type { FalResult } from "./fal";

const NOT_WIRED =
  "higgsfield: no credential in vault (service `higgsfield`, keys HIGGSFIELD_API_KEY/HIGGSFIELD_TOKEN absent " +
  "as of 2026-06-15). Falling back to fal.ts is expected. Add a key to the vault to enable.";

/** True only when a higgsfield credential exists — lets callers branch without throwing. */
export async function higgsfieldAvailable(): Promise<boolean> {
  const a = await getKey("higgsfield", "HIGGSFIELD_API_KEY");
  const b = a ?? (await getKey("higgsfield", "HIGGSFIELD_TOKEN"));
  return Boolean(b);
}

/** Stub generator. Signature mirrors falProductClip so it can be a drop-in once wired. */
export async function higgsfieldClip(
  _imageUrl: string,
  _prompt: string,
  _r2Key: string,
): Promise<FalResult> {
  throw new Error(NOT_WIRED);
}
