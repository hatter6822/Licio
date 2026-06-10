// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATED live-Redis integration test (WS-D).  Runs ONLY when REDIS_URL is set
// (e.g. `docker compose up redis`); CI has no Redis service, so it is skipped
// there.  Validates the production Redis adapters against the same interfaces the
// in-memory stores satisfy.
//
//   REDIS_URL=redis://localhost:6379 pnpm test
import IORedis from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisEphemeralStore, RedisSessionStore } from '../redis-stores.js';
import { createSession, type StoredSession } from '../sessions.js';

const REDIS_URL = process.env['REDIS_URL'];

describe.skipIf(!REDIS_URL)('Redis identity adapters', () => {
  const redis = REDIS_URL ? new IORedis(REDIS_URL) : null;

  afterAll(async () => {
    await redis?.quit();
  });

  beforeEach(async () => {
    await redis?.flushdb();
  });

  it('RedisEphemeralStore: set/get/take is single-use and TTL-bounded', async () => {
    const store = new RedisEphemeralStore(redis as IORedis, 'test-eph:');
    await store.set('k', 'v', 1000);
    expect(await store.get('k')).toBe('v');
    expect(await store.take('k')).toBe('v');
    expect(await store.get('k')).toBeNull(); // consumed

    await store.set('ttl', 'x', 30);
    await new Promise((r) => setTimeout(r, 60));
    expect(await store.get('ttl')).toBeNull(); // expired
  });

  it('RedisSessionStore: stores, lists per user, and deletes', async () => {
    const store = new RedisSessionStore(redis as IORedis, 'test-session:');
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

  it('RedisSessionStore: a short session after a long one never SHORTENS the index TTL', async () => {
    const store = new RedisSessionStore(redis as IORedis, 'test-session:');
    const userId = '22222222-2222-4222-8222-222222222222';
    // Long-lived session first (rememberMe: 30 days)…
    await createSession(store, {
      userId,
      authMethod: 'webauthn',
      credentialRef: 'c',
      deviceLabel: 'laptop',
      rememberMe: true,
    });
    const longTtl = await (redis as IORedis).pttl(`test-session:user:${userId}`);
    // …then a short-lived one (24h).  PEXPIRE…GT must leave the index TTL at the
    // longer value, or the long session would vanish from the device list.
    await createSession(store, {
      userId,
      authMethod: 'email_otp',
      credentialRef: null,
      deviceLabel: 'phone',
      rememberMe: false,
    });
    const afterTtl = await (redis as IORedis).pttl(`test-session:user:${userId}`);
    expect(afterTtl).toBeGreaterThan(23 * 60 * 60_000); // sanity: index alive
    expect(afterTtl).toBeGreaterThanOrEqual(longTtl - 5_000); // NOT shortened to 24h
    expect(await store.listForUser(userId)).toHaveLength(2);
  });

  it('RedisSessionStore: a corrupt row is deleted and treated as no session (fail closed)', async () => {
    const store = new RedisSessionStore(redis as IORedis, 'test-session:');
    await (redis as IORedis).set('test-session:deadbeef', '{"not":"a session"}');
    expect(await store.get('deadbeef')).toBeNull();
    expect(await (redis as IORedis).get('test-session:deadbeef')).toBeNull(); // purged
  });
});
