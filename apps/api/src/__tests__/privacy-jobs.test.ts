// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit coverage for the WS-D.2 privacy background pipeline: DSAR export assembly,
// the encrypt-at-rest object store + signed download tokens, the export job state
// machine (process / retry / sweep), and the account-deletion hard purge.  These
// exercise the data-minimization guarantees directly — the archive carries only
// the requesting user's own data, never an address hash, reporter identity, IP,
// or location (§19.1/§19.5).

import type { AgeBand, SecurityActivityEntry } from '@licio/shared';
import { defaultPersonalizationSettings, defaultPrivacySettings } from '@licio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AuditEntryInput, type AuditStore, InMemoryAuditStore } from '../identity/audit.js';
import { sha256Hex } from '../identity/crypto.js';
import {
  EXPORT_DOWNLOAD_TTL_MS,
  InMemoryObjectStore,
  mintDownloadToken,
  verifyDownloadToken,
} from '../identity/object-store.js';
import {
  assembleExport,
  EXPORT_SCHEMA_VERSION,
  exportObjectKey,
  MAX_EXPORT_ATTEMPTS,
  mintExportDownloadToken,
  processExportJob,
  runDeletionPurge,
  startPrivacyScheduler,
  sweepExpiredExports,
} from '../identity/privacy-jobs.js';
import {
  createInMemoryIdentityServices,
  type IdentityConfig,
  type IdentityServices,
} from '../identity/services.js';
import { createSession } from '../identity/sessions.js';

const CONFIG: IdentityConfig = {
  masterSecret: 'test-master-secret-at-least-32-characters-long',
  webauthn: { rpName: 'Licio', rpID: 'localhost', origin: 'http://localhost' },
  siwe: { domain: 'localhost', uri: 'http://localhost', chainAllowlist: [1] },
  signupPow: { maxNumber: 16 },
};

/**
 * Audit store that records every append.  `deletion_complete` is a system event
 * with a null actor, which the owner-scoped `securityActivityForUser` filters
 * out — so we capture raw inputs to assert on it.
 */
class RecordingAuditStore implements AuditStore {
  readonly inputs: AuditEntryInput[] = [];
  readonly #inner = new InMemoryAuditStore();
  async append(input: AuditEntryInput, createdAt?: Date) {
    this.inputs.push(input);
    return this.#inner.append(input, createdAt);
  }
  securityActivityForUser(userId: string, limit?: number): Promise<SecurityActivityEntry[]> {
    return this.#inner.securityActivityForUser(userId, limit);
  }
  async clear(): Promise<void> {
    this.inputs.length = 0;
    await this.#inner.clear();
  }
}

let services: IdentityServices;
let audit: RecordingAuditStore;

beforeEach(async () => {
  services = createInMemoryIdentityServices(CONFIG);
  audit = new RecordingAuditStore();
  services.audit = audit;
});
afterEach(async () => {
  await services.store.clear();
});

async function seedFullUser(ageBand: AgeBand = 'adult') {
  const user = await services.store.createUser({
    handle: 'exporter',
    displayName: 'Export User',
    email: 'export@example.com',
    accountState: 'active',
    locale: 'en-US',
    ageBand,
    privacySettings: defaultPrivacySettings(),
    personalizationSettings: defaultPersonalizationSettings(),
    roles: ['user'],
  });
  await services.store.setAuth(user.userId, { emailVerified: true, mfaEnabled: true });
  await services.store.addWebauthn({
    credentialId: 'cred-1',
    userId: user.userId,
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    deviceType: 'platform',
    deviceName: 'iPhone',
    transports: ['internal'],
    backedUp: true,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  });
  await services.store.addWalletAuth({
    credentialId: 'wallet-1',
    userId: user.userId,
    addressHash: 'SECRET_WALLET_HASH_NEVER_EXPORTED',
    addressTruncated: '0x1234…abcd',
    chainId: 1,
    walletType: 'eoa',
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  });
  return user;
}

describe('assembleExport', () => {
  it("gathers only the requesting user's own data, with a truncated wallet only", async () => {
    const user = await seedFullUser();
    services.exportAttention = async () => [{ bucket: 'topic:tech', weight: 3 }];
    services.exportContributions = async () => [{ id: 'c1', kind: 'post' }];
    services.exportModerationNotices = async () => [{ reason: 'spam', severity: 'low' }];
    services.exportClientState = async () => ({
      settings: { theme: 'dark' },
      reply_notifications: [{ notification_id: 'n1' }],
    });

    const archive = await assembleExport(services, user.userId);
    expect(archive['schema_version']).toBe(EXPORT_SCHEMA_VERSION);

    const account = archive['account'] as Record<string, unknown>;
    expect(account['user_id']).toBe(user.userId);
    expect(account['email']).toBe('export@example.com');
    expect(account['age_band']).toBe('adult');

    const methods = archive['authentication_methods'] as Record<string, unknown>;
    expect((methods['passkeys'] as unknown[]).length).toBe(1);
    expect(methods['mfa_enabled']).toBe(true);
    const wallets = methods['wallets'] as Array<Record<string, unknown>>;
    expect(wallets[0]?.['address']).toBe('0x1234…abcd');

    expect(archive['attention_aggregates']).toEqual([{ bucket: 'topic:tech', weight: 3 }]);
    expect(archive['contributions']).toEqual([{ id: 'c1', kind: 'post' }]);
    expect(archive['moderation_notices']).toEqual([{ reason: 'spam', severity: 'low' }]);
    // WS-C/WS-T durable client state: what deletion purges, export discloses.
    expect(archive['client_state']).toEqual({
      settings: { theme: 'dark' },
      reply_notifications: [{ notification_id: 'n1' }],
    });

    // The raw wallet address hash is NEVER present anywhere in the archive.
    expect(JSON.stringify(archive)).not.toContain('SECRET_WALLET_HASH_NEVER_EXPORTED');
  });

  it('omits the email for a passkey/wallet-only account and defaults absent hooks to []', async () => {
    const user = await services.store.createUser({
      handle: 'nomail',
      displayName: 'No Mail',
      email: null,
      accountState: 'active',
      locale: null,
      ageBand: 'adult',
      privacySettings: defaultPrivacySettings(),
      personalizationSettings: defaultPersonalizationSettings(),
      roles: ['user'],
    });
    const archive = await assembleExport(services, user.userId);
    const account = archive['account'] as Record<string, unknown>;
    expect('email' in account).toBe(false);
    expect(archive['attention_aggregates']).toEqual([]);
    expect(archive['contributions']).toEqual([]);
    expect(archive['moderation_notices']).toEqual([]);
    expect(archive['client_state']).toEqual({});
  });

  it('throws for an unknown user', async () => {
    await expect(assembleExport(services, 'ghost')).rejects.toThrow();
  });
});

describe('object store (encrypt-at-rest + signed tokens)', () => {
  it('round-trips through encryption and 404s a missing key', async () => {
    const store = new InMemoryObjectStore(services.secretBox);
    await store.put('k1', 'super-secret-payload', 'application/json', 10_000);
    const got = await store.get('k1', 5_000);
    expect(got?.bytes.toString('utf8')).toBe('super-secret-payload');
    expect(got?.contentType).toBe('application/json');
    expect(await store.get('missing', 5_000)).toBeNull();
  });

  it('enforces expiry AT READ TIME — an expired object is gone without a sweep', async () => {
    const store = new InMemoryObjectStore(services.secretBox);
    await store.put('k1', 'payload', 'application/json', 10_000);
    expect(await store.get('k1', 9_999)).not.toBeNull();
    // One ms past expiry: unreadable even though no sweeper has run.
    expect(await store.get('k1', 10_000)).toBeNull();
  });

  it('reports expired keys and deletes', async () => {
    const store = new InMemoryObjectStore(services.secretBox);
    await store.put('fresh', 'x', 'application/json', 10_000);
    await store.put('stale', 'y', 'application/json', 1_000);
    expect(await store.expiredKeys(5_000)).toEqual(['stale']);
    await store.delete('stale');
    expect(await store.get('stale', 0)).toBeNull();
  });

  it('mints and verifies a signed download token; rejects tamper/expiry/wrong-subject', async () => {
    const exp = 10_000;
    const token = mintDownloadToken(CONFIG.masterSecret, 'job1', 'user1', exp);
    expect(verifyDownloadToken(CONFIG.masterSecret, token, 'job1', 'user1', exp - 1)).toBe(true);
    // Expired (now >= expiry).
    expect(verifyDownloadToken(CONFIG.masterSecret, token, 'job1', 'user1', exp)).toBe(false);
    // Wrong user / wrong job ⇒ signature mismatch.
    expect(verifyDownloadToken(CONFIG.masterSecret, token, 'job1', 'user2', exp - 1)).toBe(false);
    expect(verifyDownloadToken(CONFIG.masterSecret, token, 'jobX', 'user1', exp - 1)).toBe(false);
    // Tampered signature / malformed token.
    expect(
      verifyDownloadToken(CONFIG.masterSecret, `${exp}.deadbeef`, 'job1', 'user1', exp - 1),
    ).toBe(false);
    expect(verifyDownloadToken(CONFIG.masterSecret, 'garbage', 'job1', 'user1', exp - 1)).toBe(
      false,
    );
  });

  it('rejects non-canonical token forms (extra segments, non-decimal expiry)', async () => {
    const exp = 10_000;
    const token = mintDownloadToken(CONFIG.masterSecret, 'job1', 'user1', exp);
    // Strict 2-part form: a valid token with trailing junk is malformed.
    expect(
      verifyDownloadToken(CONFIG.masterSecret, `${token}.junk`, 'job1', 'user1', exp - 1),
    ).toBe(false);
    // Scientific/hex/negative expiry encodings never verify.
    const sig = token.split('.')[1] as string;
    expect(verifyDownloadToken(CONFIG.masterSecret, `1e4.${sig}`, 'job1', 'user1', 1)).toBe(false);
    expect(verifyDownloadToken(CONFIG.masterSecret, `0x10.${sig}`, 'job1', 'user1', 1)).toBe(false);
    expect(verifyDownloadToken(CONFIG.masterSecret, `-1.${sig}`, 'job1', 'user1', -5)).toBe(false);
  });

  it('caps a freshly minted export token at the archive expiry (never outlives it)', async () => {
    const user = await seedFullUser();
    const job = await services.store.createExportJob(user.userId);
    const t0 = 1_000_000;
    await processExportJob(services, job.jobId, t0);
    const jobExpiry = t0 + EXPORT_DOWNLOAD_TTL_MS;
    // Minted one millisecond before the archive expires: still valid right then…
    const token = await mintExportDownloadToken(services, job.jobId, user.userId, jobExpiry - 1);
    expect(
      verifyDownloadToken(CONFIG.masterSecret, token, job.jobId, user.userId, jobExpiry - 1),
    ).toBe(true);
    // …but dead AT the archive expiry — an uncapped token would have lived
    // another 72 hours past the archive itself.
    expect(verifyDownloadToken(CONFIG.masterSecret, token, job.jobId, user.userId, jobExpiry)).toBe(
      false,
    );
  });
});

describe('startPrivacyScheduler', () => {
  it('runs an immediate tick (sweep + purge) and stops cleanly', async () => {
    const user = await seedFullUser();
    const job = await services.store.createExportJob(user.userId);
    // Complete an export far enough in the past that it is already expired.
    const past = Date.now() - EXPORT_DOWNLOAD_TTL_MS - 1_000;
    await processExportJob(services, job.jobId, past);
    await services.store.setDeletion({
      userId: user.userId,
      state: 'grace_period',
      requestedAt: new Date(past).toISOString(),
      purgeAt: new Date(Date.now() - 1).toISOString(),
      cancelledAt: null,
      completedAt: null,
    });

    const stop = startPrivacyScheduler(services);
    // The startup tick is asynchronous; yield until it lands.
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop();

    expect((await services.store.getDeletion(user.userId))?.state).toBe('deleted');
    expect((await services.store.getUser(user.userId))?.accountState).toBe('deleted');
    expect(await services.objectStore.get(exportObjectKey(job.jobId), Date.now())).toBeNull();
  });

  it('reports task errors through onError without dying', async () => {
    const failures: Array<'sweep' | 'purge' | 'lease'> = [];
    services.objectStore.expiredKeys = async () => {
      throw new Error('boom');
    };
    const stop = startPrivacyScheduler(services, (_err, task) => failures.push(task));
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop();
    expect(failures).toContain('sweep');
  });
});

describe('processExportJob', () => {
  it('completes a queued job: stores a decryptable archive with a 72h expiry', async () => {
    const user = await seedFullUser();
    const job = await services.store.createExportJob(user.userId);
    await processExportJob(services, job.jobId, 1_000);

    const done = await services.store.getExportJob(job.jobId);
    expect(done?.status).toBe('completed');
    expect(done?.progressPct).toBe(100);
    expect(done?.downloadUrlRef).toBe(exportObjectKey(job.jobId));
    expect(done?.expiresAt).toBe(new Date(1_000 + EXPORT_DOWNLOAD_TTL_MS).toISOString());

    const obj = await services.objectStore.get(exportObjectKey(job.jobId), 2_000);
    expect(obj).not.toBeNull();
    if (!obj) throw new Error('archive missing');
    const parsed = JSON.parse(obj.bytes.toString('utf8')) as Record<string, unknown>;
    expect(parsed['schema_version']).toBe(EXPORT_SCHEMA_VERSION);
  });

  it('retries a transient failure and surfaces `failed` after MAX attempts', async () => {
    // A job whose user does not exist makes assembleExport throw on each attempt.
    const job = await services.store.createExportJob('ghost-user');
    for (let i = 0; i < MAX_EXPORT_ATTEMPTS; i++) {
      await processExportJob(services, job.jobId);
    }
    const failed = await services.store.getExportJob(job.jobId);
    expect(failed?.status).toBe('failed');
    expect(failed?.attempts).toBe(MAX_EXPORT_ATTEMPTS);

    // Terminal: a further poll does not reprocess or bump attempts.
    await processExportJob(services, job.jobId);
    expect((await services.store.getExportJob(job.jobId))?.attempts).toBe(MAX_EXPORT_ATTEMPTS);
  });

  it('is idempotent on an already-completed job', async () => {
    const user = await seedFullUser();
    const job = await services.store.createExportJob(user.userId);
    await processExportJob(services, job.jobId, 1_000);
    await processExportJob(services, job.jobId, 9_999); // no-op
    expect((await services.store.getExportJob(job.jobId))?.completedAt).toBe(
      new Date(1_000).toISOString(),
    );
  });
});

describe('sweepExpiredExports', () => {
  it('deletes expired archives and marks their jobs expired', async () => {
    const user = await seedFullUser();
    const job = await services.store.createExportJob(user.userId);
    await processExportJob(services, job.jobId, 1_000);

    const swept = await sweepExpiredExports(services, 1_000 + EXPORT_DOWNLOAD_TTL_MS + 1);
    expect(swept).toBe(1);
    expect((await services.store.getExportJob(job.jobId))?.status).toBe('expired');
    expect(await services.objectStore.get(exportObjectKey(job.jobId))).toBeNull();
  });

  it('is a no-op when nothing has expired', async () => {
    const user = await seedFullUser();
    const job = await services.store.createExportJob(user.userId);
    await processExportJob(services, job.jobId, 1_000);
    expect(await sweepExpiredExports(services, 2_000)).toBe(0);
    expect((await services.store.getExportJob(job.jobId))?.status).toBe('completed');
  });
});

describe('runDeletionPurge', () => {
  it('anonymizes, tombstones, and writes a hashed-id deletion_complete audit', async () => {
    const user = await seedFullUser();
    let anonymized: string | null = null;
    services.anonymizeContributions = async (id) => {
      anonymized = id;
    };
    let purged: { id: string; mode: string } | null = null;
    services.purgeAttention = async (id, mode) => {
      purged = { id, mode };
      return 7;
    };
    const now = 1_000_000;
    await services.store.setDeletion({
      userId: user.userId,
      state: 'grace_period',
      requestedAt: new Date(now - 1).toISOString(),
      purgeAt: new Date(now - 1).toISOString(),
      cancelledAt: null,
      completedAt: null,
    });

    expect(await runDeletionPurge(services, now)).toBe(1);

    const tomb = await services.store.getUser(user.userId);
    expect(tomb?.accountState).toBe('deleted');
    expect(tomb?.email).toBeNull();
    expect(tomb?.displayName).toBe('[deleted]');
    // Collision-safe, data-free tombstone handle: deleted_ + 22 hex of
    // sha256(user_id) — exactly 30 chars, inside the DB handle CHECK.
    expect(tomb?.handle).toBe(`deleted_${sha256Hex(user.userId).slice(0, 22)}`);
    expect(tomb?.handle).toHaveLength(30);
    expect(await services.store.getAuth(user.userId)).toBeNull();
    expect(await services.store.listWebauthn(user.userId)).toEqual([]);
    expect(await services.store.listWalletAuth(user.userId)).toEqual([]);
    // Settings are personal data: reset to pristine defaults.
    expect(tomb?.privacySettings).toEqual(defaultPrivacySettings());
    expect(tomb?.personalizationSettings).toEqual(defaultPersonalizationSettings());

    expect(anonymized).toBe(user.userId);
    expect(purged).toEqual({ id: user.userId, mode: 'delete' });
    expect((await services.store.getDeletion(user.userId))?.state).toBe('deleted');

    const complete = audit.inputs.find((e) => e.eventType === 'deletion_complete');
    expect(complete?.actorUserId).toBeNull();
    expect(complete?.targetRef).toBe(sha256Hex(user.userId));
  });

  it('removes COMPLETED export archives and revokes every session at purge (D.2.4c)', async () => {
    const user = await seedFullUser();
    // A completed export whose 72h window is still open at purge time…
    const job = await services.store.createExportJob(user.userId);
    const t0 = Date.now();
    await processExportJob(services, job.jobId, t0);
    expect(await services.objectStore.get(exportObjectKey(job.jobId), t0 + 1)).not.toBeNull();
    // …and a live session (e.g. a cancel-only re-login during the grace period).
    const session = await createSession(services.sessions, {
      userId: user.userId,
      authMethod: 'email_otp',
      deviceLabel: 'macOS/Chrome',
      rememberMe: false,
    });
    await services.store.setDeletion({
      userId: user.userId,
      state: 'grace_period',
      requestedAt: new Date(t0 - 2).toISOString(),
      purgeAt: new Date(t0 - 1).toISOString(),
      cancelledAt: null,
      completedAt: null,
    });

    expect(await runDeletionPurge(services, t0)).toBe(1);

    // The archive is gone from object storage and the session store is empty.
    expect(await services.objectStore.get(exportObjectKey(job.jobId), t0 + 1)).toBeNull();
    expect(await services.sessions.get(session.tokenHash)).toBeNull();
    expect(await services.sessions.listForUser(user.userId)).toEqual([]);
    // The job rows themselves are dropped by the tombstone.
    expect(await services.store.listExportJobs(user.userId)).toEqual([]);
  });

  it('does not purge a deletion whose grace period has not elapsed', async () => {
    const user = await seedFullUser();
    const now = 1_000_000;
    await services.store.setDeletion({
      userId: user.userId,
      state: 'grace_period',
      requestedAt: new Date(now).toISOString(),
      purgeAt: new Date(now + 1_000).toISOString(), // future
      cancelledAt: null,
      completedAt: null,
    });
    expect(await runDeletionPurge(services, now)).toBe(0);
    expect((await services.store.getUser(user.userId))?.accountState).toBe('active');
  });
});
