// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  emptyReputationSummary,
} from '@licio/shared';
import { describe, expect, it } from 'vitest';
import { identityConfigFromEnv } from '../services.js';
import { type IdentityStore, InMemoryIdentityStore } from '../store.js';

async function newUser(
  store: IdentityStore,
  over: { handle?: string; email?: string | null } = {},
) {
  return await store.createUser({
    handle: over.handle ?? 'u',
    displayName: 'U',
    email: over.email === undefined ? 'u@example.com' : over.email,
    accountState: 'active',
    locale: null,
    ageBand: 'adult',
    privacySettings: defaultPrivacySettings(),
    personalizationSettings: defaultPersonalizationSettings(),
    reputationSummary: emptyReputationSummary(),
    roles: ['user'],
  });
}

describe('IdentityStore users', () => {
  it('creates and looks up by id, handle (case-insensitive), and email', async () => {
    const store = new InMemoryIdentityStore();
    const user = await newUser(store, { handle: 'Alice', email: 'Alice@Example.com' });
    expect((await store.getUser(user.userId))?.handle).toBe('Alice');
    expect((await store.getUserByHandle('alice'))?.userId).toBe(user.userId);
    expect((await store.getUserByEmail('alice@example.com'))?.userId).toBe(user.userId);
    expect(await store.getUserByHandle('missing')).toBeNull();
    expect(await store.getUserByEmail('missing@example.com')).toBeNull();
  });

  it('updates a user and bumps updatedAt; returns null for a missing user', async () => {
    const store = new InMemoryIdentityStore();
    const user = await newUser(store);
    const updated = await store.updateUser(
      user.userId,
      { displayName: 'Renamed' },
      Date.parse(user.createdAt) + 1000,
    );
    expect(updated?.displayName).toBe('Renamed');
    expect(updated?.updatedAt).not.toBe(user.createdAt);
    expect(await store.updateUser('missing', {})).toBeNull();
  });

  it('seeds an empty user_auth row and updates it; setAuth on a missing user is null', async () => {
    const store = new InMemoryIdentityStore();
    const user = await newUser(store);
    expect((await store.getAuth(user.userId))?.emailVerified).toBe(false);
    await store.setAuth(user.userId, { emailVerified: true });
    expect((await store.getAuth(user.userId))?.emailVerified).toBe(true);
    expect(await store.setAuth('missing', { emailVerified: true })).toBeNull();
  });
});

describe('IdentityStore credentials', () => {
  it('adds/lists/gets/deletes webauthn credentials', async () => {
    const store = new InMemoryIdentityStore();
    const user = await newUser(store);
    await store.addWebauthn({
      credentialId: 'c1',
      userId: user.userId,
      publicKey: new Uint8Array([1]),
      counter: 0,
      deviceType: 'platform',
      deviceName: null,
      transports: [],
      backedUp: false,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });
    expect(await store.listWebauthn(user.userId)).toHaveLength(1);
    expect((await store.getWebauthn('c1'))?.userId).toBe(user.userId);
    await store.deleteWebauthn('c1');
    expect(await store.listWebauthn(user.userId)).toHaveLength(0);
    expect(await store.getWebauthn('c1')).toBeNull();
  });

  it('adds/finds/lists/deletes auth-wallet credentials by hash', async () => {
    const store = new InMemoryIdentityStore();
    const user = await newUser(store);
    await store.addWalletAuth({
      credentialId: 'w1',
      userId: user.userId,
      addressHash: 'hash-abc',
      addressTruncated: '0x12…34',
      chainId: 1,
      walletType: 'eoa',
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });
    expect((await store.findWalletAuthByHash('hash-abc'))?.userId).toBe(user.userId);
    expect(await store.findWalletAuthByHash('nope')).toBeNull();
    expect(await store.listWalletAuth(user.userId)).toHaveLength(1);
    await store.deleteWalletAuth('w1');
    expect(await store.listWalletAuth(user.userId)).toHaveLength(0);
  });
});

describe('IdentityStore export jobs + deletions', () => {
  it('tracks one active job, updates it, and returns null for missing', async () => {
    const store = new InMemoryIdentityStore();
    const user = await newUser(store);
    expect(await store.activeExportJob(user.userId)).toBeNull();
    const job = await store.createExportJob(user.userId);
    expect((await store.activeExportJob(user.userId))?.jobId).toBe(job.jobId);
    const done = await store.updateExportJob(job.jobId, { status: 'completed', progressPct: 100 });
    expect(done?.status).toBe('completed');
    // A completed job is no longer "active".
    expect(await store.activeExportJob(user.userId)).toBeNull();
    expect((await store.getExportJob(job.jobId))?.progressPct).toBe(100);
    expect(await store.updateExportJob('missing', {})).toBeNull();
    expect(await store.getExportJob('missing')).toBeNull();
  });

  it('stores and reads deletion requests', async () => {
    const store = new InMemoryIdentityStore();
    const user = await newUser(store);
    expect(await store.getDeletion(user.userId)).toBeNull();
    await store.setDeletion({
      userId: user.userId,
      state: 'grace_period',
      requestedAt: new Date().toISOString(),
      purgeAt: new Date().toISOString(),
      cancelledAt: null,
      completedAt: null,
    });
    expect((await store.getDeletion(user.userId))?.state).toBe('grace_period');
  });
});

describe('IdentityStore.purgeUser', () => {
  it('removes the user and every dependent record (complete removal)', async () => {
    const store = new InMemoryIdentityStore();
    const user = await newUser(store);
    await store.addWebauthn({
      credentialId: 'c1',
      userId: user.userId,
      publicKey: new Uint8Array([1]),
      counter: 0,
      deviceType: 'platform',
      deviceName: null,
      transports: [],
      backedUp: false,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });
    await store.addWalletAuth({
      credentialId: 'w1',
      userId: user.userId,
      addressHash: 'h',
      addressTruncated: '0x…',
      chainId: 1,
      walletType: 'eoa',
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });
    await store.createExportJob(user.userId);

    await store.purgeUser(user.userId);
    expect(await store.getUser(user.userId)).toBeNull();
    expect(await store.getAuth(user.userId)).toBeNull();
    expect(await store.listWebauthn(user.userId)).toHaveLength(0);
    expect(await store.listWalletAuth(user.userId)).toHaveLength(0);
    expect(await store.activeExportJob(user.userId)).toBeNull();
  });
});

describe('identityConfigFromEnv', () => {
  it('derives rpID/domain/uri from the canonical origin', async () => {
    const config = identityConfigFromEnv({
      SESSION_SECRET: 'x'.repeat(40),
      CORS_ORIGIN: 'https://licio.app/',
    });
    expect(config.webauthn.rpID).toBe('licio.app');
    expect(config.webauthn.origin).toBe('https://licio.app');
    expect(config.siwe.domain).toBe('licio.app');
    expect(config.siwe.uri).toBe('https://licio.app');
    expect(config.masterSecret).toBe('x'.repeat(40));
  });

  it('strips a port from the rpID but keeps it in the domain binding', async () => {
    const config = identityConfigFromEnv({
      SESSION_SECRET: 'x'.repeat(40),
      CORS_ORIGIN: 'http://localhost:5173',
    });
    expect(config.webauthn.rpID).toBe('localhost');
    expect(config.siwe.domain).toBe('localhost:5173');
  });

  it('tolerates a non-URL origin without throwing', async () => {
    const config = identityConfigFromEnv({
      SESSION_SECRET: 'x'.repeat(40),
      CORS_ORIGIN: 'not-a-url',
    });
    expect(config.webauthn.rpID).toBe('not-a-url');
  });
});
