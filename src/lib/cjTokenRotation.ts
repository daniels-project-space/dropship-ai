export interface CjTokenBundle {
  openId: string;
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiryDate?: string;
  refreshTokenExpiryDate?: string;
}

export interface RotatedCjTokenBundle extends CjTokenBundle {
  refreshToken: string;
}

export interface RotatedCjTokenPair extends Omit<RotatedCjTokenBundle, "openId"> {}

/**
 * The control plane owns the durable compare-and-swap. A conflict means another instance
 * already rotated the one-time refresh token, so callers must reload rather than refresh again.
 */
export interface CjTokenBundleStore {
  read: () => Promise<CjTokenBundle>;
  replace: (expectedRefreshToken: string | undefined, next: RotatedCjTokenBundle) => Promise<"written" | "conflict">;
}

function assertBundle(bundle: CjTokenBundle): CjTokenBundle {
  if (!bundle || typeof bundle.openId !== "string" || !/^[0-9]{1,20}$/.test(bundle.openId)
    || typeof bundle.accessToken !== "string" || !bundle.accessToken.trim()
    || (bundle.refreshToken !== undefined && (typeof bundle.refreshToken !== "string" || !bundle.refreshToken.trim()))
    || (bundle.accessTokenExpiryDate !== undefined && typeof bundle.accessTokenExpiryDate !== "string")
    || (bundle.refreshTokenExpiryDate !== undefined && typeof bundle.refreshTokenExpiryDate !== "string")) {
    throw new Error("cj: durable token bundle is invalid");
  }
  return bundle;
}

function sameBundle(a: CjTokenBundle, b: CjTokenBundle): boolean {
  return a.openId === b.openId && a.accessToken === b.accessToken && a.refreshToken === b.refreshToken
    && a.accessTokenExpiryDate === b.accessTokenExpiryDate && a.refreshTokenExpiryDate === b.refreshTokenExpiryDate;
}

export class CjTokenCoordinator {
  private active: CjTokenBundle | null = null;
  private refreshInFlight: Promise<string> | null = null;

  constructor(
    private readonly store: CjTokenBundleStore,
    private readonly refresh: (refreshToken: string) => Promise<RotatedCjTokenPair>,
    private readonly connect: (apiKey: string) => Promise<RotatedCjTokenBundle>,
  ) {}

  async getAccessToken(): Promise<string> {
    if (!this.active) this.active = assertBundle(await this.store.read());
    return this.active.accessToken;
  }

  /** Refresh once per process and persist the complete rotated pair before serving it. */
  async refreshAccessToken(): Promise<string> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      // A 401 may be observed by a warm instance after another process has already consumed
      // CJ's one-time refresh token. Reload the durable winner before any refresh request.
      const cached = this.active;
      const durable = assertBundle(await this.store.read());
      if (cached && !sameBundle(cached, durable)) {
        this.active = durable;
        return durable.accessToken;
      }
      const current = cached ?? durable;
      if (!current.refreshToken) throw new Error("cj: no refresh token — add CJ_REFRESH_TOKEN to the server vault/control plane");
      const rotated = await this.refresh(current.refreshToken);
      // CJ's refresh response intentionally omits openId. It is part of the atomic bundle and
      // must be copied only from the durable bundle that authorized this rotation.
      const next: RotatedCjTokenBundle = { ...rotated, openId: current.openId };
      const result = await this.store.replace(current.refreshToken, next);
      if (result === "written") {
        this.active = next;
        return next.accessToken;
      }
      // A different instance won the compare-and-swap. The durable bundle, not either process
      // cache, is now authoritative.
      this.active = assertBundle(await this.store.read());
      return this.active.accessToken;
    })();
    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  /** Initial independent-account setup uses CJ's API key and one complete atomic bundle write. */
  async connectApiKey(apiKey: string): Promise<void> {
    if (!apiKey.trim()) throw new Error("cj: apiKey is required");
    const current = this.active ?? await this.store.read().catch(() => null);
    const next = assertBundle(await this.connect(apiKey)) as RotatedCjTokenBundle;
    const result = await this.store.replace(current?.refreshToken, next);
    if (result !== "written") throw new Error("cj: API-key bundle write conflicted; reload the durable credential state before retrying");
    this.active = next;
  }
}
