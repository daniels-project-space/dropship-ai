/** Only creative assets may be presigned for browser preview. */
export function isCreativeAssetKey(key: string): boolean {
  return /^creatives\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/.test(key) && !key.includes("..");
}
