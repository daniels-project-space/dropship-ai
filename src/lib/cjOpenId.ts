/** Choose the durable CJ account identity and reject a stale environment alias without exposure. */
export function selectCjOpenId(vaultOpenId: string | null, environmentOpenId: string | undefined): string | null {
  if (vaultOpenId) {
    if (environmentOpenId && environmentOpenId !== vaultOpenId) {
      throw new Error("cj: durable and environment openId configuration conflict");
    }
    return vaultOpenId;
  }
  return environmentOpenId ?? null;
}
