/**
 * Fixed-window, in-process limiter for socket.io handshakes. Deliberately not
 * Redis-backed: it must stay cheaper than the token/DB lookup it protects.
 * Generous enough for a campus NAT of students reconnecting.
 */
export class HandshakeLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.hits.size >= this.maxKeys) this.sweep(now);
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
    // Still full of live keys: drop the oldest insertions rather than grow unbounded.
    if (this.hits.size >= this.maxKeys) {
      const drop = this.hits.size - this.maxKeys + 1;
      let i = 0;
      for (const key of this.hits.keys()) {
        if (i++ >= drop) break;
        this.hits.delete(key);
      }
    }
  }
}

export const handshakeLimiter = new HandshakeLimiter(60, 60_000);
