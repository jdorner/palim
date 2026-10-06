/**
 * Brute-force protection for the login endpoint.
 *
 * Tracks failed login attempts per client IP and per username independently.
 * After a number of free failures, each further failure locks the key for an
 * exponentially growing delay (capped). Tracking the username as well as the
 * IP means a distributed attack on one account is throttled even when every
 * attempt comes from a different address. A successful login clears both keys.
 *
 * State is in-memory (resets on restart) and bounded: stale entries are pruned
 * and the oldest entries are evicted once the map reaches its size cap, so a
 * flood of distinct usernames cannot grow memory without limit.
 *
 * @module
 */

/** Tunables for {@link LoginThrottle}. */
export interface LoginThrottleOptions {
  /** Failures allowed per key before lockouts start. */
  freeFailures?: number;
  /** Lockout after the first failure beyond the free allowance (ms); doubles per further failure. */
  baseDelayMs?: number;
  /** Upper bound for a single lockout (ms). */
  maxDelayMs?: number;
  /** A key with no failure for this long is forgotten (ms). */
  forgetAfterMs?: number;
  /** Maximum number of tracked keys before the oldest are evicted. */
  maxEntries?: number;
  /** Clock override for tests. */
  now?: () => number;
}

/** Per-key failure state. */
interface Entry {
  /** Consecutive failures since the last success or expiry. */
  failures: number;
  /** Epoch ms of the most recent failure. */
  lastFailureAt: number;
  /** Epoch ms until which the key is locked (0 = not locked). */
  lockedUntil: number;
}

/**
 * In-memory login failure tracker with exponential lockouts.
 */
export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly freeFailures: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly forgetAfterMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  /**
   * Create a LoginThrottle.
   *
   * @param opts - Optional tunables; defaults allow 5 free failures, then 1s doubling up to 15 minutes.
   */
  constructor(opts: LoginThrottleOptions = {}) {
    this.freeFailures = opts.freeFailures ?? 5;
    this.baseDelayMs = opts.baseDelayMs ?? 1_000;
    this.maxDelayMs = opts.maxDelayMs ?? 15 * 60_000;
    this.forgetAfterMs = opts.forgetAfterMs ?? 60 * 60_000;
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Remaining lockout for a login attempt, considering both the IP and the username.
   *
   * @param ip - The client address.
   * @param username - The submitted username.
   * @returns Milliseconds until an attempt is allowed again, or 0 when allowed now.
   */
  retryAfterMs(ip: string, username: string): number {
    const now = this.now();
    let wait = 0;
    for (const key of this.keys(ip, username)) {
      const entry = this.live(key, now);
      if (entry) wait = Math.max(wait, entry.lockedUntil - now);
    }
    return Math.max(0, wait);
  }

  /**
   * Record a failed login attempt for both the IP and the username.
   *
   * @param ip - The client address.
   * @param username - The submitted username.
   */
  recordFailure(ip: string, username: string): void {
    const now = this.now();
    for (const key of this.keys(ip, username)) {
      const entry = this.live(key, now) ?? { failures: 0, lastFailureAt: now, lockedUntil: 0 };
      entry.failures++;
      entry.lastFailureAt = now;
      const excess = entry.failures - this.freeFailures;
      if (excess > 0) {
        const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (excess - 1));
        entry.lockedUntil = now + delay;
      }
      // Re-insert so Map order reflects recency for eviction.
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    this.evict(now);
  }

  /**
   * Clear failure state after a successful login.
   *
   * @param ip - The client address.
   * @param username - The authenticated username.
   */
  recordSuccess(ip: string, username: string): void {
    for (const key of this.keys(ip, username)) this.entries.delete(key);
  }

  /** Builds the IP and username keys (usernames are matched case-insensitively). */
  private keys(ip: string, username: string): [string, string] {
    return [`ip:${ip}`, `user:${username.toLowerCase()}`];
  }

  /** Returns the entry for a key unless it is stale (dropping stale ones). */
  private live(key: string, now: number): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now - entry.lastFailureAt > this.forgetAfterMs && entry.lockedUntil <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Drops stale entries from the front, then the oldest entries beyond the size cap. */
  private evict(now: number): void {
    for (const key of this.entries.keys()) {
      if (this.live(key, now)) break;
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
