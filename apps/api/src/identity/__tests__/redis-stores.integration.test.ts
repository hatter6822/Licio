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
      ipHash: 'h',
      userAgent: 'ua',
      deviceLabel: 'dev',
      country: 'US',
      rememberMe: false,
    });
    const b = await createSession(store, {
      userId,
      authMethod: 'email_otp',
      credentialRef: null,
      ipHash: 'h',
      userAgent: 'ua',
      deviceLabel: 'dev2',
      country: 'GB',
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
});
