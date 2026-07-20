import { createPrivateKey, createPublicKey, createSign } from "node:crypto";

const AUTH_ISSUER = "DROPSHIP_AI_AUTH_ISSUER";
const AUTH_AUDIENCE = "DROPSHIP_AI_AUTH_AUDIENCE";
const AUTH_PRIVATE_KEY = "DROPSHIP_AI_AUTH_PRIVATE_KEY";
const AUTH_KID = "DROPSHIP_AI_AUTH_KID";

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function settings() {
  const issuer = process.env[AUTH_ISSUER];
  const audience = process.env[AUTH_AUDIENCE];
  const privateKey = process.env[AUTH_PRIVATE_KEY]?.replace(/\\n/g, "\n");
  const kid = process.env[AUTH_KID] ?? "dropship-ai-operator-v1";
  if (!issuer || !audience || !privateKey) throw new Error("auth signing is not configured");
  return { issuer, audience, privateKey, kid };
}

/** A short-lived token used only by the browser Convex client. */
export function mintOperatorJwt(now = Math.floor(Date.now() / 1000)): string {
  const { issuer, audience, privateKey, kid } = settings();
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const payload = base64Url(JSON.stringify({ iss: issuer, aud: audience, sub: "dropship-ai:operator", iat: now, exp: now + 5 * 60 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${signer.sign(createPrivateKey(privateKey)).toString("base64url")}`;
}

/** Public JWK endpoint consumed by Convex's custom-JWT verifier. */
export function operatorJwk(): JsonWebKey & { kid: string; use: string; alg: string } {
  const { privateKey, kid } = settings();
  const jwk = createPublicKey(createPrivateKey(privateKey)).export({ format: "jwk" });
  return { ...jwk, kid, use: "sig", alg: "RS256" };
}
