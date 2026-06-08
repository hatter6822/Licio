import type { Context } from 'hono';

interface RateLimitBucket {
  count: number;
  resetAtMs: number;
}

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, nowMs = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.resetAtMs <= nowMs) {
      this.buckets.set(key, { count: 1, resetAtMs: nowMs + this.windowMs });
      return true;
    }

    if (bucket.count >= this.maxRequests) {
      return false;
    }

    bucket.count += 1;
    return true;
  }
}

export function clientIp(context: Context): string {
  return (
    context.req.header('CF-Connecting-IP') ??
    context.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ??
    'unknown'
  );
}
