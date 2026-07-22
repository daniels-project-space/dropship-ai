// Durable fal queue adapter. Submission returns immediately and every later operation is a
// receipt-bound status/result read that can run in a different process.
import { getKey } from "../vault";
import { putDeterministicObject, type StoredObjectReceipt } from "../storage";
import type { FalQueueState } from "../creativeGeneration";

const QUEUE_BASE = "https://queue.fal.run";
export const FAL_IMAGE_MODEL = process.env.FAL_MODEL_IMAGE ?? "fal-ai/flux/schnell";
export const FAL_CLIP_MODEL = process.env.FAL_MODEL_CLIP ?? "fal-ai/kling-video/v1/standard/image-to-video";
export const FAL_CLIP_START_TIMEOUT_SECONDS = 120;
export const FAL_INPUT_URL_MARGIN_SECONDS = 60;

export type FalQueueReceipt = {
  requestId: string;
  model: string;
  statusUrl: string;
  resultUrl: string;
};

export class FalSubmissionAmbiguousError extends Error {
  constructor() { super("fal queue submission receipt is ambiguous"); this.name = "FalSubmissionAmbiguousError"; }
}

export class FalDefinitiveSubmissionError extends Error {
  constructor(public readonly status: number) { super(`fal queue rejected submission with HTTP ${status}`); this.name = "FalDefinitiveSubmissionError"; }
}

export async function getFalApiKey(): Promise<string> {
  const key = await getKey("fal", "FAL_KEY");
  if (!key) throw new Error("fal_key_unavailable");
  return key;
}

function exactQueueUrls(model: string, requestId: string) {
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(model) || model.length > 200 || !/^[A-Za-z0-9-]{8,128}$/.test(requestId)) {
    throw new Error("fal_receipt_identity_invalid");
  }
  const root = `${QUEUE_BASE}/${model}/requests/${requestId}`;
  return { statusUrl: `${root}/status`, resultUrl: `${root}/response` };
}

export async function submitFalQueue(args: {
  model: string;
  input: Record<string, unknown>;
  apiKey: string;
  startTimeoutSeconds?: number;
  fetchImpl?: typeof fetch;
}): Promise<FalQueueReceipt> {
  const fetcher = args.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${QUEUE_BASE}/${args.model}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${args.apiKey}`,
        "Content-Type": "application/json",
        ...(args.startTimeoutSeconds ? { "X-Fal-Request-Timeout": String(args.startTimeoutSeconds) } : {}),
      },
      body: JSON.stringify(args.input),
    });
  } catch {
    throw new FalSubmissionAmbiguousError();
  }
  if (!response.ok) {
    if (response.status >= 500 || response.status === 408 || response.status === 429) throw new FalSubmissionAmbiguousError();
    throw new FalDefinitiveSubmissionError(response.status);
  }
  let body: { request_id?: unknown; status_url?: unknown; response_url?: unknown };
  try { body = await response.json(); } catch { throw new FalSubmissionAmbiguousError(); }
  if (typeof body.request_id !== "string" || !/^[A-Za-z0-9-]{8,128}$/.test(body.request_id)) throw new FalSubmissionAmbiguousError();
  const exact = exactQueueUrls(args.model, body.request_id);
  if (body.status_url !== exact.statusUrl || body.response_url !== exact.resultUrl) throw new FalSubmissionAmbiguousError();
  return { requestId: body.request_id, model: args.model, ...exact };
}

async function safeQueueRead(url: string, apiKey: string, fetchImpl?: typeof fetch): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "queue.fal.run" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("fal_receipt_endpoint_invalid");
  }
  const response = await (fetchImpl ?? fetch)(url, { headers: { Authorization: `Key ${apiKey}` } });
  if (!response.ok) throw new Error(`fal_queue_read_http_${response.status}`);
  return response;
}

export async function readFalQueueStatus(args: { receipt: FalQueueReceipt; apiKey: string; fetchImpl?: typeof fetch }): Promise<{ status: FalQueueState; failed: boolean }> {
  const exact = exactQueueUrls(args.receipt.model, args.receipt.requestId);
  if (args.receipt.statusUrl !== exact.statusUrl || args.receipt.resultUrl !== exact.resultUrl) throw new Error("fal_receipt_endpoint_invalid");
  const body = await (await safeQueueRead(args.receipt.statusUrl, args.apiKey, args.fetchImpl)).json() as { status?: unknown; request_id?: unknown; error?: unknown };
  if (body.request_id !== args.receipt.requestId || (body.status !== "IN_QUEUE" && body.status !== "IN_PROGRESS" && body.status !== "COMPLETED")) {
    throw new Error("fal_queue_status_invalid");
  }
  return { status: body.status, failed: body.status === "COMPLETED" && typeof body.error === "string" && body.error.length > 0 };
}

function mediaUrlFromResult(body: any, kind: "image" | "clip"): string {
  const value = kind === "image" ? body?.images?.[0]?.url ?? body?.image?.url : body?.video?.url;
  if (typeof value !== "string") throw new Error("fal_result_media_missing");
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.hostname !== "fal.media" && !parsed.hostname.endsWith(".fal.media"))) {
    throw new Error("fal_result_media_invalid");
  }
  return value;
}

export async function copyFalQueueResult(args: {
  kind: "image" | "clip";
  receipt: FalQueueReceipt;
  apiKey: string;
  r2Key: string;
  fetchImpl?: typeof fetch;
  putObject?: typeof putDeterministicObject;
}): Promise<StoredObjectReceipt> {
  const exact = exactQueueUrls(args.receipt.model, args.receipt.requestId);
  if (args.receipt.resultUrl !== exact.resultUrl) throw new Error("fal_receipt_endpoint_invalid");
  const result = await (await safeQueueRead(args.receipt.resultUrl, args.apiKey, args.fetchImpl)).json();
  const mediaUrl = mediaUrlFromResult(result, args.kind);
  const media = await (args.fetchImpl ?? fetch)(mediaUrl);
  if (!media.ok) throw new Error(`fal_media_download_http_${media.status}`);
  const expectedType = args.kind === "image" ? "image/jpeg" : "video/mp4";
  const receivedType = media.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (receivedType !== expectedType) throw new Error("fal_media_type_invalid");
  const body = Buffer.from(await media.arrayBuffer());
  return (args.putObject ?? putDeterministicObject)(args.r2Key, body, expectedType, args.kind === "image" ? 20 * 1024 * 1024 : 200 * 1024 * 1024);
}

export function imageQueueInput(prompt: string): Record<string, unknown> {
  return { prompt, image_size: "portrait_16_9", num_images: 1, output_format: "jpeg" };
}

export function clipQueueInput(imageUrl: string, prompt: string): Record<string, unknown> {
  return { image_url: imageUrl, prompt, duration: "5", aspect_ratio: "9:16" };
}
