// Server-only Trigger.dev credential resolution for the Dropship AI web app.
//
// The project-scoped key normally lives in the vault as
// trigger/DROPSHIP_AI_TRIGGER_SECRET_KEY. Trigger's SDK expects that key as an
// explicit client configuration (or as TRIGGER_SECRET_KEY); resolving it here
// keeps the readiness check and the actual enqueue path on the same contract.
import { auth } from "@trigger.dev/sdk/v3";
import { getKey } from "./vault";

const VAULT_SERVICE = "trigger";
const VAULT_KEY = "DROPSHIP_AI_TRIGGER_SECRET_KEY";

/** Return the server-side Trigger credential, without exposing it to callers. */
export async function getTriggerAccessToken(): Promise<string | null> {
  const fromEnvironment = process.env.TRIGGER_SECRET_KEY ?? process.env.TRIGGER_ACCESS_TOKEN;
  if (fromEnvironment) return fromEnvironment;

  return getKey(VAULT_SERVICE, VAULT_KEY).catch(() => null);
}

/** Execute a Trigger API operation with the project-scoped server credential. */
export async function withTriggerAuth<T>(work: () => Promise<T>): Promise<T | null> {
  const accessToken = await getTriggerAccessToken();
  if (!accessToken) return null;
  return auth.withAuth({ accessToken }, work);
}
