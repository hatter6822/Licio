// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  emptyReputationSummary,
} from '@licio/shared';
import { describe, expect, it } from 'vitest';
import { identityConfigFromEnv } from '../services.js';
import { IdentityStore } from '../store.js';

function newUser(store: IdentityStore, over: { handle?: string; email?: string | null } = {}) {
  return store.createUser({
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
  it('creates and looks up by id, handle (case-insensitive), and email', () => {
    const store = new IdentityStore();
    const user = newUser(store, { handle: 'Alice', email: 'Alice@Example.com' });
    expect(store.getUser(user.userId)?.handle).toBe('Alice');
    expect(store.getUserByHandle('alice')?.userId).toBe(user.userId);
    expect(store.getUserByEmail('alice@example.com')?.userId).toBe(user.userId);
    expect(store.getUserByHandle('missing')).toBeNull();
    expect(store.getUserByEmail('missing@example.com')).toBeNull();
  });

  it('updates a user and bumps updatedAt; returns null for a missing user', () => {
    const store = new IdentityStore();
    const user = newUser(store);
    const updated = store.updateUser(
      user.userId,
      { displayName: 'Renamed' },
      Date.parse(user.createdAt) + 1000,
    );
    expect(updated?.displayName).toBe('Renamed');
    expect(updated?.updatedAt).not.toBe(user.createdAt);
    expect(store.updateUser('missing', {})).toBeNull();
  });

  it('seeds an empty user_auth row and updates it; setAuth on a missing user is null', () => {
    const store = new IdentityStore();
    const user = newUser(store);
    expect(store.getAuth(user.userId)?.emailVerified).toBe(false);
    store.setAuth(user.userId, { emailVerified: true });
    expect(store.getAuth(user.userId)?.emailVerified).toBe(true);
    expect(store.setAuth('missing', { emailVerified: true })).toBeNull();
  });
});

describe('IdentityStore credentials', () => {
  it('adds/lists/gets/deletes webauthn credentials', () => {
    const store = new IdentityStore();
    const user = newUser(store);
    store.addWebauthn({
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
    expect(store.listWebauthn(user.userId)).toHaveLength(1);
    expect(store.getWebauthn('c1')?.userId).toBe(user.userId);
    store.deleteWebauthn('c1');
    expect(store.listWebauthn(user.userId)).toHaveLength(0);
    expect(store.getWebauthn('c1')).toBeNull();
  });

  it('adds/finds/lists/deletes auth-wallet credentials by hash', () => {
    const store = new IdentityStore();
    const user = newUser(store);
    store.addWalletAuth({
      credentialId: 'w1',
      userId: user.userId,
      addressHash: 'hash-abc',
      addressTruncated: '0x12…34',
      chainId: 1,
      walletType: 'eoa',
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });
    expect(store.findWalletAuthByHash('hash-abc')?.userId).toBe(user.userId);
    expect(store.findWalletAuthByHash('nope')).toBeNull();
    expect(store.listWalletAuth(user.userId)).toHaveLength(1);
    store.deleteWalletAuth('w1');
    expect(store.listWalletAuth(user.userId)).toHaveLength(0);
  });
});

describe('IdentityStore export jobs + deletions', () => {
  it('tracks one active job, updates it, and returns null for missing', () => {
    const store = new IdentityStore();
    const user = newUser(store);
    expect(store.activeExportJob(user.userId)).toBeNull();
    const job = store.createExportJob(user.userId);
    expect(store.activeExportJob(user.userId)?.jobId).toBe(job.jobId);
    const done = store.updateExportJob(job.jobId, { status: 'completed', progressPct: 100 });
    expect(done?.status).toBe('completed');
    // A completed job is no longer "active".
    expect(store.activeExportJob(user.userId)).toBeNull();
    expect(store.getExportJob(job.jobId)?.progressPct).toBe(100);
    expect(store.updateExportJob('missing', {})).toBeNull();
    expect(store.getExportJob('missing')).toBeNull();
  });

  it('stores and reads deletion requests', () => {
    const store = new IdentityStore();
    const user = newUser(store);
    expect(store.getDeletion(user.userId)).toBeNull();
    store.setDeletion({
      userId: user.userId,
      state: 'grace_period',
      requestedAt: new Date().toISOString(),
      purgeAt: new Date().toISOString(),
      cancelledAt: null,
      completedAt: null,
    });
    expect(store.getDeletion(user.userId)?.state).toBe('grace_period');
  });
});

describe('IdentityStore.purgeUser', () => {
  it('removes the user and every dependent record (complete removal)', () => {
    const store = new IdentityStore();
    const user = newUser(store);
    store.addWebauthn({
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
    store.addWalletAuth({
      credentialId: 'w1',
      userId: user.userId,
      addressHash: 'h',
      addressTruncated: '0x…',
      chainId: 1,
      walletType: 'eoa',
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });
    store.createExportJob(user.userId);

    store.purgeUser(user.userId);
    expect(store.getUser(user.userId)).toBeNull();
    expect(store.getAuth(user.userId)).toBeNull();
    expect(store.listWebauthn(user.userId)).toHaveLength(0);
    expect(store.listWalletAuth(user.userId)).toHaveLength(0);
    expect(store.activeExportJob(user.userId)).toBeNull();
  });
});

describe('identityConfigFromEnv', () => {
  it('derives rpID/domain/uri from the canonical origin', () => {
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

  it('strips a port from the rpID but keeps it in the domain binding', () => {
    const config = identityConfigFromEnv({
      SESSION_SECRET: 'x'.repeat(40),
      CORS_ORIGIN: 'http://localhost:5173',
    });
    expect(config.webauthn.rpID).toBe('localhost');
    expect(config.siwe.domain).toBe('localhost:5173');
  });

  it('tolerates a non-URL origin without throwing', () => {
    const config = identityConfigFromEnv({
      SESSION_SECRET: 'x'.repeat(40),
      CORS_ORIGIN: 'not-a-url',
    });
    expect(config.webauthn.rpID).toBe('not-a-url');
  });
});
