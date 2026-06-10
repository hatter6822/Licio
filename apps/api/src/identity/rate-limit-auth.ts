// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Progressive auth-attempt rate limiting (WS-D.1.3d).  Failures on EVERY method
// (WebAuthn assertion, email one-time code, wallet signature) feed the same
// per-account and per-IP counters, so no method is exempt from brute-force
// throttling.  Keys are non-reversible: the account key is a keyed hash and the
// IP key is a keyed hash — no plaintext IP is retained.
//
//   per-account:  5 fails → 30s cooldown, 10 → 2m, 20 → 30m lock (+ owner alert)
//   per-IP:       50 fails → 15m block
//   success resets the per-account counter.
//
// The clock is injected so the sliding windows and cooldowns are deterministically
// testable without real time.

export const AUTH_RATE_LIMITS = {
  windowMs: 15 * 60_000,
  account: {
    softDelayAt: 5,
    softDelayMs: 30_000,
    hardDelayAt: 10,
    hardDelayMs: 2 * 60_000,
    lockAt: 20,
    lockMs: 30 * 60_000,
  },
  ip: {
    blockAt: 50,
    blockMs: 15 * 60_000,
  },
} as const;

export interface AuthRateLimitStore {
  /** Record one failure in the sliding window for `key`; return the in-window count. */
  recordFailure(key: string, now: number, windowMs: number): Promise<number>;
  /** Drop all recorded failures for `key` (called on success). */
  reset(key: string): Promise<void>;
  /** Set a lock/cooldown on `key` until `untilMs`. */
  setLock(key: string, untilMs: number): Promise<void>;
  /** Remaining lock milliseconds for `key`, or null if not locked. */
  getLock(key: string, now: number): Promise<number | null>;
  clear(): Promise<void>;
}

export class InMemoryAuthRateLimitStore implements AuthRateLimitStore {
  readonly #fails = new Map<string, number[]>();
  readonly #locks = new Map<string, number>();

  async recordFailure(key: string, now: number, windowMs: number): Promise<number> {
    const pruned = (this.#fails.get(key) ?? []).filter((t) => t > now - windowMs);
    pruned.push(now);
    this.#fails.set(key, pruned);
    return pruned.length;
  }

  async reset(key: string): Promise<void> {
    this.#fails.delete(key);
  }

  async setLock(key: string, untilMs: number): Promise<void> {
    this.#locks.set(key, untilMs);
  }

  async getLock(key: string, now: number): Promise<number | null> {
    const until = this.#locks.get(key);
    if (until === undefined) return null;
    if (until <= now) {
      this.#locks.delete(key);
      return null;
    }
    return until - now;
  }

  async clear(): Promise<void> {
    this.#fails.clear();
    this.#locks.clear();
  }
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSec: number;
}

export interface FailureOutcome {
  /** Cooldown the caller should surface as `Retry-After`, in seconds (0 if none). */
  retryAfterSec: number;
  /** True exactly once when the account crosses into the 30-minute hard lock. */
  lockoutTriggered: boolean;
  /** True when the per-IP block engaged. */
  ipBlocked: boolean;
}

const acctFailKey = (k: string) => `authfail:acct:${k}`;
// Soft cooldowns (5/10 thresholds) and the hard 30-minute lock (20 threshold) use
// SEPARATE keys so a prior soft cooldown never masks the transition into the hard
// lock — the owner alert must fire exactly once when the hard lock engages.
const acctCooldownKey = (k: string) => `authcooldown:acct:${k}`;
const acctLockKey = (k: string) => `authlock:acct:${k}`;
const ipFailKey = (k: string) => `authfail:ip:${k}`;
const ipLockKey = (k: string) => `authlock:ip:${k}`;

export class AuthRateLimiter {
  readonly #store: AuthRateLimitStore;
  readonly #now: () => number;

  constructor(store: AuthRateLimitStore, now: () => number = () => Date.now()) {
    this.#store = store;
    this.#now = now;
  }

  /**
   * Pre-attempt gate.  Returns `allowed: false` with a `Retry-After` when the
   * account is in cooldown/lock or the IP is blocked.  Identical shape regardless
   * of whether the account exists (no enumeration).
   */
  async check(accountKey: string, ipKey: string): Promise<RateLimitDecision> {
    const now = this.#now();
    const cooldown = (await this.#store.getLock(acctCooldownKey(accountKey), now)) ?? 0;
    const lock = (await this.#store.getLock(acctLockKey(accountKey), now)) ?? 0;
    const ipBlock = (await this.#store.getLock(ipLockKey(ipKey), now)) ?? 0;
    const remaining = Math.max(cooldown, lock, ipBlock);
    return remaining > 0
      ? { allowed: false, retryAfterSec: Math.ceil(remaining / 1000) }
      : { allowed: true, retryAfterSec: 0 };
  }

  /**
   * Record one authentication failure and apply escalation.  `accountKey` is null
   * when the attempt cannot be safely attributed to an account (e.g. an invalid
   * wallet signature with no trustworthy signer) — then only the per-IP counter
   * increments, so an attacker cannot evade the per-account limit with junk
   * identifiers nor poison a victim's account counter.
   */
  async recordFailure(accountKey: string | null, ipKey: string): Promise<FailureOutcome> {
    const now = this.#now();
    const { windowMs, account, ip } = AUTH_RATE_LIMITS;

    let cooldownMs = 0;
    let lockoutTriggered = false;
    if (accountKey !== null) {
      const wasHardLocked = (await this.#store.getLock(acctLockKey(accountKey), now)) !== null;
      const acctCount = await this.#store.recordFailure(acctFailKey(accountKey), now, windowMs);
      if (acctCount >= account.lockAt) {
        await this.#store.setLock(acctLockKey(accountKey), now + account.lockMs);
        cooldownMs = account.lockMs;
        lockoutTriggered = !wasHardLocked; // exactly once, on the transition into lock
      } else if (acctCount >= account.hardDelayAt) {
        await this.#store.setLock(acctCooldownKey(accountKey), now + account.hardDelayMs);
        cooldownMs = account.hardDelayMs;
      } else if (acctCount >= account.softDelayAt) {
        await this.#store.setLock(acctCooldownKey(accountKey), now + account.softDelayMs);
        cooldownMs = account.softDelayMs;
      }
    }

    const ipCount = await this.#store.recordFailure(ipFailKey(ipKey), now, windowMs);
    let ipBlocked = false;
    if (ipCount >= ip.blockAt) {
      await this.#store.setLock(ipLockKey(ipKey), now + ip.blockMs);
      ipBlocked = true;
    }

    return { retryAfterSec: Math.ceil(cooldownMs / 1000), lockoutTriggered, ipBlocked };
  }

  /** Successful auth clears the per-account failure counter (WS-D.1.3d). */
  async recordSuccess(accountKey: string): Promise<void> {
    await this.#store.reset(acctFailKey(accountKey));
    await this.#store.setLock(acctCooldownKey(accountKey), 0);
    await this.#store.setLock(acctLockKey(accountKey), 0);
  }
}
