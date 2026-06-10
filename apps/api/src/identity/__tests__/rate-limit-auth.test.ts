// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The limiter is IDENTITY-FREE (SPEC §19.1): there is no per-IP dimension of any
// kind.  Escalation is per-account (a non-reversible ref of the account under
// attack) plus one global process-wide backstop that every failure feeds.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUTH_RATE_LIMITS,
  AuthRateLimiter,
  type AuthRateLimits,
  InMemoryAuthRateLimitStore,
} from '../rate-limit-auth.js';

// Small global threshold so the backstop is exercisable without 1 000 calls.
const TEST_LIMITS: AuthRateLimits = {
  ...AUTH_RATE_LIMITS,
  global: { throttleAt: 60, throttleMs: AUTH_RATE_LIMITS.global.throttleMs },
};

describe('AuthRateLimiter progressive thresholds', () => {
  let now = 1_700_000_000_000;
  let store: InMemoryAuthRateLimitStore;
  let limiter: AuthRateLimiter;

  beforeEach(() => {
    now = 1_700_000_000_000;
    store = new InMemoryAuthRateLimitStore();
    limiter = new AuthRateLimiter(store, () => now, TEST_LIMITS);
  });

  async function fail(times: number) {
    let last = { retryAfterSec: 0, lockoutTriggered: false, globalThrottled: false };
    for (let i = 0; i < times; i += 1) last = await limiter.recordFailure('acct1');
    return last;
  }

  it('applies a 30s cooldown at 5 failures', async () => {
    await fail(4);
    const fifth = await limiter.recordFailure('acct1');
    expect(fifth.retryAfterSec).toBe(30);
    expect((await limiter.check('acct1')).allowed).toBe(false);
  });

  it('applies a 2m cooldown at 10 failures', async () => {
    const tenth = await fail(10);
    expect(tenth.retryAfterSec).toBe(120);
  });

  it('hard-locks for 30m at 20 failures and fires the owner alert exactly once', async () => {
    const outcomes: boolean[] = [];
    for (let i = 0; i < 25; i += 1) {
      outcomes.push((await limiter.recordFailure('acct1')).lockoutTriggered);
    }
    // Exactly one failure (the 20th) reports the lockout transition.
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(outcomes[19]).toBe(true);
    const decision = await limiter.check('acct1');
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSec).toBe(AUTH_RATE_LIMITS.account.lockMs / 1000);
  });

  it('trips the GLOBAL backstop on a spray across many accounts', async () => {
    // Each account stays below its own 5-failure cooldown (4 each), but the
    // aggregate crosses the global threshold — credential spraying is caught
    // without any per-client identity.
    for (let i = 0; i < 15; i += 1) {
      for (let j = 0; j < 4; j += 1) await limiter.recordFailure(`acct-${i}`);
    }
    const last = await limiter.recordFailure('acct-final');
    expect(last.globalThrottled).toBe(true);
    // The backstop gates even an account that has never failed.
    expect((await limiter.check('fresh-account')).allowed).toBe(false);
  });

  it('resets the per-account counter on success', async () => {
    await fail(5);
    // Advance past the cooldown so the lock is not what is gating us.
    now += AUTH_RATE_LIMITS.account.softDelayMs + 1;
    await limiter.recordSuccess('acct1');
    // After reset, four more failures should NOT re-trigger the 5-failure cooldown.
    const outcome = await (async () => {
      let last = { retryAfterSec: 0, lockoutTriggered: false, globalThrottled: false };
      for (let i = 0; i < 4; i += 1) last = await limiter.recordFailure('acct1');
      return last;
    })();
    expect(outcome.retryAfterSec).toBe(0);
  });

  it('slides the window: old failures age out and stop counting', async () => {
    await fail(4);
    // Jump beyond the window; the 4 prior failures are now stale.
    now += AUTH_RATE_LIMITS.windowMs + 1;
    const next = await limiter.recordFailure('acct1');
    // This is effectively the 1st in-window failure ⇒ no cooldown yet.
    expect(next.retryAfterSec).toBe(0);
  });

  it('returns an identical (allowed) decision before any failures', async () => {
    expect(await limiter.check('unknown')).toEqual({ allowed: true, retryAfterSec: 0 });
  });

  it('with a null account key, only the global counter accumulates (no account lock)', async () => {
    // Unattributable failures never poison any account's counter…
    for (let i = 0; i < 10; i += 1) {
      const out = await limiter.recordFailure(null);
      expect(out.retryAfterSec).toBe(0);
    }
    expect((await limiter.check('victim-account')).allowed).toBe(true);
    // …but they still climb toward the global backstop.
    for (let i = 0; i < 49; i += 1) await limiter.recordFailure(null);
    const last = await limiter.recordFailure(null);
    expect(last.globalThrottled).toBe(true);
  });

  it('the global throttle expires after its cooling-off period', async () => {
    for (let i = 0; i < 60; i += 1) await limiter.recordFailure(null);
    expect((await limiter.check('anyone')).allowed).toBe(false);
    now += TEST_LIMITS.global.throttleMs + 1;
    // The lock has lapsed; the (stale-windowed) counter no longer gates checks.
    expect((await limiter.check('anyone')).allowed).toBe(true);
  });

  it('a success clears a pending cooldown immediately (not just the counter)', async () => {
    await fail(5); // sets a 30s cooldown
    expect((await limiter.check('acct1')).allowed).toBe(false);
    await limiter.recordSuccess('acct1');
    expect((await limiter.check('acct1')).allowed).toBe(true);
  });
});
