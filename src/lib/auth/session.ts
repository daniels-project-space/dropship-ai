/**
 * Small, dependency-free signed session format shared by route handlers and
 * Next's Proxy. The cookie never contains the operator passphrase itself.
 */
export const OPERATOR_SESSION_COOKIE = "dropship_ai_operator";

type SessionPayload = { v: 1; exp: number };

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    // `atob` accepts non-canonical padding bits. Accepting those would let multiple textual
    // encodings represent the same signed bytes, so reject anything that does not round-trip.
    return bytesToBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

async function hmac(value: string, secret: string): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto is unavailable; cannot verify operator session");
  const encoder = new TextEncoder();
  const key = await subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function createOperatorSession(secret: string, now = Date.now()): Promise<string> {
  if (secret.length < 32) throw new Error("DROPSHIP_AI_SESSION_SECRET must be at least 32 characters");
  const payload: SessionPayload = { v: 1, exp: now + 8 * 60 * 60 * 1000 };
  const encoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${encoded}.${bytesToBase64Url(await hmac(encoded, secret))}`;
}

export async function verifyOperatorSession(value: string | undefined, secret: string, now = Date.now()): Promise<boolean> {
  if (!value || secret.length < 32) return false;
  const [encoded, signature, ...extra] = value.split(".");
  if (!encoded || !signature || extra.length) return false;
  const payloadBytes = base64UrlToBytes(encoded);
  const signatureBytes = base64UrlToBytes(signature);
  if (!payloadBytes || !signatureBytes) return false;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as SessionPayload;
  } catch {
    return false;
  }
  if (payload.v !== 1 || !Number.isFinite(payload.exp) || payload.exp <= now) return false;
  const expected = await hmac(encoded, secret);
  if (expected.length !== signatureBytes.length) return false;
  // Web Crypto performs the comparison inside the crypto implementation.
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return false;
  const encoder = new TextEncoder();
  const key = await subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return subtle.verify("HMAC", key, signatureBytes as BufferSource, encoder.encode(encoded));
}
