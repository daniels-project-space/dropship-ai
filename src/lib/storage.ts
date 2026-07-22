// Cloudflare R2 wrapper (S3-compatible). Bucket "dropship-ai".
// Credentials pulled from the vault `cloudflare` service at call time (server-only).
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { getSignedUrl as presign } from "@aws-sdk/s3-request-presigner";
import { getService } from "./vault";
import { createHash } from "node:crypto";
import { readResponseBodyBounded } from "./boundedBody";

export const BUCKET = "dropship-ai";

let cached: { client: S3Client; bucket: string } | null = null;

async function client(): Promise<S3Client> {
  if (cached) return cached.client;
  const cf = await getService("cloudflare");
  const accountId = cf.R2_ACCOUNT_ID;
  const accessKeyId = cf.R2_ACCESS_KEY_ID;
  const secretAccessKey = cf.R2_SECRET_ACCESS_KEY;
  // R2_ENDPOINT is the account-level endpoint (https://<acct>.r2.cloudflarestorage.com).
  const endpoint = cf.R2_ENDPOINT ?? (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
  if (!accessKeyId || !secretAccessKey || !endpoint) {
    throw new Error("storage: missing R2 credentials in vault cloudflare service");
  }
  const c = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
  cached = { client: c, bucket: BUCKET };
  return c;
}

export async function putObject(
  key: string,
  body: PutObjectCommandInput["Body"],
  contentType?: string,
): Promise<{ key: string; bucket: string }> {
  const c = await client();
  await c.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return { key, bucket: BUCKET };
}

export type StoredObjectReceipt = { key: string; contentType: string; bytes: number; sha256: string; reused: boolean };

export class DeterministicObjectConflictError extends Error {
  constructor(key: string) {
    super(`storage: conflicting object already exists at deterministic key ${key}`);
    this.name = "DeterministicObjectConflictError";
  }
}

function mediaLooksValid(body: Buffer, contentType: string): boolean {
  if (contentType === "image/jpeg") return body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
  if (contentType === "video/mp4") return body.length >= 12 && body.subarray(4, 8).toString("ascii") === "ftyp";
  if (contentType === "audio/mpeg") return body.length >= 3 && (body.subarray(0, 3).toString("ascii") === "ID3" || (body[0] === 0xff && (body[1] & 0xe0) === 0xe0));
  return false;
}

async function headReceipt(key: string): Promise<Partial<Omit<StoredObjectReceipt, "key" | "reused">> | null> {
  const c = await client();
  try {
    const head = await c.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    const sha256 = head.Metadata?.sha256;
    return { contentType: head.ContentType, bytes: head.ContentLength, sha256 };
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || (error as { name?: string }).name === "NotFound" || (error as { name?: string }).name === "NoSuchKey") return null;
    throw error;
  }
}

/**
 * Put-once object identity. A lost PUT response is recovered by the metadata digest; an existing
 * object without the exact receipt is never overwritten.
 */
export async function putDeterministicObject(
  key: string,
  body: Buffer,
  contentType: "image/jpeg" | "video/mp4" | "audio/mpeg",
  maxBytes: number,
): Promise<StoredObjectReceipt> {
  if (!/^creatives\/generations\/[A-Za-z0-9_-]+\/v[0-2]\/(image\.jpg|clip\.mp4|voice\.mp3|final\.mp4)$/.test(key)) {
    throw new Error("storage: invalid deterministic creative key");
  }
  if (!Number.isInteger(maxBytes) || body.byteLength < 1 || body.byteLength > maxBytes || !mediaLooksValid(body, contentType)) {
    throw new Error(`storage: invalid ${contentType} object body`);
  }
  const sha256 = createHash("sha256").update(body).digest("hex");
  const expected = { contentType, bytes: body.byteLength, sha256 };
  const existing = await headReceipt(key);
  if (existing) {
    if (existing.contentType === expected.contentType && existing.bytes === expected.bytes && existing.sha256 === expected.sha256) {
      return { key, ...expected, reused: true };
    }
    throw new DeterministicObjectConflictError(key);
  }
  const c = await client();
  try {
    await c.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType, Metadata: { sha256 }, IfNoneMatch: "*" }));
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status !== 409 && status !== 412) throw error;
    const raced = await headReceipt(key);
    if (raced?.contentType === expected.contentType && raced.bytes === expected.bytes && raced.sha256 === expected.sha256) {
      return { key, ...expected, reused: true };
    }
    throw new DeterministicObjectConflictError(key);
  }
  const stored = await headReceipt(key);
  if (!stored || stored.contentType !== expected.contentType || stored.bytes !== expected.bytes || stored.sha256 !== expected.sha256) {
    throw new DeterministicObjectConflictError(key);
  }
  return { key, ...expected, reused: false };
}

export async function getObjectBuffer(
  key: string,
  expected: { contentType: string; bytes: number; sha256: string },
): Promise<Buffer> {
  const cap = expected.contentType === "audio/mpeg" || expected.contentType === "image/jpeg"
    ? 20 * 1024 * 1024
    : expected.contentType === "video/mp4"
      ? (key.endsWith("/clip.mp4") ? 200 * 1024 * 1024 : 300 * 1024 * 1024)
      : 0;
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 1 || expected.bytes > cap
    || !/^[a-f0-9]{64}$/.test(expected.sha256)) {
    throw new DeterministicObjectConflictError(key);
  }
  const c = await client();
  const result = await c.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!result.Body) throw new Error(`storage: object ${key} has no body`);
  const headers = new Headers();
  if (result.ContentLength !== undefined) headers.set("content-length", String(result.ContentLength));
  const response = new Response(result.Body.transformToWebStream(), { headers });
  let body: Buffer;
  try {
    body = await readResponseBodyBounded(response, expected.bytes, `storage object ${key}`);
  } catch {
    throw new DeterministicObjectConflictError(key);
  }
  const digest = createHash("sha256").update(body).digest("hex");
  if (result.ContentType !== expected.contentType || body.byteLength !== expected.bytes || digest !== expected.sha256) {
    throw new DeterministicObjectConflictError(key);
  }
  return body;
}

/** Presigned GET URL for an R2 object. expiresInSeconds default 1h. */
export async function getSignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
  const c = await client();
  return presign(c, new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
    expiresIn: expiresInSeconds,
  });
}
