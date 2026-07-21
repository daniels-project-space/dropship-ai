export interface CjTokenBundle {
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiryDate?: string;
  refreshTokenExpiryDate?: string;
}

export interface RotatedCjTokenBundle extends CjTokenBundle {
  refreshToken: string;
}

/**
 * The control plane owns the durable compare-and-swap. A conflict means another instance
 * already rotated the one-time refresh token, so callers must reload rather than refresh again.
 */
export interface CjTokenBundleStore {
  read: () => Promise<CjTokenBundle>;
  replace: (expectedRefreshToken: string | undefined, next: RotatedCjTokenBundle) => Promise<"written" | "conflict">;
}

export class CjTokenCoordinator {
  private active: CjTokenBundle | null = null;
  private refreshInFlight: Promise<string> | null = null;

  constructor(
    private readonly store: CjTokenBundleStore,
    private readonly refresh: (refreshToken: string) => Promise<RotatedCjTokenBundle>,
    private readonly exchangeCode: (authorizationCode: string) => Promise<RotatedCjTokenBundle>,
  ) {}

  async getAccessToken(): Promise<string> {
    if (!this.active) this.active = await this.store.read();
    return this.active.accessToken;
  }

  /** Refresh once per process and persist the complete rotated pair before serving it. */
  async refreshAccessToken(): Promise<string> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      const current = this.active ?? await this.store.read();
      if (!current.refreshToken) throw new Error("cj: no refresh token — add CJ_REFRESH_TOKEN to the server vault/control plane");
      const next = await this.refresh(current.refreshToken);
      const result = await this.store.replace(current.refreshToken, next);
      if (result === "written") {
        this.active = next;
        return next.accessToken;
      }
      // A different instance won the compare-and-swap. The durable bundle, not either process
      // cache, is now authoritative.
      this.active = await this.store.read();
      return this.active.accessToken;
    })();
    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  /** Initial authorization-code setup uses the same atomic bundle boundary as a refresh. */
  async exchangeAuthorizationCode(authorizationCode: string): Promise<string> {
    if (!authorizationCode.trim()) throw new Error("cj: authorizationCode is required");
    const current = this.active ?? await this.store.read().catch(() => null);
    const next = await this.exchangeCode(authorizationCode);
    const result = await this.store.replace(current?.refreshToken, next);
    if (result !== "written") throw new Error("cj: authorization-code bundle write conflicted; reload the durable credential state before retrying");
    this.active = next;
    return next.accessToken;
  }
}
