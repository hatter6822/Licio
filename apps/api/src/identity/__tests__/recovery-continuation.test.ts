// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The recovery-code CONTINUATION primitives (WS-D.1.5).
//
// A recovery code records which session it was spent to verify, so a grant that
// failed after the consumption committed can still be finished — otherwise the
// LAST code is lost to a fault on our side and the account with it.  That makes
// the continuation a small piece of shared mutable state with several claimants,
// and these are the properties the route depends on.
//
// Note on scope: the route is currently kept single-winner by the ROTATION,
// which takes the old session atomically (`sessions.test.ts`).  The claim below
// is the second lock — it holds even for a completion path that does not
// rotate — so it is tested here at the primitive rather than through a route
// case that the rotation alone would already satisfy.
import { defaultPersonalizationSettings, defaultPrivacySettings } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../crypto.js';
import { InMemoryIdentityStore } from '../store.js';

const CODE = sha256Hex('recovery-code-1');
const OTHER = sha256Hex('recovery-code-2');
/** Any instant inside the resume window — expiry has its own case below. */
const SINCE = new Date(0).toISOString();

let USER = '';

async function storeWithSpentCode(): Promise<InMemoryIdentityStore> {
  const store = new InMemoryIdentityStore();
  const user = await store.createUser({
    handle: 'continuation',
    displayName: 'Continuation',
    email: null,
    accountState: 'active',
    locale: null,
    ageBand: 'adult',
    privacySettings: defaultPrivacySettings(),
    personalizationSettings: defaultPersonalizationSettings(),
    roles: ['user'],
  });
  USER = user.userId;
  await store.setAuth(USER, { recoveryCodeHashes: [CODE, OTHER] });
  await store.consumeRecoveryCode(USER, CODE, 'session-a');
  return store;
}

describe('clearResumableVerification', () => {
  it('reports whether THIS caller cleared it — exactly one of two does', async () => {
    // The settle is also the CLAIM. The same-session resume arm has no
    // compare-and-set available (the continuation already names the caller), so
    // without a single-winner settle two concurrent retries carrying one cookie
    // both complete the verification.
    const store = await storeWithSpentCode();
    const results = await Promise.all([
      store.clearResumableVerification(USER, CODE, 'session-a'),
      store.clearResumableVerification(USER, CODE, 'session-a'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.findResumableVerification(USER, CODE, SINCE)).toBeNull();
  });

  it('reports false when there was no continuation to clear', async () => {
    const store = await storeWithSpentCode();
    expect(await store.clearResumableVerification(USER, OTHER, 'session-a')).toBe(false);
  });
});

describe('findResumableVerification', () => {
  it('names the session the code was spent for', async () => {
    const store = await storeWithSpentCode();
    expect(await store.findResumableVerification(USER, CODE, SINCE)).toEqual({
      remaining: 1,
      verificationSessionHash: 'session-a',
    });
  });

  it('LAPSES past the resume window', async () => {
    // A continuation describes an operation in flight, and in flight has a
    // duration. Unbounded, a row whose settle failed stays adoptable forever and
    // becomes a second use of a single-use code once the sessions its grant
    // created have expired.
    const store = await storeWithSpentCode();
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await store.findResumableVerification(USER, CODE, future)).toBeNull();
  });

  it('is cleared by a factor RESET — re-enrolling ends what it was about', async () => {
    const store = await storeWithSpentCode();
    await store.setAuth(USER, { recoveryCodeHashes: [sha256Hex('fresh')] });
    expect(await store.findResumableVerification(USER, CODE, SINCE)).toBeNull();
  });
});

describe('claimResumableVerification', () => {
  it('rebinds only while the row still names the session the caller saw', async () => {
    // Two primary-authenticated sessions can both find the original gone and
    // both conclude they may finish it. The rebind settles which.
    const store = await storeWithSpentCode();
    const results = await Promise.all([
      store.claimResumableVerification(USER, CODE, 'session-a', 'session-b'),
      store.claimResumableVerification(USER, CODE, 'session-a', 'session-c'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const after = await store.findResumableVerification(USER, CODE, SINCE);
    // Whichever won, the row names ONE of them and never both.
    expect(['session-b', 'session-c']).toContain(after?.verificationSessionHash);
  });

  it('refuses a rebind from a session the row does not name', async () => {
    const store = await storeWithSpentCode();
    expect(await store.claimResumableVerification(USER, CODE, 'wrong', 'session-b')).toBe(false);
    expect(
      (await store.findResumableVerification(USER, CODE, SINCE))?.verificationSessionHash,
    ).toBe('session-a');
  });
});
