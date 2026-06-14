// Cloudflare R2 wrapper (S3-compatible). Bucket "dropship-ai".
// Credentials pulled from the vault `cloudflare` service at call time (server-only).
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { getSignedUrl as presign } from "@aws-sdk/s3-request-presigner";
import { getService } from "./vault";

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

/** Presigned GET URL for an R2 object. expiresInSeconds default 1h. */
export async function getSignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
  const c = await client();
  return presign(c, new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
    expiresIn: expiresInSeconds,
  });
}
