/**
 * In-memory login throttle: per-key failed-attempt counter with a sliding
 * window. Prototype-scope (single process); a real deployment needs a shared
 * store so throttling survives restarts and spans replicas.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

export class LoginThrottle {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly maxAttempts = 5,
    private readonly windowMs = 15 * 60_000
  ) {}

  /** True when this key is currently allowed to attempt a login. */
  allow(key: string): boolean {
    const b = this.buckets.get(key);
    if (!b) return true;
    if (Date.now() >= b.resetAt) {
      this.buckets.delete(key);
      return true;
    }
    return b.count < this.maxAttempts;
  }

  recordFailure(key: string): void {
    const now = Date.now();
    const b = this.buckets.get(key);
    if (!b || now >= b.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      b.count++;
    }
  }

  clear(key: string): void {
    this.buckets.delete(key);
  }

  /** Seconds until the lock lifts (for Retry-After style messaging). */
  retryAfterSeconds(key: string): number {
    const b = this.buckets.get(key);
    if (!b) return 0;
    return Math.max(1, Math.ceil((b.resetAt - Date.now()) / 1000));
  }
}

/**
 * Fixed-window rate limiter for biometric PROBES (scan-&-pay attempts, self
 * tests). Unlike LoginThrottle it counts every attempt, successful or not: the
 * goal is to bound how much match information any caller can harvest over time
 * (score-oracle / forgery-refinement mitigation). Prototype-scope, single
 * process — production needs a shared store at the edge.
 */
export class ProbeThrottle {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly maxProbes = 30,
    private readonly windowMs = 60_000
  ) {}

  /** Consume one probe slot; false when the caller is over budget this window. */
  take(key: string): boolean {
    const now = Date.now();
    const b = this.buckets.get(key);
    if (!b || now >= b.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (b.count >= this.maxProbes) return false;
    b.count++;
    return true;
  }

  retryAfterSeconds(key: string): number {
    const b = this.buckets.get(key);
    if (!b) return 0;
    return Math.max(1, Math.ceil((b.resetAt - Date.now()) / 1000));
  }
}
