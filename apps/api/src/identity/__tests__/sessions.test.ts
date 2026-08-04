// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../crypto.js';
import {
  buildSessionCookie,
  type CreateSessionInput,
  clearSessionCookie,
  createSession,
  InMemorySessionStore,
  markMfaVerified,
  markStepUp,
  needsStepUp,
  readSessionToken,
  revokeAllForUser,
  revokeOthersForUser,
  rotateSession,
  SESSION_POLICY,
  sessionSummaries,
  touchSession,
  validateSession,
} from '../sessions.js';

const SECRET = 'a'.repeat(48);
const USER = '11111111-1111-4111-8111-111111111111';

function input(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    userId: USER,
    authMethod: 'webauthn',
    credentialRef: 'cred-1',
    deviceLabel: 'Test Device',
    rememberMe: false,
    ...overrides,
  };
}

describe('createSession', () => {
  it('stores the session under sha256(token), never the raw token', async () => {
    const store = new InMemorySessionStore();
    const t0 = 1_700_000_000_000;
    const created = await createSession(store, input(), t0);

    expect(await store.get(created.token)).toBeNull(); // raw token is not a key
    expect(await store.get(sha256Hex(created.token))).not.toBeNull();
    expect(created.tokenHash).toBe(sha256Hex(created.token));
    expect(created.record.auth_assurance.level).toBe('full');
    // Absolute cap is 90 days out.
    expect(Date.parse(created.record.absolute_expires_at)).toBe(t0 + SESSION_POLICY.absoluteCapMs);
  });

  it('uses the 30-day TTL for remember-me and 24h otherwise', async () => {
    const store = new InMemorySessionStore();
    const t0 = 1_700_000_000_000;
    const remembered = await createSession(store, input({ rememberMe: true }), t0);
    const ephemeral = await createSession(store, input({ rememberMe: false }), t0);
    expect(remembered.expiresAt).toBe(t0 + SESSION_POLICY.rememberTtlMs);
    expect(ephemeral.expiresAt).toBe(t0 + SESSION_POLICY.defaultTtlMs);
  });
});

describe('validateSession', () => {
  it('accepts a live session and rejects an unknown token', async () => {
    const store = new InMemorySessionStore();
    const t0 = 1_700_000_000_000;
    const created = await createSession(store, input(), t0);
    expect(await validateSession(store, created.token, t0)).not.toBeNull();
    expect(await validateSession(store, 'bogus', t0)).toBeNull();
  });

  it('rejects (and deletes) a session past its sliding expiry', async () => {
    const store = new InMemorySessionStore();
    const t0 = 1_700_000_000_000;
    const created = await createSession(store, input(), t0);
    const result = await validateSession(
      store,
      created.token,
      t0 + SESSION_POLICY.defaultTtlMs + 1,
    );
    expect(result).toBeNull();
    expect(await store.get(created.tokenHash)).toBeNull(); // pruned
  });

  it('rejects once past the ABSOLUTE cap even if the sliding expiry is in the future', async () => {
    const store = new InMemorySessionStore();
    const t0 = 1_700_000_000_000;
    const created = await createSession(store, input(), t0);
    // Force an absolute cap in the past while leaving sliding expiry far ahead.
    await store.put(created.tokenHash, {
      record: { ...created.record, absolute_expires_at: new Date(t0 - 1).toISOString() },
      expiresAt: t0 + SESSION_POLICY.defaultTtlMs,
    });
    expect(await validateSession(store, created.token, t0)).toBeNull();
  });
});

describe('touchSession', () => {
  it('is throttled within the slide window and extends expiry after it', async () => {
    const store = new InMemorySessionStore();
    const t0 = 1_700_000_000_000;
    const created = await createSession(store, input(), t0);

    await touchSession(store, created.tokenHash, t0 + 60_000); // within 5 min ⇒ no change
    expect((await store.get(created.tokenHash))?.record.last_active_at).toBe(
      created.record.last_active_at,
    );

    const later = t0 + SESSION_POLICY.slideThrottleMs + 1;
    await touchSession(store, created.tokenHash, later);
    const stored = await store.get(created.tokenHash);
    expect(stored?.record.last_active_at).toBe(new Date(later).toISOString());
    expect(stored?.expiresAt).toBe(later + SESSION_POLICY.defaultTtlMs);
  });
});

describe('rotateSession', () => {
  it('invalidates the old token, issues a working new one, and preserves other sessions', async () => {
    const store = new InMemorySessionStore();
    const t0 = 1_700_000_000_000;
    const a = await createSession(store, input(), t0);
    const b = await createSession(store, input(), t0); // a second concurrent session

    const rotated = await rotateSession(store, a.token, t0);
    expect(rotated).not.toBeNull();
    expect(await validateSession(store, a.token, t0)).toBeNull(); // old gone
    expect(await validateSession(store, rotated?.token as string, t0)).not.toBeNull();
    expect(await validateSession(store, b.token, t0)).not.toBeNull(); // sibling preserved
  });

  it('returns null when the old token does not exist', async () => {
    const store = new InMemorySessionStore();
    expect(await rotateSession(store, 'nope', Date.now())).toBeNull();
  });

  it('gives ONE successor when two callers rotate the same token at once', async () => {
    // A rotation is a HAND-OFF, so exactly one caller may perform it. Read-then-
    // delete was not that: both callers passed the read, both wrote a successor,
    // and one session became two — a privilege transition that multiplies
    // instead of moving, and the shape a stolen cookie replayed alongside the
    // genuine request used to keep a session of its own.
    const store = new InMemorySessionStore();
    const t0 = 1_700_000_000_000;
    const a = await createSession(store, input(), t0);

    const [first, second] = await Promise.all([
      rotateSession(store, a.token, t0),
      rotateSession(store, a.token, t0),
    ]);

    expect([first, second].filter((r) => r !== null)).toHaveLength(1);
    expect(await validateSession(store, a.token, t0)).toBeNull(); // the old one is gone
    // …and the user is left holding exactly one session, not two.
    expect(await store.listForUser(USER)).toHaveLength(1);
  });
});

describe('putIfPresent', () => {
  it('does not RESURRECT a session deleted since the caller read it', async () => {
    // Every session mutation is a read-then-write (`get`, edit, `put`), and a
    // plain `put` does not care whether the row survived the gap — so a
    // concurrent rotation or sign-out was UNDONE by the write, restoring the
    // deleted session with whatever privilege the edit was adding. That is how
    // two concurrent MFA verifications on one cookie left the rotated successor
    // verified AND the old session back from the dead and verified.
    const store = new InMemorySessionStore();
    const t0 = 1_700_000_000_000;
    const a = await createSession(store, input(), t0);

    const read = await store.get(a.tokenHash); // the caller's read…
    expect(read).not.toBeNull();
    await store.delete(a.tokenHash); // …a rotation or revocation lands…

    // …and the write finds nothing to update.
    expect(await store.putIfPresent(a.tokenHash, read as NonNullable<typeof read>)).toBe(false);
    expect(await store.get(a.tokenHash)).toBeNull();
    expect(await store.listForUser(USER)).toHaveLength(0);
  });

  it('writes, and reports it, while the session is still there', async () => {
    const store = new InMemorySessionStore();
    const t0 = 1_700_000_000_000;
    const a = await createSession(store, input(), t0);
    const read = (await store.get(a.tokenHash)) as NonNullable<
      Awaited<ReturnType<typeof store.get>>
    >;
    const updated = { ...read, record: { ...read.record, mfa_verified: true } };
    expect(await store.putIfPresent(a.tokenHash, updated)).toBe(true);
    expect((await store.get(a.tokenHash))?.record.mfa_verified).toBe(true);
  });
});

describe('step-up', () => {
  it('is not needed for a fresh session and is needed once the window elapses', async () => {
    const store = new InMemorySessionStore();
    const t0 = 1_700_000_000_000;
    const created = await createSession(store, input(), t0);
    expect(needsStepUp(created.record, t0)).toBe(false);
    expect(needsStepUp(created.record, t0 + SESSION_POLICY.stepUpWindowMs + 1)).toBe(true);
  });

  it('markStepUp refreshes the assurance clock', async () => {
    const store = new InMemorySessionStore();
    const t0 = 1_700_000_000_000;
    const created = await createSession(store, input(), t0);
    const later = t0 + SESSION_POLICY.stepUpWindowMs + 60_000;
    await markStepUp(store, created.tokenHash, later);
    const record = (await store.get(created.tokenHash))?.record;
    expect(record && needsStepUp(record, later)).toBe(false);
  });

  it('markMfaVerified flips the session mfa_verified flag', async () => {
    const store = new InMemorySessionStore();
    const t0 = 1_700_000_000_000;
    const created = await createSession(store, input(), t0);
    expect(created.record.mfa_verified).toBe(false);
    await markMfaVerified(store, created.tokenHash, t0 + 1000);
    expect((await store.get(created.tokenHash))?.record.mfa_verified).toBe(true);
  });
});

describe('revocation', () => {
  it('revokeOthersForUser keeps only the current session', async () => {
    const store = new InMemorySessionStore();
    const t0 = 1_700_000_000_000;
    const current = await createSession(store, input(), t0);
    await createSession(store, input(), t0);
    await createSession(store, input(), t0);
    const revoked = await revokeOthersForUser(store, USER, current.tokenHash);
    expect(revoked).toBe(2);
    expect(await validateSession(store, current.token, t0)).not.toBeNull();
    expect((await store.listForUser(USER)).length).toBe(1);
  });

  it('revokeAllForUser removes every session', async () => {
    const store = new InMemorySessionStore();
    const t0 = 1_700_000_000_000;
    await createSession(store, input(), t0);
    await createSession(store, input(), t0);
    expect(await revokeAllForUser(store, USER)).toBe(2);
    expect((await store.listForUser(USER)).length).toBe(0);
  });
});

describe('sessionSummaries', () => {
  it('exposes a non-reversible ref + device descriptor, flags current, and leaks no token/IP/location', async () => {
    const store = new InMemorySessionStore();
    const t0 = 1_700_000_000_000;
    const current = await createSession(store, input(), t0);
    await createSession(store, input({ deviceLabel: 'Other' }), t0 + 1000);

    const summaries = await sessionSummaries(store, USER, current.tokenHash, SECRET, t0 + 2000);
    expect(summaries).toHaveLength(2);
    const currentSummary = summaries.find((s) => s.current);
    expect(currentSummary?.device_label).toBe('Test Device');
    // No location field exists on the summary (§19.1).
    expect('country' in (currentSummary ?? {})).toBe(false);
    expect(currentSummary?.session_ref).not.toContain(current.token);
    for (const s of summaries) {
      expect(JSON.stringify(s)).not.toContain(current.token);
    }
  });
});

describe('concurrency cap', () => {
  it('evicts the oldest sessions beyond the cap', async () => {
    const store = new InMemorySessionStore();
    let t = 1_700_000_000_000;
    for (let i = 0; i <= SESSION_POLICY.maxConcurrent; i += 1) {
      await createSession(store, input(), t);
      t += 1000;
    }
    expect((await store.listForUser(USER)).length).toBe(SESSION_POLICY.maxConcurrent);
  });
});

describe('cookie helpers', () => {
  it('builds a __Host- session cookie with the hardened attributes and no Domain', () => {
    const cookie = buildSessionCookie('tok', 3600);
    expect(cookie).toContain('__Host-sid=tok');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Domain');
    expect(cookie).toContain('Max-Age=3600');
  });

  it('clears the cookie with Max-Age=0', () => {
    expect(clearSessionCookie()).toContain('Max-Age=0');
  });

  it('reads the session token from a cookie header', () => {
    expect(readSessionToken('__Host-sid=abc123; other=1')).toBe('abc123');
    expect(readSessionToken('other=1')).toBeUndefined();
    expect(readSessionToken(undefined)).toBeUndefined();
  });
});

describe('concurrency cap', () => {
  it('caps concurrent sessions, evicting the oldest (deletions are awaited)', async () => {
    const store = new InMemorySessionStore();
    let t = 1_000;
    const hashes: string[] = [];
    for (let i = 0; i < SESSION_POLICY.maxConcurrent + 3; i += 1) {
      // Strictly increasing created_at so the eviction order is deterministic.
      hashes.push((await createSession(store, input(), t)).tokenHash);
      t += 1;
    }
    // Immediately after the final createSession resolves (its eviction awaited),
    // exactly the cap remains — the three OLDEST were evicted, newest retained.
    const live = await store.listForUser(USER);
    expect(live).toHaveLength(SESSION_POLICY.maxConcurrent);
    const liveHashes = new Set(live.map((s) => s.tokenHash));
    expect(hashes.slice(0, 3).some((h) => liveHashes.has(h))).toBe(false);
    expect(hashes.slice(3).every((h) => liveHashes.has(h))).toBe(true);
  });
});
