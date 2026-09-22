/**
 * ───────────────────── Rate limiting (P2-E §44) ─────────────────────
 * Provider-agnostic interface with a fixed-window in-memory adapter (dev/MVP).
 * A distributed adapter (e.g. Redis) implements the same interface later
 * without touching call sites. Never used for correctness — only abuse damping.
 */
export interface RateLimiter {
  check(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterMs: number };

type Bucket = { count: number; resetAt: number };

export class InMemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, Bucket>();

  async check(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true };
    }
    if (bucket.count >= limit) {
      return { allowed: false, retryAfterMs: bucket.resetAt - now };
    }
    bucket.count += 1;
    return { allowed: true };
  }

  reset(): void {
    this.buckets.clear();
  }
}

/** Process-wide limiter (single-node dev; swap via DI for distributed deploys). */
export const rateLimiter: RateLimiter = new InMemoryRateLimiter();

export const RATE_LIMITS = {
  login: { limit: 5, windowMs: 60_000 }, // 5/min per IP+phone
  paymentInitiate: { limit: 10, windowMs: 60_000 },
  paymentCallback: { limit: 30, windowMs: 60_000 },
  returnSubmit: { limit: 5, windowMs: 300_000 },
  csvImport: { limit: 5, windowMs: 300_000 },
  sellerMutation: { limit: 120, windowMs: 60_000 },
} as const;
