/** Read a Web response body without ever accumulating more than the declared byte budget. */
export async function readResponseBodyBounded(
  response: Response,
  maxBytes: number,
  label = "response body",
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error(`${label}: invalid byte limit`);

  const rawLength = response.headers.get("content-length");
  const declaredLength = rawLength !== null && /^\d+$/.test(rawLength) ? Number(rawLength) : undefined;
  if (declaredLength !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${label}: body exceeds ${maxBytes} bytes`);
  }
  if (!response.body) throw new Error(`${label}: body is missing`);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label}: body exceeds ${maxBytes} bytes`);
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

/** Stop an unneeded provider response without materializing its body. */
export async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  await response.body.cancel().catch(() => undefined);
}
