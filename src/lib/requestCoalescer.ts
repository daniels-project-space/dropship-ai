/** Small in-process TTL cache that also joins concurrent identical read-only requests. */
export class RequestCoalescer<T> {
  private readonly entries = new Map<string, { expiresAt: number; value?: T; pending?: Promise<T> }>();

  constructor(private readonly ttlMs: number) {}

  async get(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > now) {
      if (existing.pending) return existing.pending;
      if (existing.value !== undefined) return existing.value;
    }
    const pending = load().then((value) => {
      this.entries.set(key, { expiresAt: Date.now() + this.ttlMs, value });
      return value;
    }).catch((error) => {
      this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, { expiresAt: now + this.ttlMs, pending });
    return pending;
  }
}
