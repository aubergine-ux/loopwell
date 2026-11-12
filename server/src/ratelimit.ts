// Fixed-window counters held in memory. Good for one process; put a real
// limiter in front if you run several.

export interface RateResult {
  ok: boolean;
  /** Seconds until the window resets. */
  retryAfter: number;
}

export class RateLimiter {
  private hits = new Map<string, { count: number; reset: number }>();
  private lastPrune = 0;

  hit(key: string, max: number, windowMs: number, now: number): RateResult {
    this.prune(now);
    let entry = this.hits.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      this.hits.set(key, entry);
    }
    entry.count++;
    return { ok: entry.count <= max, retryAfter: Math.max(1, Math.ceil((entry.reset - now) / 1000)) };
  }

  /** Gives a hit back, for requests that turned out not to count. */
  undo(key: string): void {
    const entry = this.hits.get(key);
    if (entry && entry.count > 0) entry.count--;
  }

  private prune(now: number): void {
    if (now - this.lastPrune < 60_000) return;
    this.lastPrune = now;
    for (const [key, entry] of this.hits) {
      if (entry.reset <= now) this.hits.delete(key);
    }
  }
}
