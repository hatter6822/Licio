// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATED live-Postgres integration tests for the Drizzle identity/audit adapters
// (WS-D).  These run ONLY when DATABASE_URL points at a real Postgres
// (`docker compose up postgres`); CI has no database service and skips them.
//
// The suite creates and migrates its OWN database (licio_drizzle_store_it) so its
// destructive contract checks (clear/purge/tombstone) can never collide with the
// packages/db integration tests sharing DATABASE_URL in the same `pnpm test` run.
//
//   DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev pnpm test
import { randomBytes, randomUUID } from 'node:crypto';
import { createDbClient, migrationsFolder } from '@licio/db';
import { defaultPersonalizationSettings, defaultPrivacySettings } from '@licio/shared';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../crypto.js';
import { DrizzleAuditStore, DrizzleIdentityStore, DrizzleJobLeaseStore } from '../drizzle-store.js';
import type { StoredUser } from '../store.js';

const DB_URL = process.env['DATABASE_URL'];
const IT_DB = 'licio_drizzle_store_it';

function userInput(
  over: Partial<Pick<StoredUser, 'handle' | 'email' | 'roles' | 'ageBand'>> = {},
): Omit<StoredUser, 'userId' | 'createdAt' | 'updatedAt'> {
  return {
    handle: over.handle ?? `u_${randomUUID().slice(0, 8)}`,
    displayName: 'Drizzle IT User',
    email: over.email === undefined ? `${randomUUID().slice(0, 8)}@Example.com` : over.email,
    accountState: 'active',
    locale: 'en-US',
    ageBand: over.ageBand ?? 'adult',
    privacySettings: defaultPrivacySettings(),
    personalizationSettings: defaultPersonalizationSettings(),
    roles: over.roles ?? ['user'],
    stewardRoles: [],
  };
}

describe.skipIf(!DB_URL)('Drizzle identity/audit store integration (WS-D)', () => {
  let db: ReturnType<typeof createDbClient>;
  let store: DrizzleIdentityStore;
  let audit: DrizzleAuditStore;

  beforeAll(async () => {
    // A dedicated database, recreated from scratch and migrated by the real,
    // full migration chain — proving the migrations apply cleanly in order.
    const admin = postgres(DB_URL as string, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${IT_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${IT_DB}`);
    await admin.end();

    const itUrl = new URL(DB_URL as string);
    itUrl.pathname = `/${IT_DB}`;
    const migrationClient = postgres(itUrl.href, { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsFolder() });
    await migrationClient.end();

    db = createDbClient(itUrl.href, { onNotice: 'discard' });
    store = new DrizzleIdentityStore(db);
    audit = new DrizzleAuditStore(db);
  }, 30_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await store.clear();
    await audit.clear();
  });

  // --- Users -----------------------------------------------------------------
  it('creates a user with its user_auth companion and round-trips every field', async () => {
    const created = await store.createUser(userInput({ roles: ['user', 'steward'] }));
    const user = await store.getUser(created.userId);
    expect(user).not.toBeNull();
    expect(user?.handle).toBe(created.handle);
    expect(user?.roles).toEqual(['user', 'steward']);
    expect(user?.accountState).toBe('active');
    expect(user?.privacySettings.sensitive_topic_handling).toBe('strict');
    expect(Date.parse(user?.createdAt ?? '')).not.toBeNaN();

    const auth = await store.getAuth(created.userId);
    expect(auth).toMatchObject({
      emailVerified: false,
      pendingEmail: null,
      mfaEnabled: false,
      mfaSecret: null,
      mfaPending: false,
      recoveryCodeHashes: [],
    });
  });

  it('looks up handle and email case-insensitively; misses return null', async () => {
    const created = await store.createUser(
      userInput({ handle: 'CaseUser', email: 'Case@Example.com' }),
    );
    expect((await store.getUserByHandle('caseuser'))?.userId).toBe(created.userId);
    expect((await store.getUserByEmail('case@example.COM'))?.userId).toBe(created.userId);
    expect(await store.getUserByHandle('absent')).toBeNull();
    expect(await store.getUserByEmail('absent@example.com')).toBeNull();
    expect(await store.getUser('not-a-uuid')).toBeNull();
    expect(await store.getUser(randomUUID())).toBeNull();
  });

  it('enforces case-insensitive handle uniqueness and allows many NULL emails', async () => {
    await store.createUser(userInput({ handle: 'TakenHandle' }));
    await expect(store.createUser(userInput({ handle: 'takenhandle' }))).rejects.toThrow();
    const a = await store.createUser(userInput({ email: null }));
    const b = await store.createUser(userInput({ email: null }));
    expect(a.userId).not.toBe(b.userId);
    await expect(store.createUser(userInput({ handle: 'no spaces' }))).rejects.toThrow();
  });

  it('applies partial user patches; the trigger maintains updated_at', async () => {
    const created = await store.createUser(userInput());
    await new Promise((r) => setTimeout(r, 10));
    const updated = await store.updateUser(created.userId, {
      displayName: 'Renamed',
      accountState: 'deactivated',
    });
    expect(updated?.displayName).toBe('Renamed');
    expect(updated?.accountState).toBe('deactivated');
    expect(updated?.handle).toBe(created.handle); // untouched fields survive
    expect(updated?.createdAt).toBe(created.createdAt);
    expect(Date.parse(updated?.updatedAt ?? '')).toBeGreaterThan(Date.parse(created.updatedAt));
    expect(await store.updateUser(randomUUID(), { displayName: 'x' })).toBeNull();
    expect(await store.updateUser('not-a-uuid', {})).toBeNull();
  });

  // --- User auth + recovery codes ---------------------------------------------
  it('round-trips the auth row: pending email, sealed secret, recovery codes', async () => {
    const { userId } = await store.createUser(userInput());

    await store.setAuth(userId, { pendingEmail: 'new@example.com' });
    expect((await store.getAuth(userId))?.pendingEmail).toBe('new@example.com');

    const sealed = `v1.${randomBytes(24).toString('base64')}`;
    const codes = [sha256Hex('code-1'), sha256Hex('code-2'), sha256Hex('code-3')];
    const afterEnroll = await store.setAuth(userId, {
      mfaSecret: sealed,
      mfaPending: true,
      recoveryCodeHashes: codes,
    });
    expect(afterEnroll?.mfaSecret).toBe(sealed);
    expect(afterEnroll?.mfaPending).toBe(true);
    expect([...(afterEnroll?.recoveryCodeHashes ?? [])].sort()).toEqual([...codes].sort());

    // Consuming one code stamps used_at — the row is kept, not deleted.
    const remaining = codes.slice(1);
    await store.setAuth(userId, { recoveryCodeHashes: remaining });
    const active = (await store.getAuth(userId))?.recoveryCodeHashes ?? [];
    expect([...active].sort()).toEqual([...remaining].sort());
    const counts = await db.execute(
      sql`SELECT count(*) FILTER (WHERE used_at IS NULL) AS active,
                 count(*) FILTER (WHERE used_at IS NOT NULL) AS used
          FROM mfa_recovery_codes WHERE user_id = ${userId}`,
    );
    expect(counts[0]).toMatchObject({ active: '2', used: '1' });

    expect(await store.setAuth(randomUUID(), { mfaPending: true })).toBeNull();
  });

  // --- WebAuthn credentials -----------------------------------------------------
  it('upserts WebAuthn credentials with byte-exact base64url/bytea round-trips', async () => {
    const { userId } = await store.createUser(userInput());
    const credentialId = randomBytes(32).toString('base64url');
    const publicKey = new Uint8Array(randomBytes(65));
    const createdAt = new Date().toISOString();
    await store.addWebauthn({
      credentialId,
      userId,
      publicKey,
      counter: 0,
      deviceType: 'platform',
      deviceName: 'iPhone',
      transports: ['internal', 'hybrid'],
      backedUp: true,
      createdAt,
      lastUsedAt: null,
    });
    const stored = await store.getWebauthn(credentialId);
    expect(stored?.credentialId).toBe(credentialId);
    expect(Buffer.from(stored?.publicKey ?? [])).toEqual(Buffer.from(publicKey));
    expect(stored?.transports).toEqual(['internal', 'hybrid']);

    // Counter/last-used update is an UPSERT on the same credential id.
    const usedAt = new Date().toISOString();
    await store.addWebauthn({
      ...(stored as NonNullable<typeof stored>),
      counter: 7,
      lastUsedAt: usedAt,
    });
    const bumped = await store.getWebauthn(credentialId);
    expect(bumped?.counter).toBe(7);
    expect(bumped?.lastUsedAt).toBe(usedAt);
    expect(bumped?.createdAt).toBe(stored?.createdAt); // upsert never resets createdAt
    expect(await store.listWebauthn(userId)).toHaveLength(1);

    await store.deleteWebauthn(credentialId);
    expect(await store.getWebauthn(credentialId)).toBeNull();
    expect(await store.listWebauthn(userId)).toHaveLength(0);
  });

  // --- Auth-wallet credentials ----------------------------------------------------
  it('stores wallet credentials by hex hash and enforces one-wallet-one-account', async () => {
    const { userId } = await store.createUser(userInput());
    const addressHash = randomBytes(32).toString('hex');
    await store.addWalletAuth({
      credentialId: randomUUID(),
      userId,
      addressHash,
      addressTruncated: '0x12ab…cd34',
      chainId: 1,
      walletType: 'eoa',
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });
    const found = await store.findWalletAuthByHash(addressHash);
    expect(found?.userId).toBe(userId);
    expect(found?.addressHash).toBe(addressHash);
    expect(await store.findWalletAuthByHash(randomBytes(32).toString('hex'))).toBeNull();
    expect(await store.findWalletAuthByHash('not-hex!')).toBeNull();

    // The unique address_hash index rejects linking the same wallet twice.
    const other = await store.createUser(userInput());
    await expect(
      store.addWalletAuth({
        credentialId: randomUUID(),
        userId: other.userId,
        addressHash,
        addressTruncated: '0x12ab…cd34',
        chainId: 1,
        walletType: 'eoa',
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      }),
    ).rejects.toThrow();

    await store.deleteWalletAuth((found as NonNullable<typeof found>).credentialId);
    expect(await store.listWalletAuth(userId)).toHaveLength(0);
  });

  // --- Export jobs ------------------------------------------------------------------
  it('drives the export-job lifecycle: queued → completed → no longer active', async () => {
    const { userId } = await store.createUser(userInput());
    const job = await store.createExportJob(userId);
    expect(job).toMatchObject({ status: 'queued', progressPct: 0, attempts: 0 });
    expect((await store.activeExportJob(userId))?.jobId).toBe(job.jobId);

    const completedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 72 * 3_600_000).toISOString();
    const done = await store.updateExportJob(job.jobId, {
      status: 'completed',
      progressPct: 100,
      completedAt,
      expiresAt,
      downloadUrlRef: `export/${job.jobId}`,
    });
    expect(done).toMatchObject({ status: 'completed', progressPct: 100, completedAt, expiresAt });
    expect(await store.activeExportJob(userId)).toBeNull();
    expect(await store.listExportJobs(userId)).toHaveLength(1);
    expect(await store.getExportJob(randomUUID())).toBeNull();
    expect(await store.updateExportJob(randomUUID(), { status: 'failed' })).toBeNull();
  });

  // --- Deletion requests ---------------------------------------------------------------
  it('upserts deletion requests and surfaces only due grace-period purges', async () => {
    const { userId } = await store.createUser(userInput());
    const now = Date.now();
    await store.setDeletion({
      userId,
      state: 'grace_period',
      requestedAt: new Date(now).toISOString(),
      purgeAt: new Date(now + 1000).toISOString(),
      cancelledAt: null,
      completedAt: null,
    });
    expect((await store.getDeletion(userId))?.state).toBe('grace_period');
    expect(await store.duePurgeDeletions(now)).toHaveLength(0); // not yet due
    expect((await store.duePurgeDeletions(now + 1000)).map((d) => d.userId)).toEqual([userId]);

    // Cancelling is an upsert over the same row; cancelled requests are never due.
    await store.setDeletion({
      userId,
      state: 'cancelled',
      requestedAt: new Date(now).toISOString(),
      purgeAt: new Date(now + 1000).toISOString(),
      cancelledAt: new Date(now + 500).toISOString(),
      completedAt: null,
    });
    expect(await store.duePurgeDeletions(now + 2000)).toHaveLength(0);
  });

  // --- Tombstone + purge -----------------------------------------------------------------
  it('tombstones a user: every personal datum gone, FK stub + deletion record kept', async () => {
    const created = await store.createUser(userInput({ roles: ['user', 'steward'] }));
    const { userId } = created;
    await store.setAuth(userId, {
      pendingEmail: 'staged@example.com',
      mfaSecret: 'v1.secret',
      recoveryCodeHashes: [sha256Hex('rc')],
    });
    await store.addWebauthn({
      credentialId: randomBytes(16).toString('base64url'),
      userId,
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      deviceType: 'platform',
      deviceName: null,
      transports: [],
      backedUp: false,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });
    await store.createExportJob(userId);
    await store.setDeletion({
      userId,
      state: 'grace_period',
      requestedAt: new Date().toISOString(),
      purgeAt: new Date().toISOString(),
      cancelledAt: null,
      completedAt: null,
    });

    await store.tombstoneUser(userId);

    const stub = await store.getUser(userId);
    expect(stub?.handle).toBe(`deleted_${sha256Hex(userId).slice(0, 22)}`);
    expect(stub?.handle).toHaveLength(30); // fits the users_handle_pattern CHECK
    expect(stub?.displayName).toBe('[deleted]');
    expect(stub?.email).toBeNull();
    expect(stub?.accountState).toBe('deleted');
    expect(stub?.ageBand).toBeNull();
    expect(stub?.privacySettings).toEqual(defaultPrivacySettings());
    expect(await store.getAuth(userId)).toBeNull();
    expect(await store.listWebauthn(userId)).toHaveLength(0);
    expect(await store.listExportJobs(userId)).toHaveLength(0);
    const codeRows = await db.execute(
      sql`SELECT count(*) AS n FROM mfa_recovery_codes WHERE user_id = ${userId}`,
    );
    expect(codeRows[0]).toMatchObject({ n: '0' });
    // The deletion request survives so the purge can mark it complete.
    expect(await store.getDeletion(userId)).not.toBeNull();
  });

  it('purgeUser cascades every dependent row; audit rows survive with NULL actor', async () => {
    const { userId } = await store.createUser(userInput());
    await store.createExportJob(userId);
    await store.setDeletion({
      userId,
      state: 'grace_period',
      requestedAt: new Date().toISOString(),
      purgeAt: new Date().toISOString(),
      cancelledAt: null,
      completedAt: null,
    });
    await audit.append({ actorUserId: userId, eventType: 'deletion_request', context: {} });

    await store.purgeUser(userId);

    expect(await store.getUser(userId)).toBeNull();
    expect(await store.getAuth(userId)).toBeNull();
    expect(await store.getDeletion(userId)).toBeNull();
    expect(await store.listExportJobs(userId)).toHaveLength(0);
    const orphaned = await db.execute(
      sql`SELECT count(*) AS n FROM audit_log WHERE actor_user_id IS NULL`,
    );
    expect(Number((orphaned[0] as { n: string }).n)).toBeGreaterThan(0);
  });

  // --- Audit store ----------------------------------------------------------------------
  it('appends redacted audit entries and reads them back newest-first, owner-scoped', async () => {
    const { userId } = await store.createUser(userInput());
    const other = await store.createUser(userInput());

    const first = await audit.append(
      { actorUserId: userId, eventType: 'login_success', context: { auth_method: 'webauthn' } },
      new Date(Date.now() - 2000),
    );
    await audit.append(
      // An IP-shaped context value must be masked before it ever reaches a row.
      { actorUserId: userId, eventType: 'session_revoke', context: { device: '203.0.113.7' } },
      new Date(Date.now() - 1000),
    );
    await audit.append({ actorUserId: other.userId, eventType: 'login_failure', context: {} });

    const activity = await audit.securityActivityForUser(userId);
    expect(activity).toHaveLength(2); // never another user's entries
    expect(activity.map((e) => e.event_type)).toEqual(['session_revoke', 'login_success']);
    expect(activity[0]?.context.device).toBeNull(); // IP masked by the redactor
    expect(activity[1]?.event_id).toBe(first.event_id);
    expect(activity[1]?.context.auth_method).toBe('webauthn');

    expect(await audit.securityActivityForUser(userId, 1)).toHaveLength(1);
    expect(await audit.securityActivityForUser(randomUUID())).toHaveLength(0);
  });

  // --- Job lease (distributed scheduler binding) -------------------------------
  it('grants a lease once per window and lets another holder steal it on expiry', async () => {
    const lease = new DrizzleJobLeaseStore(db);
    const job = `it_${randomUUID().slice(0, 8)}`;
    const t0 = Date.now();
    expect(await lease.tryAcquire(job, 1000, 'instance-a', t0)).toBe(true);
    expect(await lease.tryAcquire(job, 1000, 'instance-b', t0 + 500)).toBe(false);
    expect(await lease.tryAcquire(job, 1000, 'instance-a', t0 + 500)).toBe(false); // even the holder
    expect(await lease.tryAcquire(job, 1000, 'instance-b', t0 + 1000)).toBe(true); // expired ⇒ stolen
    const row = await db.execute(sql`SELECT holder FROM job_leases WHERE job_name = ${job}`);
    expect(row[0]).toMatchObject({ holder: 'instance-b' });
  });

  it('grants EXACTLY ONE of many concurrent claims (atomic insert-or-steal)', async () => {
    const lease = new DrizzleJobLeaseStore(db);
    const job = `it_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => lease.tryAcquire(job, 60_000, `instance-${i}`, now)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
