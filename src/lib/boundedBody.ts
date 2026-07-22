export class BodyLimitExceededError extends Error {
  constructor(label: string, maxBytes: number) {
    super(`${label}: body exceeds ${maxBytes} bytes`);
    this.name = "BodyLimitExceededError";
  }
}

async function readStreamBodyBounded(
  body: ReadableStream<Uint8Array> | null,
  headers: Headers,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error(`${label}: invalid byte limit`);

  const rawLength = headers.get("content-length");
  const declaredLength = rawLength !== null && /^\d+$/.test(rawLength) ? Number(rawLength) : undefined;
  if (declaredLength !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes)) {
    await body?.cancel().catch(() => undefined);
    throw new BodyLimitExceededError(label, maxBytes);
  }
  if (!body) throw new Error(`${label}: body is missing`);

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BodyLimitExceededError(label, maxBytes);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (declaredLength !== undefined && bytes !== declaredLength) {
    throw new Error(`${label}: content-length mismatch`);
  }
  return Buffer.concat(chunks, bytes);
}

/** Read a Web response body without ever accumulating more than the declared byte budget. */
export function readResponseBodyBounded(
  response: Response,
  maxBytes: number,
  label = "response body",
): Promise<Buffer> {
  return readStreamBodyBounded(response.body, response.headers, maxBytes, label);
}

/** Read a Web request body incrementally, including when Content-Length is absent. */
export function readRequestBodyBounded(
  request: Request,
  maxBytes: number,
  label = "request body",
): Promise<Buffer> {
  return readStreamBodyBounded(request.body, request.headers, maxBytes, label);
}

/** Parse a small provider JSON response only after its encoded body passes a streaming cap. */
export async function readJsonResponseBounded<T>(
  response: Response,
  maxBytes: number,
  label = "JSON response",
): Promise<T> {
  const body = await readResponseBodyBounded(response, maxBytes, label);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as T;
  } catch {
    throw new Error(`${label}: invalid JSON`);
  }
}

/** Stop an unneeded provider response without materializing its body. */
export async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  await response.body.cancel().catch(() => undefined);
}
