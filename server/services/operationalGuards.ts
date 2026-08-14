export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  check(key: string): RateLimitDecision {
    const current = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= current) {
      this.prune(current);
      this.buckets.set(key, { count: 1, resetAt: current + this.windowMs });
      return { allowed: true, remaining: Math.max(0, this.limit - 1), retryAfterSeconds: 0 };
    }

    if (bucket.count >= this.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - current) / 1000)),
      };
    }

    bucket.count += 1;
    return { allowed: true, remaining: Math.max(0, this.limit - bucket.count), retryAfterSeconds: 0 };
  }

  private prune(current: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= current) this.buckets.delete(key);
    }
    if (this.buckets.size <= this.maxKeys) return;
    const oldest = [...this.buckets.entries()]
      .sort((a, b) => a[1].resetAt - b[1].resetAt)
      .slice(0, this.buckets.size - this.maxKeys);
    for (const [key] of oldest) this.buckets.delete(key);
  }
}

export interface BudgetDecision {
  allowed: boolean;
  used: number;
  limit: number;
  resetAt: number;
}

export class ExternalCallBudget {
  private readonly buckets = new Map<string, { used: number; resetAt: number }>();

  constructor(
    private readonly limits: Record<string, number>,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  reserve(name: string, amount = 1): BudgetDecision {
    const limit = this.limits[name] ?? 0;
    const current = this.now();
    const existing = this.buckets.get(name);
    const bucket = !existing || existing.resetAt <= current
      ? { used: 0, resetAt: current + this.windowMs }
      : existing;

    if (limit <= 0 || bucket.used + amount > limit) {
      this.buckets.set(name, bucket);
      return { allowed: false, used: bucket.used, limit, resetAt: bucket.resetAt };
    }

    bucket.used += amount;
    this.buckets.set(name, bucket);
    return { allowed: true, used: bucket.used, limit, resetAt: bucket.resetAt };
  }

  snapshot(name: string): BudgetDecision {
    const limit = this.limits[name] ?? 0;
    const bucket = this.buckets.get(name);
    return { allowed: true, used: bucket?.used || 0, limit, resetAt: bucket?.resetAt || this.now() + this.windowMs };
  }
}
