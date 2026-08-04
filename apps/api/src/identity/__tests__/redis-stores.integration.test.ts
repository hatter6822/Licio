// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATED live-Redis integration test (WS-D).  Runs ONLY when REDIS_URL is set
// (e.g. `docker compose up redis`); CI has no Redis service, so it is skipped
// there.  Validates the production Redis adapters against the same interfaces the
// in-memory stores satisfy.
//
//   REDIS_URL=redis://localhost:6379 pnpm test
//
// Cleanup is scoped to THIS run's own key prefixes.  It used to be
// `redis.flushdb()` in `beforeEach`, which wiped the WHOLE database — including
// the keys of every other gated Redis suite running concurrently in another
// Vitest worker.  That produced a rare, bewildering failure in a completely
// unrelated file (`events/__tests__/redis-event-stores.integration.test.ts`
// asserting `expected 1 to be 3` on a sliding-window counter whose sorted set
// had been deleted between two `hit()` calls).  A test's cleanup may never
// reach beyond the keys it created.
import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { RedisEphemeralStore, RedisSessionStore } from '../redis-stores.js';
import { createSession, type StoredSession } from '../sessions.js';

const REDIS_URL = process.env['REDIS_URL'];

describe.skipIf(!REDIS_URL)('Redis identity adapters', () => {
  const redis = REDIS_URL ? new IORedis(REDIS_URL) : null;
  // Unique per run, so two concurrent runs against one Redis (two developers,
  // two CI jobs) cannot see or delete each other's keys either.
  const run = randomUUID().slice(0, 8);
  const EPH_PREFIX = `test-eph-${run}:`;
  const SESSION_PREFIX = `test-session-${run}:`;

  /** Delete only what this file wrote — never a database-wide flush. */
  async function clearOwnKeys(): Promise<void> {
    if (!redis) return;
    const keys = [
      ...(await redis.keys(`${EPH_PREFIX}*`)),
      ...(await redis.keys(`${SESSION_PREFIX}*`)),
    ];
    if (keys.length > 0) await redis.del(...keys);
  }

  afterEach(clearOwnKeys);

  afterAll(async () => {
    await clearOwnKeys();
    await redis?.quit();
  });

  it('RedisEphemeralStore: set/get/take is single-use and TTL-bounded', async () => {
    const store = new RedisEphemeralStore(redis as IORedis, EPH_PREFIX);
    await store.set('k', 'v', 1000);
    expect(await store.get('k')).toBe('v');
    expect(await store.take('k')).toBe('v');
    expect(await store.get('k')).toBeNull(); // consumed

    await store.set('ttl', 'x', 30);
    await new Promise((r) => setTimeout(r, 60));
    expect(await store.get('ttl')).toBeNull(); // expired
  });

  it('RedisEphemeralStore: setIfAbsent/increment are atomic against LIVE Redis', async () => {
    // The in-memory adapter can be atomic by construction (no await between
    // read and write); Redis cannot, and Redis is what production runs. These
    // two primitives back the MFA attempt cap and the OTP resend cooldown, so
    // "atomic in memory, racy in production" is the failure mode that matters.
    const store = new RedisEphemeralStore(redis as IORedis, EPH_PREFIX);

    const claims = await Promise.all(
      Array.from({ length: 12 }, () => store.setIfAbsent('cooldown', 'x', 60_000)),
    );
    expect(claims.filter((won) => won)).toHaveLength(1);

    const counts = await Promise.all(
      Array.from({ length: 20 }, () => store.increment('attempts', 300_000)),
    );
    expect([...counts].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_unused, i) => i + 1),
    );

    // The window is armed on CREATION only, so a later increment does not push
    // it out (`PEXPIRE` runs under `n == 1` inside the same script).
    //
    // ASK REDIS, do not race it.  This used to arm a 40 ms window and assert
    // the second increment inside a 15 ms margin: on a loaded machine a
    // delayed timer or round trip let the key expire first, and a CORRECT
    // implementation returned 1 and failed the test.  A long window plus the
    // server's own remaining TTL tests the same property — "not re-armed" —
    // with no timing assumption at all.
    const WINDOW_MS = 60_000;
    const ELAPSE_MS = 250;
    await store.increment('longwindow', WINDOW_MS);
    const firstTtl = await (redis as IORedis).pttl(`${EPH_PREFIX}longwindow`);
    expect(firstTtl).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, ELAPSE_MS));
    expect(await store.increment('longwindow', WINDOW_MS)).toBe(2);
    const secondTtl = await (redis as IORedis).pttl(`${EPH_PREFIX}longwindow`);
    // AN ABSOLUTE BOUND, not a comparison between the two reads.
    //
    // `secondTtl < firstTtl` replaced a 40 ms/15 ms race with a SUB-MILLISECOND
    // one, inverted in direction: both `pttl` reads routinely land on the same
    // integer millisecond, so the comparison was decided by whether the second
    // round trip happened to be slower than the first — not by whether the window
    // was re-armed.  Measured against a deliberately broken script (the `n == 1`
    // guard removed, so `PEXPIRE` runs on every call), that assertion passed 8
    // times in 40.  It used to fail a correct implementation; it had come to pass
    // a broken one.
    //
    // The window was armed once at creation, so after `ELAPSE_MS` a correct
    // implementation has strictly less than `WINDOW_MS - ELAPSE_MS` left, while a
    // re-armed one is back at ~`WINDOW_MS`.  Jitter and scheduling delay only make
    // the remaining TTL SMALLER, which is the safe direction — so the margin can
    // never fail a correct implementation, however loaded the machine.
    expect(secondTtl).toBeLessThanOrEqual(WINDOW_MS - ELAPSE_MS + 50);
    expect(secondTtl).toBeGreaterThan(0);

    // …and the window really does end, with a margin wide enough that only a
    // broken expiry can fail it.
    await store.increment('shortwindow', 40);
    await new Promise((r) => setTimeout(r, 400));
    expect(await store.increment('shortwindow', 40)).toBe(1); // window elapsed
  });

  it('RedisSessionStore: stores, lists per user, and deletes', async () => {
    const store = new RedisSessionStore(redis as IORedis, SESSION_PREFIX);
    const userId = '11111111-1111-4111-8111-111111111111';
    const a = await createSession(store, {
      userId,
      authMethod: 'webauthn',
      credentialRef: 'c',
      deviceLabel: 'dev',
      rememberMe: false,
    });
    const b = await createSession(store, {
      userId,
      authMethod: 'email_otp',
      credentialRef: null,
      deviceLabel: 'dev2',
      rememberMe: true,
    });

    const list = await store.listForUser(userId);
    expect(list).toHaveLength(2);

    const fetched: StoredSession | null = await store.get(a.tokenHash);
    expect(fetched?.record.auth_method).toBe('webauthn');

    await store.delete(a.tokenHash);
    expect(await store.get(a.tokenHash)).toBeNull();
    expect(await store.listForUser(userId)).toHaveLength(1);
    expect((await store.listForUser(userId))[0]?.tokenHash).toBe(b.tokenHash);
  });

  it('RedisSessionStore: a slid session stays DISCOVERABLE — the index outlives it', async () => {
    // `SET … XX` extended the session key and left the per-user index on its
    // ORIGINAL TTL. For a user with one session the index could then expire
    // while the session was still valid, and `listForUser` is what the device
    // list, `revokeOthersForUser` and bulk revocation all read — so the session
    // became invisible to every one of them. A live session nobody can sign out
    // is the part that matters.
    //
    // Only real Redis has key expiry at all; the in-memory twin has no index TTL
    // to get wrong.
    const store = new RedisSessionStore(redis as IORedis, SESSION_PREFIX);
    const userId = '77777777-7777-4777-8777-777777777777';
    const a = await createSession(store, {
      userId,
      authMethod: 'webauthn',
      credentialRef: 'c',
      deviceLabel: 'dev',
      rememberMe: false,
    });

    // Squeeze the index down to a hair, as a short-lived session would have.
    const userKey = `${SESSION_PREFIX}user:${userId}`;
    await (redis as IORedis).pexpire(userKey, 40);

    // A slide writes the session further out…
    const read = (await store.get(a.tokenHash)) as StoredSession;
    expect(
      await store.putIfVersion(a.tokenHash, read.version, {
        ...read,
        expiresAt: Date.now() + 60_000,
      }),
    ).toBe(true);

    // …and carries the index with it, rather than letting it lapse underneath.
    await new Promise((r) => setTimeout(r, 120));
    expect(await store.get(a.tokenHash)).not.toBeNull();
    expect(await store.listForUser(userId)).toHaveLength(1);
  });

  it('RedisSessionStore: putIfVersion() refuses a STALE version', async () => {
    // The half `SET … XX` cannot give, and the half most likely to be wrong
    // here: the version is read back out of the stored JSON inside Lua, so a
    // decode that quietly yielded nil would compare 0 against 0 and let every
    // write through while looking correct.
    const store = new RedisSessionStore(redis as IORedis, SESSION_PREFIX);
    const userId = '99999999-9999-4999-8999-999999999999';
    const a = await createSession(store, {
      userId,
      authMethod: 'webauthn',
      credentialRef: 'c',
      deviceLabel: 'dev',
      rememberMe: false,
    });

    const stale = (await store.get(a.tokenHash)) as StoredSession;
    // Someone else's write lands first…
    expect(
      await store.putIfVersion(a.tokenHash, stale.version, {
        ...stale,
        record: { ...stale.record, mfa_verified: true },
      }),
    ).toBe(true);
    expect((await store.get(a.tokenHash))?.version).toBe(stale.version + 1);

    // …and the stale snapshot cannot put its pre-grant copy back.
    expect(await store.putIfVersion(a.tokenHash, stale.version, stale)).toBe(false);
    expect((await store.get(a.tokenHash))?.record.mfa_verified).toBe(true);
  });

  it('RedisSessionStore: rotate() moves the session and its index entry, atomically', async () => {
    // Half a rotation is worse than none: as GETDEL-then-SET, a failure between
    // them left the holder with no session at all — and on the recovery path,
    // where the continuation is settled BEFORE the rotation, no way to resume a
    // spent last code either.
    const store = new RedisSessionStore(redis as IORedis, SESSION_PREFIX);
    const userId = '88888888-8888-4888-8888-888888888888';
    const a = await createSession(store, {
      userId,
      authMethod: 'webauthn',
      credentialRef: 'c',
      deviceLabel: 'dev',
      rememberMe: false,
    });

    const moved = await store.rotate(a.tokenHash, 'newhash-rotate-test');
    expect(moved).not.toBeNull();
    expect(await store.get(a.tokenHash)).toBeNull(); // old gone
    expect(await store.get('newhash-rotate-test')).not.toBeNull(); // new there
    // The index followed, so the moved session is still discoverable — and the
    // stale member is not left behind to be pruned later.
    const listed = await store.listForUser(userId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.tokenHash).toBe('newhash-rotate-test');

    // A rotation of something that is not there moves nothing.
    expect(await store.rotate('absent-hash', 'another')).toBeNull();
    expect(await store.get('another')).toBeNull();
  });

  it('RedisSessionStore: rotate() retries a version conflict rather than reporting absence', async () => {
    // `null` has to mean "no such session" and nothing else. The enroll and
    // disable paths treat a null rotation as "no cookie to rotate" and answer
    // success, so a rotation that gave up on CONTENTION would leave a bearer
    // token unrotated across a privilege change — the thing rotating defends
    // against.
    const store = new RedisSessionStore(redis as IORedis, SESSION_PREFIX);
    const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const a = await createSession(store, {
      userId,
      authMethod: 'webauthn',
      credentialRef: 'c',
      deviceLabel: 'dev',
      rememberMe: false,
    });

    // THE CONFLICT, BY CONSTRUCTION.  An own property shadows the prototype
    // method, so the `this.get` inside `rotate` resolves to this one — the first
    // read hands back a version one BEHIND the stored row, which is exactly what
    // a concurrent writer leaves behind, and the script's check refuses it.
    // (A proxy around the store does not work here: `rotate` calls `this.get` on
    // the instance, so a bound wrapper is never consulted and the test passes
    // whatever the code does.)
    const realGet = store.get.bind(store);
    let staleReads = 1;
    const shadowed: Pick<RedisSessionStore, 'get'> = store;
    shadowed.get = async (hash: string) => {
      const live = await realGet(hash);
      if (live !== null && staleReads > 0) {
        staleReads -= 1;
        return { ...live, version: live.version - 1 };
      }
      return live;
    };

    const moved = await store.rotate(a.tokenHash, 'newhash-conflict-test');
    // The first attempt loses the version check; the retry reads honestly and
    // wins. Without the retry this is `null` and the caller silently skips the
    // rotation.
    expect(moved).not.toBeNull();
    expect(await realGet(a.tokenHash)).toBeNull();
    expect(await realGet('newhash-conflict-test')).not.toBeNull();
  });

  it('RedisSessionStore: take() hands the session to exactly ONE caller', async () => {
    // A rotation is a hand-off, and `take` is what makes it one. Only a real
    // Redis proves it: GETDEL is a single command, whereas the GET+DEL pair it
    // replaced let two concurrent rotations both read the session and both mint
    // a successor — one privilege transition becoming two live sessions.
    const store = new RedisSessionStore(redis as IORedis, SESSION_PREFIX);
    const userId = '55555555-5555-4555-8555-555555555555';
    const a = await createSession(store, {
      userId,
      authMethod: 'webauthn',
      credentialRef: 'c',
      deviceLabel: 'dev',
      rememberMe: false,
    });

    const taken = await Promise.all([store.take(a.tokenHash), store.take(a.tokenHash)]);
    expect(taken.filter((t) => t !== null)).toHaveLength(1);
    expect(await store.get(a.tokenHash)).toBeNull();
    expect(await store.listForUser(userId)).toHaveLength(0);
  });

  it('RedisSessionStore: putIfVersion() refuses a deleted session and a stale version', async () => {
    // Every session mutation is read-then-write, and a plain SET would recreate
    // a session that a concurrent rotation or sign-out had removed — restoring
    // it with whatever privilege the edit was adding. `SET … XX` cannot.
    const store = new RedisSessionStore(redis as IORedis, SESSION_PREFIX);
    const userId = '66666666-6666-4666-8666-666666666666';
    const a = await createSession(store, {
      userId,
      authMethod: 'webauthn',
      credentialRef: 'c',
      deviceLabel: 'dev',
      rememberMe: false,
    });
    const read = (await store.get(a.tokenHash)) as StoredSession;

    // Present ⇒ the write lands and says so.
    expect(
      await store.putIfVersion(a.tokenHash, read.version, {
        ...read,
        record: { ...read.record, mfa_verified: true },
      }),
    ).toBe(true);
    expect((await store.get(a.tokenHash))?.record.mfa_verified).toBe(true);

    // Gone ⇒ the write finds nothing, and does not bring it back.
    await store.delete(a.tokenHash);
    expect(await store.putIfVersion(a.tokenHash, read.version, read)).toBe(false);
    expect(await store.get(a.tokenHash)).toBeNull();
  });

  it('RedisSessionStore: a short session after a long one never SHORTENS the index TTL', async () => {
    const store = new RedisSessionStore(redis as IORedis, SESSION_PREFIX);
    const userId = '22222222-2222-4222-8222-222222222222';
    // Long-lived session first (rememberMe: 30 days)…
    await createSession(store, {
      userId,
      authMethod: 'webauthn',
      credentialRef: 'c',
      deviceLabel: 'laptop',
      rememberMe: true,
    });
    const longTtl = await (redis as IORedis).pttl(`${SESSION_PREFIX}user:${userId}`);
    // …then a short-lived one (24h).  PEXPIRE…GT must leave the index TTL at the
    // longer value, or the long session would vanish from the device list.
    await createSession(store, {
      userId,
      authMethod: 'email_otp',
      credentialRef: null,
      deviceLabel: 'phone',
      rememberMe: false,
    });
    const afterTtl = await (redis as IORedis).pttl(`${SESSION_PREFIX}user:${userId}`);
    expect(afterTtl).toBeGreaterThan(23 * 60 * 60_000); // sanity: index alive
    expect(afterTtl).toBeGreaterThanOrEqual(longTtl - 5_000); // NOT shortened to 24h
    expect(await store.listForUser(userId)).toHaveLength(2);
  });

  it('RedisSessionStore: a corrupt row is deleted and treated as no session (fail closed)', async () => {
    const store = new RedisSessionStore(redis as IORedis, SESSION_PREFIX);
    await (redis as IORedis).set(`${SESSION_PREFIX}deadbeef`, '{"not":"a session"}');
    expect(await store.get('deadbeef')).toBeNull();
    expect(await (redis as IORedis).get(`${SESSION_PREFIX}deadbeef`)).toBeNull(); // purged
  });
});
