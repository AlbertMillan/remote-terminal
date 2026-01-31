/**
 * Simple token bucket rate limiter for WebSocket messages
 */
export class RateLimiter {
  private tokens: Map<string, number> = new Map();
  private lastRefill: Map<string, number> = new Map();
  private readonly maxTokens: number;
  private readonly refillRateMs: number;

  /**
   * @param maxTokens Maximum tokens (messages) allowed in the bucket
   * @param refillRateMs Time in ms to refill one token
   */
  constructor(maxTokens: number = 100, refillRateMs: number = 10) {
    this.maxTokens = maxTokens;
    this.refillRateMs = refillRateMs;
  }

  /**
   * Try to acquire a token for the given client
   * @returns true if token was acquired, false if rate limited
   */
  tryAcquire(clientId: string): boolean {
    const now = Date.now();

    // Initialize or refill tokens
    if (!this.tokens.has(clientId)) {
      this.tokens.set(clientId, this.maxTokens);
      this.lastRefill.set(clientId, now);
    } else {
      // Refill tokens based on time elapsed
      const lastRefill = this.lastRefill.get(clientId) || now;
      const elapsed = now - lastRefill;
      const tokensToAdd = Math.floor(elapsed / this.refillRateMs);

      if (tokensToAdd > 0) {
        const currentTokens = this.tokens.get(clientId) || 0;
        this.tokens.set(clientId, Math.min(this.maxTokens, currentTokens + tokensToAdd));
        this.lastRefill.set(clientId, now);
      }
    }

    // Try to consume a token
    const currentTokens = this.tokens.get(clientId) || 0;
    if (currentTokens > 0) {
      this.tokens.set(clientId, currentTokens - 1);
      return true;
    }

    return false;
  }

  /**
   * Remove a client from the rate limiter (e.g., on disconnect)
   */
  removeClient(clientId: string): void {
    this.tokens.delete(clientId);
    this.lastRefill.delete(clientId);
  }

  /**
   * Get remaining tokens for a client (for debugging)
   */
  getRemainingTokens(clientId: string): number {
    return this.tokens.get(clientId) || 0;
  }
}
