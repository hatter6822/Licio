// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUTH_RATE_LIMITS,
  AuthRateLimiter,
  InMemoryAuthRateLimitStore,
} from '../rate-limit-auth.js';

describe('AuthRateLimiter progressive thresholds', () => {
  let now = 1_700_000_000_000;
  let store: InMemoryAuthRateLimitStore;
  let limiter: AuthRateLimiter;

  beforeEach(() => {
    now = 1_700_000_000_000;
    store = new InMemoryAuthRateLimitStore();
    limiter = new AuthRateLimiter(store, () => now);
  });

  async function fail(times: number) {
    let last = { retryAfterSec: 0, lockoutTriggered: false, ipBlocked: false };
    for (let i = 0; i < times; i += 1) last = await limiter.recordFailure('acct1', 'ip1');
    return last;
  }

  it('applies a 30s cooldown at 5 failures', async () => {
    await fail(4);
    const fifth = await limiter.recordFailure('acct1', 'ip1');
    expect(fifth.retryAfterSec).toBe(30);
    expect((await limiter.check('acct1', 'ip1')).allowed).toBe(false);
  });

  it('applies a 2m cooldown at 10 failures', async () => {
    const tenth = await fail(10);
    expect(tenth.retryAfterSec).toBe(120);
  });

  it('hard-locks for 30m at 20 failures and fires the owner alert exactly once', async () => {
    const outcomes: boolean[] = [];
    for (let i = 0; i < 25; i += 1) {
      outcomes.push((await limiter.recordFailure('acct1', 'ip1')).lockoutTriggered);
    }
    // Exactly one failure (the 20th) reports the lockout transition.
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(outcomes[19]).toBe(true);
    const decision = await limiter.check('acct1', 'ip1');
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSec).toBe(AUTH_RATE_LIMITS.account.lockMs / 1000);
  });

  it('blocks the IP at 50 failures across accounts', async () => {
    for (let i = 0; i < 50; i += 1) {
      // Distinct account keys so the per-account lock never gates the IP path.
      await limiter.recordFailure(`acct-${i}`, 'sharedip');
    }
    const last = await limiter.recordFailure('acct-final', 'sharedip');
    expect(last.ipBlocked).toBe(true);
    expect((await limiter.check('fresh-account', 'sharedip')).allowed).toBe(false);
  });

  it('resets the per-account counter on success', async () => {
    await fail(5);
    // Advance past the cooldown so the lock is not what is gating us.
    now += AUTH_RATE_LIMITS.account.softDelayMs + 1;
    await limiter.recordSuccess('acct1');
    // After reset, four more failures should NOT re-trigger the 5-failure cooldown.
    const outcome = await (async () => {
      let last = { retryAfterSec: 0, lockoutTriggered: false, ipBlocked: false };
      for (let i = 0; i < 4; i += 1) last = await limiter.recordFailure('acct1', 'ip1');
      return last;
    })();
    expect(outcome.retryAfterSec).toBe(0);
  });

  it('slides the window: old failures age out and stop counting', async () => {
    await fail(4);
    // Jump beyond the window; the 4 prior failures are now stale.
    now += AUTH_RATE_LIMITS.windowMs + 1;
    const next = await limiter.recordFailure('acct1', 'ip1');
    // This is effectively the 1st in-window failure ⇒ no cooldown yet.
    expect(next.retryAfterSec).toBe(0);
  });

  it('returns an identical (allowed) decision before any failures', async () => {
    expect(await limiter.check('unknown', 'ip')).toEqual({ allowed: true, retryAfterSec: 0 });
  });

  it('with a null account key, only the per-IP counter accumulates (no account lock)', async () => {
    // 10 unattributable failures from one IP: the per-account cooldown never fires…
    for (let i = 0; i < 10; i += 1) {
      const out = await limiter.recordFailure(null, 'badip');
      expect(out.retryAfterSec).toBe(0);
    }
    // …but the IP counter still climbs toward its own block threshold.
    for (let i = 0; i < 40; i += 1) await limiter.recordFailure(null, 'badip');
    const last = await limiter.recordFailure(null, 'badip');
    expect(last.ipBlocked).toBe(true);
  });

  it('a success clears a pending cooldown immediately (not just the counter)', async () => {
    await fail(5); // sets a 30s cooldown
    expect((await limiter.check('acct1', 'ip1')).allowed).toBe(false);
    await limiter.recordSuccess('acct1');
    expect((await limiter.check('acct1', 'ip1')).allowed).toBe(true);
  });
});
