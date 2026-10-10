/**
 * Tiny bounded in-memory TTL cache for public, non-user-scoped read endpoints.
 * Concurrent misses for one key share a single loader call (no stampede).
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 200,
  ) {}

  async get(key: string, load: () => Promise<T>, now = Date.now()): Promise<T> {
    if (this.ttlMs <= 0) return load();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) return hit.value;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const promise = load()
      .then((value) => {
        if (this.entries.size >= this.maxEntries) {
          const oldest = this.entries.keys().next().value;
          if (oldest !== undefined) this.entries.delete(oldest);
        }
        this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.entries.clear();
  }
}
