// ============================================================================
// Bloco N2 — Rate limiter e circuit breaker por host.
// FAIL-CLOSED: quando o limiter não pode decidir, a requisição é recusada.
// ============================================================================

export interface RateLimiterOptions {
  maxRequests: number; // requisições permitidas na janela
  windowMs: number; // janela de tempo (ms)
}

export class SlidingWindowRateLimiter {
  private hits: Map<string, number[]> = new Map();

  constructor(private readonly options: RateLimiterOptions) {}

  // Retorna true se a requisição é permitida (e registra o hit).
  tryAcquire(key: string): boolean {
    const now = Date.now();
    const window = this.options.windowMs;
    const max = this.options.maxRequests;
    let timestamps = this.hits.get(key) ?? [];
    timestamps = timestamps.filter(t => now - t < window);
    if (timestamps.length >= max) {
      this.hits.set(key, timestamps);
      return false; // rate limited
    }
    timestamps.push(now);
    this.hits.set(key, timestamps);
    return true;
  }

  remaining(key: string): number {
    const now = Date.now();
    const timestamps = (this.hits.get(key) ?? []).filter(t => now - t < this.options.windowMs);
    return Math.max(0, this.options.maxRequests - timestamps.length);
  }

  reset(): void {
    this.hits.clear();
  }
}

export interface CircuitBreakerState {
  state: "closed" | "open" | "half-open";
  failures: number;
  failuresInWindow: number;
  openedAt: number | null;
}

export class CircuitBreaker {
  private failures: Map<string, { timestamps: number[]; openedAt: number | null }> = new Map();

  constructor(
    private readonly failureThreshold: number,
    private readonly windowMs: number,
  ) {}

  // Registra uma falha. Retorna o estado após o registro.
  recordFailure(key: string): CircuitBreakerState {
    const entry = this.ensureEntry(key);
    const now = Date.now();
    entry.timestamps = entry.timestamps.filter(t => now - t < this.windowMs);
    entry.timestamps.push(now);
    const inWindow = entry.timestamps.length;
    if (inWindow >= this.failureThreshold && entry.openedAt === null) {
      entry.openedAt = now;
    }
    return this.snapshot(key);
  }

  // Registra um sucesso (reseta o breaker se estava aberto e half-open).
  recordSuccess(key: string): void {
    const entry = this.ensureEntry(key);
    // Um sucesso após a abertura confirma half-open → fechado.
    entry.openedAt = null;
    entry.timestamps = [];
  }

  // Permite a requisição? open → bloqueia até a janela expirar.
  allowsRequest(key: string): boolean {
    const entry = this.ensureEntry(key);
    const now = Date.now();
    if (entry.openedAt === null) return true;
    // Janela expirou → half-open: permite UMA tentativa.
    if (now - entry.openedAt >= this.windowMs) return true;
    return false; // open: bloqueado
  }

  state(key: string): CircuitBreakerState {
    return this.snapshot(key);
  }

  reset(): void {
    this.failures.clear();
  }

  private ensureEntry(key: string) {
    let entry = this.failures.get(key);
    if (!entry) {
      entry = { timestamps: [], openedAt: null };
      this.failures.set(key, entry);
    }
    return entry;
  }

  private snapshot(key: string): CircuitBreakerState {
    const entry = this.ensureEntry(key);
    const now = Date.now();
    const inWindow = entry.timestamps.filter(t => now - t < this.windowMs).length;
    let state: CircuitBreakerState["state"] = "closed";
    if (entry.openedAt !== null) {
      state = now - entry.openedAt >= this.windowMs ? "half-open" : "open";
    } else if (inWindow >= this.failureThreshold) {
      state = "open";
    }
    return { state, failures: entry.timestamps.length, failuresInWindow: inWindow, openedAt: entry.openedAt };
  }
}
