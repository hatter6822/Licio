// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production Postgres adapters for the identity layer (WS-D): DrizzleIdentityStore
// implements IdentityStore and DrizzleAuditStore implements AuditStore over the
// Drizzle schema in @licio/db — the durable bindings behind the same interfaces
// the in-memory adapters satisfy (the redis-stores.ts pattern).  Validated by the
// gated integration test (DATABASE_URL); CI has no database and skips it.
//
// Mapping notes (Stored* shapes ↔ rows):
//   • timestamps are ISO strings on the interface, timestamptz Dates in rows;
//   • WebAuthn credential ids are base64url strings ↔ bytea;
//   • wallet address hashes and recovery-code hashes are hex strings ↔ bytea;
//   • the sealed TOTP secret is the SecretBox string ("v1.…") ↔ utf8 bytea;
//   • recoveryCodeHashes IS the set of ACTIVE mfa_recovery_codes rows
//     (used_at IS NULL): consuming a code stamps used_at (single-use forensics)
//     rather than deleting the row; brand-new hashes are inserted.
//   • users.updated_at / user_auth.updated_at are trigger-maintained; updates
//     never set them by hand beyond providing a non-empty SET clause.
import { randomUUID } from 'node:crypto';
import {
  auditLog,
  type createDbClient,
  deletionRequests,
  exportJobs,
  mfaRecoveryCodes,
  userAuth,
  users,
  walletAuthCredentials,
  webauthnCredentials,
} from '@licio/db';
import {
  type AuditEntry,
  auditEntrySchema,
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  emptyReputationSummary,
  type SecurityActivityEntry,
} from '@licio/shared';
import { and, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  type AuditEntryInput,
  type AuditStore,
  buildAuditEntry,
  toSecurityActivity,
} from './audit.js';
import { sha256Hex } from './crypto.js';
import { ROLES, type Role } from './rbac.js';
import type {
  IdentityStore,
  StoredDeletionRequest,
  StoredExportJob,
  StoredUser,
  StoredUserAuth,
  StoredWalletAuthCredential,
  StoredWebauthnCredential,
} from './store.js';

type Db = ReturnType<typeof createDbClient>;

// uuid-keyed lookups guard their input so a malformed id behaves like the
// in-memory adapter (miss → null) instead of a Postgres uuid-cast error.
const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const isUuid = (value: string): boolean => UUID_RE.test(value);

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);
const dateOrNull = (s: string | null): Date | null => (s === null ? null : new Date(s));

const ROLE_SET: ReadonlySet<string> = new Set(ROLES);

function rowToUser(r: typeof users.$inferSelect): StoredUser {
  return {
    userId: r.userId,
    handle: r.handle,
    displayName: r.displayName,
    email: r.email,
    accountState: r.accountState,
    locale: r.locale,
    ageBand: r.ageBandIfKnown,
    privacySettings: r.privacySettings,
    personalizationSettings: r.personalizationSettings,
    reputationSummary: r.reputationSummaryPrivate,
    roles: r.roles.filter((x): x is Role => ROLE_SET.has(x)),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

function rowToWebauthn(r: typeof webauthnCredentials.$inferSelect): StoredWebauthnCredential {
  return {
    credentialId: r.credentialId.toString('base64url'),
    userId: r.userId,
    publicKey: new Uint8Array(r.publicKey),
    counter: r.counter,
    deviceType: r.deviceType === 'cross-platform' ? 'cross-platform' : 'platform',
    deviceName: r.deviceName,
    transports: r.transports ?? [],
    backedUp: r.backedUp,
    createdAt: iso(r.createdAt),
    lastUsedAt: isoOrNull(r.lastUsedAt),
  };
}

function rowToWalletAuth(r: typeof walletAuthCredentials.$inferSelect): StoredWalletAuthCredential {
  return {
    credentialId: r.credentialId,
    userId: r.userId,
    addressHash: r.addressHash.toString('hex'),
    addressTruncated: r.addressTruncated,
    chainId: r.chainId,
    walletType: r.walletType,
    createdAt: iso(r.createdAt),
    lastUsedAt: isoOrNull(r.lastUsedAt),
  };
}

function rowToExportJob(r: typeof exportJobs.$inferSelect): StoredExportJob {
  return {
    jobId: r.jobId,
    userId: r.userId,
    status: r.status,
    progressPct: r.progressPct,
    attempts: r.attempts,
    downloadUrlRef: r.downloadUrlRef,
    createdAt: iso(r.createdAt),
    completedAt: isoOrNull(r.completedAt),
    expiresAt: isoOrNull(r.expiresAt),
  };
}

function rowToDeletion(r: typeof deletionRequests.$inferSelect): StoredDeletionRequest {
  return {
    userId: r.userId,
    state: r.state,
    requestedAt: iso(r.requestedAt),
    purgeAt: iso(r.purgeAt),
    cancelledAt: isoOrNull(r.cancelledAt),
    completedAt: isoOrNull(r.completedAt),
  };
}

export class DrizzleIdentityStore implements IdentityStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  // --- Users ---------------------------------------------------------------
  async createUser(
    input: Omit<StoredUser, 'userId' | 'createdAt' | 'updatedAt'> & { userId?: string },
    now: number = Date.now(),
  ): Promise<StoredUser> {
    const userId = input.userId ?? randomUUID();
    const at = new Date(now);
    return this.#db.transaction(async (tx) => {
      const inserted = await tx
        .insert(users)
        .values({
          userId,
          handle: input.handle,
          displayName: input.displayName,
          email: input.email,
          accountState: input.accountState,
          locale: input.locale,
          ageBandIfKnown: input.ageBand,
          roles: input.roles,
          privacySettings: input.privacySettings,
          personalizationSettings: input.personalizationSettings,
          reputationSummaryPrivate: input.reputationSummary,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      // Every user carries a user_auth companion row from birth (WS-D.1.1e).
      await tx.insert(userAuth).values({ userId, createdAt: at, updatedAt: at });
      const row = inserted[0];
      if (!row) throw new Error('createUser: insert returned no row');
      return rowToUser(row);
    });
  }

  async getUser(userId: string): Promise<StoredUser | null> {
    if (!isUuid(userId)) return null;
    const rows = await this.#db.select().from(users).where(eq(users.userId, userId)).limit(1);
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  async getUserByHandle(handle: string): Promise<StoredUser | null> {
    const rows = await this.#db
      .select()
      .from(users)
      .where(sql`lower(${users.handle}) = ${handle.toLowerCase()}`)
      .limit(1);
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  async getUserByEmail(email: string): Promise<StoredUser | null> {
    const rows = await this.#db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
      .limit(1);
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  async updateUser(
    userId: string,
    patch: Partial<StoredUser>,
    _now: number = Date.now(),
  ): Promise<StoredUser | null> {
    if (!isUuid(userId)) return null;
    const set: Partial<typeof users.$inferInsert> = {};
    if (patch.handle !== undefined) set.handle = patch.handle;
    if (patch.displayName !== undefined) set.displayName = patch.displayName;
    if (patch.email !== undefined) set.email = patch.email;
    if (patch.accountState !== undefined) set.accountState = patch.accountState;
    if (patch.locale !== undefined) set.locale = patch.locale;
    if (patch.ageBand !== undefined) set.ageBandIfKnown = patch.ageBand;
    if (patch.roles !== undefined) set.roles = patch.roles;
    if (patch.privacySettings !== undefined) set.privacySettings = patch.privacySettings;
    if (patch.personalizationSettings !== undefined)
      set.personalizationSettings = patch.personalizationSettings;
    if (patch.reputationSummary !== undefined)
      set.reputationSummaryPrivate = patch.reputationSummary;
    // updated_at is trigger-maintained; touching it here only guarantees a
    // non-empty SET clause (the trigger overwrites the value server-side).
    set.updatedAt = new Date();
    const rows = await this.#db.update(users).set(set).where(eq(users.userId, userId)).returning();
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  // --- User auth -------------------------------------------------------------
  async getAuth(userId: string): Promise<StoredUserAuth | null> {
    if (!isUuid(userId)) return null;
    const rows = await this.#db.select().from(userAuth).where(eq(userAuth.userId, userId)).limit(1);
    const row = rows[0];
    if (!row) return null;
    const codes = await this.#activeRecoveryCodes(this.#db, userId);
    return this.#assembleAuth(row, codes);
  }

  async setAuth(userId: string, patch: Partial<StoredUserAuth>): Promise<StoredUserAuth | null> {
    if (!isUuid(userId)) return null;
    return this.#db.transaction(async (tx) => {
      const set: Partial<typeof userAuth.$inferInsert> = {};
      if (patch.emailVerified !== undefined) set.emailVerified = patch.emailVerified;
      if (patch.emailVerifiedAt !== undefined)
        set.emailVerifiedAt = dateOrNull(patch.emailVerifiedAt);
      if (patch.pendingEmail !== undefined) set.pendingEmail = patch.pendingEmail;
      if (patch.mfaEnabled !== undefined) set.mfaEnabled = patch.mfaEnabled;
      if (patch.mfaPending !== undefined) set.mfaPending = patch.mfaPending;
      if (patch.mfaEnrolledAt !== undefined) set.mfaEnrolledAt = dateOrNull(patch.mfaEnrolledAt);
      if (patch.mfaSecret !== undefined) {
        set.mfaTotpSecretEncrypted =
          patch.mfaSecret === null ? null : Buffer.from(patch.mfaSecret, 'utf8');
      }
      set.updatedAt = new Date(); // trigger-maintained; guarantees a non-empty SET
      const rows = await tx
        .update(userAuth)
        .set(set)
        .where(eq(userAuth.userId, userId))
        .returning();
      const row = rows[0];
      if (!row) return null;

      let active = await this.#activeRecoveryCodes(tx, userId);
      if (patch.recoveryCodeHashes !== undefined) {
        const next = new Set(patch.recoveryCodeHashes);
        const at = new Date();
        // Active codes absent from the new set were consumed (or replaced):
        // stamp used_at, never delete — single-use forensics (WS-D.1.5a).
        const consumed = active.filter((hex) => !next.has(hex));
        if (consumed.length > 0) {
          await tx
            .update(mfaRecoveryCodes)
            .set({ usedAt: at })
            .where(
              and(
                eq(mfaRecoveryCodes.userId, userId),
                isNull(mfaRecoveryCodes.usedAt),
                inArray(
                  mfaRecoveryCodes.codeHash,
                  consumed.map((hex) => Buffer.from(hex, 'hex')),
                ),
              ),
            );
        }
        const known = new Set(active);
        const fresh = [...next].filter((hex) => !known.has(hex));
        if (fresh.length > 0) {
          await tx.insert(mfaRecoveryCodes).values(
            fresh.map((hex) => ({
              userId,
              codeHash: Buffer.from(hex, 'hex'),
              createdAt: at,
            })),
          );
        }
        active = patch.recoveryCodeHashes;
      }
      return this.#assembleAuth(row, active);
    });
  }

  /** Active (unconsumed) recovery-code hashes, as hex strings. */
  async #activeRecoveryCodes(db: Pick<Db, 'select'>, userId: string): Promise<string[]> {
    const rows = await db
      .select({ codeHash: mfaRecoveryCodes.codeHash })
      .from(mfaRecoveryCodes)
      .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)));
    return rows.map((r) => r.codeHash.toString('hex'));
  }

  #assembleAuth(row: typeof userAuth.$inferSelect, codes: string[]): StoredUserAuth {
    return {
      userId: row.userId,
      emailVerified: row.emailVerified,
      emailVerifiedAt: isoOrNull(row.emailVerifiedAt),
      pendingEmail: row.pendingEmail,
      mfaEnabled: row.mfaEnabled,
      mfaSecret: row.mfaTotpSecretEncrypted?.toString('utf8') ?? null,
      mfaPending: row.mfaPending,
      mfaEnrolledAt: isoOrNull(row.mfaEnrolledAt),
      recoveryCodeHashes: codes,
    };
  }

  // --- WebAuthn credentials --------------------------------------------------
  async addWebauthn(cred: StoredWebauthnCredential): Promise<void> {
    const credentialId = Buffer.from(cred.credentialId, 'base64url');
    const mutable = {
      publicKey: Buffer.from(cred.publicKey),
      counter: cred.counter,
      deviceType: cred.deviceType,
      deviceName: cred.deviceName,
      transports: cred.transports,
      backedUp: cred.backedUp,
      lastUsedAt: dateOrNull(cred.lastUsedAt),
    };
    await this.#db
      .insert(webauthnCredentials)
      .values({
        credentialId,
        userId: cred.userId,
        createdAt: new Date(cred.createdAt),
        ...mutable,
      })
      .onConflictDoUpdate({ target: webauthnCredentials.credentialId, set: mutable });
  }

  async getWebauthn(credentialId: string): Promise<StoredWebauthnCredential | null> {
    const rows = await this.#db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.credentialId, Buffer.from(credentialId, 'base64url')))
      .limit(1);
    return rows[0] ? rowToWebauthn(rows[0]) : null;
  }

  async listWebauthn(userId: string): Promise<StoredWebauthnCredential[]> {
    if (!isUuid(userId)) return [];
    const rows = await this.#db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, userId));
    return rows.map(rowToWebauthn);
  }

  async deleteWebauthn(credentialId: string): Promise<void> {
    await this.#db
      .delete(webauthnCredentials)
      .where(eq(webauthnCredentials.credentialId, Buffer.from(credentialId, 'base64url')));
  }

  // --- Auth-wallet credentials ------------------------------------------------
  async addWalletAuth(cred: StoredWalletAuthCredential): Promise<void> {
    const mutable = {
      addressHash: Buffer.from(cred.addressHash, 'hex'),
      addressTruncated: cred.addressTruncated,
      chainId: cred.chainId,
      walletType: cred.walletType,
      lastUsedAt: dateOrNull(cred.lastUsedAt),
    };
    await this.#db
      .insert(walletAuthCredentials)
      .values({
        credentialId: cred.credentialId,
        userId: cred.userId,
        createdAt: new Date(cred.createdAt),
        ...mutable,
      })
      .onConflictDoUpdate({ target: walletAuthCredentials.credentialId, set: mutable });
  }

  async findWalletAuthByHash(addressHash: string): Promise<StoredWalletAuthCredential | null> {
    if (!/^[0-9a-f]+$/i.test(addressHash)) return null;
    const rows = await this.#db
      .select()
      .from(walletAuthCredentials)
      .where(eq(walletAuthCredentials.addressHash, Buffer.from(addressHash, 'hex')))
      .limit(1);
    return rows[0] ? rowToWalletAuth(rows[0]) : null;
  }

  async listWalletAuth(userId: string): Promise<StoredWalletAuthCredential[]> {
    if (!isUuid(userId)) return [];
    const rows = await this.#db
      .select()
      .from(walletAuthCredentials)
      .where(eq(walletAuthCredentials.userId, userId));
    return rows.map(rowToWalletAuth);
  }

  async deleteWalletAuth(credentialId: string): Promise<void> {
    if (!isUuid(credentialId)) return;
    await this.#db
      .delete(walletAuthCredentials)
      .where(eq(walletAuthCredentials.credentialId, credentialId));
  }

  // --- Export jobs -------------------------------------------------------------
  async activeExportJob(userId: string): Promise<StoredExportJob | null> {
    if (!isUuid(userId)) return null;
    const rows = await this.#db
      .select()
      .from(exportJobs)
      .where(
        and(eq(exportJobs.userId, userId), inArray(exportJobs.status, ['queued', 'processing'])),
      )
      .limit(1);
    return rows[0] ? rowToExportJob(rows[0]) : null;
  }

  async createExportJob(userId: string, now: number = Date.now()): Promise<StoredExportJob> {
    const rows = await this.#db
      .insert(exportJobs)
      .values({ userId, createdAt: new Date(now) })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('createExportJob: insert returned no row');
    return rowToExportJob(row);
  }

  async getExportJob(jobId: string): Promise<StoredExportJob | null> {
    if (!isUuid(jobId)) return null;
    const rows = await this.#db
      .select()
      .from(exportJobs)
      .where(eq(exportJobs.jobId, jobId))
      .limit(1);
    return rows[0] ? rowToExportJob(rows[0]) : null;
  }

  async listExportJobs(userId: string): Promise<StoredExportJob[]> {
    if (!isUuid(userId)) return [];
    const rows = await this.#db.select().from(exportJobs).where(eq(exportJobs.userId, userId));
    return rows.map(rowToExportJob);
  }

  async updateExportJob(
    jobId: string,
    patch: Partial<StoredExportJob>,
  ): Promise<StoredExportJob | null> {
    if (!isUuid(jobId)) return null;
    const set: Partial<typeof exportJobs.$inferInsert> = {};
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.progressPct !== undefined) set.progressPct = patch.progressPct;
    if (patch.attempts !== undefined) set.attempts = patch.attempts;
    if (patch.downloadUrlRef !== undefined) set.downloadUrlRef = patch.downloadUrlRef;
    if (patch.completedAt !== undefined) set.completedAt = dateOrNull(patch.completedAt);
    if (patch.expiresAt !== undefined) set.expiresAt = dateOrNull(patch.expiresAt);
    if (Object.keys(set).length === 0) return this.getExportJob(jobId);
    const rows = await this.#db
      .update(exportJobs)
      .set(set)
      .where(eq(exportJobs.jobId, jobId))
      .returning();
    return rows[0] ? rowToExportJob(rows[0]) : null;
  }

  // --- Deletion requests --------------------------------------------------------
  async getDeletion(userId: string): Promise<StoredDeletionRequest | null> {
    if (!isUuid(userId)) return null;
    const rows = await this.#db
      .select()
      .from(deletionRequests)
      .where(eq(deletionRequests.userId, userId))
      .limit(1);
    return rows[0] ? rowToDeletion(rows[0]) : null;
  }

  async setDeletion(req: StoredDeletionRequest): Promise<void> {
    const values = {
      userId: req.userId,
      state: req.state,
      requestedAt: new Date(req.requestedAt),
      purgeAt: new Date(req.purgeAt),
      cancelledAt: dateOrNull(req.cancelledAt),
      completedAt: dateOrNull(req.completedAt),
    };
    const { userId: _ignored, ...mutable } = values;
    await this.#db
      .insert(deletionRequests)
      .values(values)
      .onConflictDoUpdate({ target: deletionRequests.userId, set: mutable });
  }

  async duePurgeDeletions(now: number): Promise<StoredDeletionRequest[]> {
    const rows = await this.#db
      .select()
      .from(deletionRequests)
      .where(
        and(
          eq(deletionRequests.state, 'grace_period'),
          lte(deletionRequests.purgeAt, new Date(now)),
        ),
      );
    return rows.map(rowToDeletion);
  }

  // --- Lifecycle ------------------------------------------------------------------
  async purgeUser(userId: string): Promise<void> {
    if (!isUuid(userId)) return;
    // ON DELETE CASCADE removes user_auth, credentials, recovery codes, export
    // jobs, sessions, and the deletion request; audit rows survive with a
    // severed (NULL) actor link, matching the append-only doctrine.
    await this.#db.delete(users).where(eq(users.userId, userId));
  }

  async tombstoneUser(userId: string, now: number = Date.now()): Promise<void> {
    if (!isUuid(userId)) return;
    await this.#db.transaction(async (tx) => {
      await tx.delete(userAuth).where(eq(userAuth.userId, userId));
      await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
      await tx.delete(webauthnCredentials).where(eq(webauthnCredentials.userId, userId));
      await tx.delete(walletAuthCredentials).where(eq(walletAuthCredentials.userId, userId));
      await tx.delete(exportJobs).where(eq(exportJobs.userId, userId));
      await tx
        .update(users)
        .set({
          handle: `deleted_${sha256Hex(userId).slice(0, 22)}`,
          displayName: '[deleted]',
          email: null,
          accountState: 'deleted',
          locale: null,
          ageBandIfKnown: null,
          // Settings and reputation are PERSONAL data: reset to pristine
          // defaults — nothing user-derived survives (WS-D.2.4c).
          privacySettings: defaultPrivacySettings(),
          personalizationSettings: defaultPersonalizationSettings(),
          reputationSummaryPrivate: emptyReputationSummary(),
          updatedAt: new Date(now),
        })
        .where(eq(users.userId, userId));
    });
  }

  async clear(): Promise<void> {
    // Cascades take user_auth, credentials, codes, jobs, and deletion requests
    // with the users rows.  Audit rows belong to DrizzleAuditStore.
    await this.#db.delete(users);
  }
}

/**
 * Append-only Postgres audit store (WS-D.1.6c).  Append + owner-scoped read only;
 * `clear()` exists for test symmetry with the interface — the application exposes
 * no update/delete path over audit rows.
 */
export class DrizzleAuditStore implements AuditStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async append(input: AuditEntryInput, createdAt: Date = new Date()): Promise<AuditEntry> {
    // buildAuditEntry validates + redacts (allowlist, IP masking) BEFORE storage.
    const entry = buildAuditEntry(input, createdAt);
    await this.#db.insert(auditLog).values({
      eventId: entry.event_id,
      actorUserId: entry.actor_user_id,
      eventType: entry.event_type,
      targetRef: entry.target_ref,
      context: entry.context,
      createdAt: new Date(entry.created_at),
    });
    return entry;
  }

  async securityActivityForUser(userId: string, limit = 50): Promise<SecurityActivityEntry[]> {
    if (!isUuid(userId)) return [];
    const rows = await this.#db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actorUserId, userId))
      .orderBy(desc(auditLog.createdAt))
      .limit(limit);
    // Validate on the way OUT of the database (zod at the trust boundary).
    return rows
      .map((r) =>
        auditEntrySchema.parse({
          event_id: r.eventId,
          actor_user_id: r.actorUserId,
          event_type: r.eventType,
          target_ref: r.targetRef,
          context: r.context,
          created_at: iso(r.createdAt),
        }),
      )
      .map(toSecurityActivity);
  }

  async clear(): Promise<void> {
    await this.#db.delete(auditLog);
  }
}
