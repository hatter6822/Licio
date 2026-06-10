// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Progressive auth-attempt rate limiting (WS-D.1.3d).  Failures on EVERY method
// (WebAuthn assertion, email one-time code, wallet signature) feed the same
// counters, so no method is exempt from brute-force throttling.
//
// PRIVACY (SPEC §19.1): there is NO per-IP (or any client-network-identity)
// dimension — the application never reads the client address.  The two
// dimensions are both identity-free or first-party:
//   per-account:  5 fails → 30s cooldown, 10 → 2m, 20 → 30m lock (+ owner
//                 alert), keyed by a non-reversible account ref — protects the
//                 account under attack.
//   global:       every failure (attributed or not) also feeds ONE process-wide
//                 counter; past the threshold the auth surface throttles for a
//                 cooling-off period.  This is the backstop against credential
//                 spraying and junk-signature brute force at scale, costing the
//                 attacker the endpoint rather than tracking who they are.
//   success resets the per-account counter.
//
// The clock is injected so the sliding windows and cooldowns are deterministically
// testable without real time.

export interface AuthRateLimits {
  windowMs: number;
  account: {
    softDelayAt: number;
    softDelayMs: number;
    hardDelayAt: number;
    hardDelayMs: number;
    lockAt: number;
    lockMs: number;
  };
  global: {
    throttleAt: number;
    throttleMs: number;
  };
}

export const AUTH_RATE_LIMITS: AuthRateLimits = {
  windowMs: 15 * 60_000,
  account: {
    softDelayAt: 5,
    softDelayMs: 30_000,
    hardDelayAt: 10,
    hardDelayMs: 2 * 60_000,
    lockAt: 20,
    lockMs: 30 * 60_000,
  },
  global: {
    throttleAt: 1_000,
    throttleMs: 5 * 60_000,
  },
};

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
  /** True when the process-wide failure backstop engaged. */
  globalThrottled: boolean;
}

const acctFailKey = (k: string) => `authfail:acct:${k}`;
// Soft cooldowns (5/10 thresholds) and the hard 30-minute lock (20 threshold) use
// SEPARATE keys so a prior soft cooldown never masks the transition into the hard
// lock — the owner alert must fire exactly once when the hard lock engages.
const acctCooldownKey = (k: string) => `authcooldown:acct:${k}`;
const acctLockKey = (k: string) => `authlock:acct:${k}`;
const GLOBAL_FAIL_KEY = 'authfail:global';
const GLOBAL_LOCK_KEY = 'authlock:global';

export class AuthRateLimiter {
  readonly #store: AuthRateLimitStore;
  readonly #now: () => number;
  readonly #limits: AuthRateLimits;

  constructor(
    store: AuthRateLimitStore,
    now: () => number = () => Date.now(),
    limits: AuthRateLimits = AUTH_RATE_LIMITS,
  ) {
    this.#store = store;
    this.#now = now;
    this.#limits = limits;
  }

  /**
   * Pre-attempt gate.  Returns `allowed: false` with a `Retry-After` when the
   * account is in cooldown/lock or the global backstop is throttling.  Identical
   * shape regardless of whether the account exists (no enumeration).
   */
  async check(accountKey: string): Promise<RateLimitDecision> {
    const now = this.#now();
    const cooldown = (await this.#store.getLock(acctCooldownKey(accountKey), now)) ?? 0;
    const lock = (await this.#store.getLock(acctLockKey(accountKey), now)) ?? 0;
    const globalThrottle = (await this.#store.getLock(GLOBAL_LOCK_KEY, now)) ?? 0;
    const remaining = Math.max(cooldown, lock, globalThrottle);
    return remaining > 0
      ? { allowed: false, retryAfterSec: Math.ceil(remaining / 1000) }
      : { allowed: true, retryAfterSec: 0 };
  }

  /**
   * Record one authentication failure and apply escalation.  `accountKey` is null
   * when the attempt cannot be safely attributed to an account (e.g. an invalid
   * wallet signature with no trustworthy signer) — then only the global counter
   * moves, so junk identifiers cannot poison a victim's account counter.  EVERY
   * failure feeds the global window, so a spray across many accounts (each below
   * its per-account threshold) still trips the backstop.
   */
  async recordFailure(accountKey: string | null): Promise<FailureOutcome> {
    const now = this.#now();
    const { windowMs, account, global } = this.#limits;

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

    const globalCount = await this.#store.recordFailure(GLOBAL_FAIL_KEY, now, windowMs);
    let globalThrottled = false;
    if (globalCount >= global.throttleAt) {
      await this.#store.setLock(GLOBAL_LOCK_KEY, now + global.throttleMs);
      globalThrottled = true;
    }

    return { retryAfterSec: Math.ceil(cooldownMs / 1000), lockoutTriggered, globalThrottled };
  }

  /** Successful auth clears the per-account failure counter (WS-D.1.3d). */
  async recordSuccess(accountKey: string): Promise<void> {
    await this.#store.reset(acctFailKey(accountKey));
    await this.#store.setLock(acctCooldownKey(accountKey), 0);
    await this.#store.setLock(acctLockKey(accountKey), 0);
  }
}
