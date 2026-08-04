// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The identity data store backing the BFF auth/privacy routes (WS-D): the
// {@link IdentityStore} interface plus the in-memory adapter used by tests/CI
// (the established interface + in-memory pattern, e.g. TokenStore/SessionStore).
// The production Postgres adapter with the same surface lives in
// `drizzle-store.ts`, validated by the gated integration test (DATABASE_URL).
//
// Lookups by handle/email are case-insensitive (matching the partial/lower indexes
// in WS-D.1.1c).  Email is optional throughout.

import { randomUUID } from 'node:crypto';
import type { StewardRoleId } from '@licio/shared';
import {
  type AgeBand,
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  type ExportJobState,
  type PersonalizationSettings,
  type PrivacySettings,
  type UserAccountState,
} from '@licio/shared';
import { type InMemoryRollback, mapRollback } from '../lib/in-memory-rollback.js';
import { sha256Hex } from './crypto.js';
import type { Role } from './rbac.js';

export interface StoredUser {
  userId: string;
  handle: string;
  displayName: string;
  email: string | null;
  accountState: UserAccountState;
  locale: string | null;
  ageBand: AgeBand | null;
  privacySettings: PrivacySettings;
  personalizationSettings: PersonalizationSettings;
  roles: Role[];
  /** Doctrine steward-role grants (WS-J / STEWARD_ROLES.md); [] for non-stewards. */
  stewardRoles: StewardRoleId[];
  createdAt: string;
  updatedAt: string;
}

export interface StoredUserAuth {
  userId: string;
  emailVerified: boolean;
  emailVerifiedAt: string | null;
  /**
   * An email-change in flight: the NEW address, staged until it proves control
   * (WS-D.1.4a).  The current verified `email` stays live until confirmation, so
   * a typo can never strand an email-only account with zero verified methods.
   */
  pendingEmail: string | null;
  mfaEnabled: boolean;
  /** Pending or active TOTP secret (base32); KMS-encrypted at rest in production. */
  mfaSecret: string | null;
  mfaPending: boolean;
  mfaEnrolledAt: string | null;
  recoveryCodeHashes: string[];
}

export interface StoredWebauthnCredential {
  credentialId: string; // base64url
  userId: string;
  publicKey: Uint8Array;
  counter: number;
  deviceType: 'platform' | 'cross-platform';
  deviceName: string | null;
  transports: string[];
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface StoredWalletAuthCredential {
  credentialId: string;
  userId: string;
  addressHash: string;
  addressTruncated: string;
  chainId: number;
  walletType: 'eoa' | 'contract';
  createdAt: string;
  lastUsedAt: string | null;
}

export interface StoredExportJob {
  jobId: string;
  userId: string;
  status: ExportJobState;
  progressPct: number;
  attempts: number;
  /** Indirect object-store reference; the signed URL is minted per request. */
  downloadUrlRef: string | null;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
}

export interface StoredDeletionRequest {
  userId: string;
  state: 'grace_period' | 'deleted' | 'cancelled';
  requestedAt: string;
  purgeAt: string;
  cancelledAt: string | null;
  completedAt: string | null;
}

/**
 * The identity data surface the auth/privacy routes depend on.  Every method is
 * async so a database-backed adapter can implement the same contract; the
 * in-memory adapter resolves immediately.
 */
export interface IdentityStore {
  // --- Users ---
  createUser(
    input: Omit<StoredUser, 'userId' | 'createdAt' | 'updatedAt' | 'stewardRoles'> & {
      userId?: string;
      stewardRoles?: StewardRoleId[];
    },
    now?: number,
  ): Promise<StoredUser>;
  getUser(userId: string): Promise<StoredUser | null>;
  getUserByHandle(handle: string): Promise<StoredUser | null>;
  getUserByEmail(email: string): Promise<StoredUser | null>;
  /** Batch read (WS-E retention sweeps); unknown ids are simply absent. */
  getUsersByIds(userIds: readonly string[]): Promise<StoredUser[]>;
  updateUser(userId: string, patch: Partial<StoredUser>, now?: number): Promise<StoredUser | null>;
  // --- User auth ---
  getAuth(userId: string): Promise<StoredUserAuth | null>;
  setAuth(userId: string, patch: Partial<StoredUserAuth>): Promise<StoredUserAuth | null>;
  /**
   * COMPARE-AND-SET: spend a recovery code, only while it is still active.
   *
   * `null` ⇒ this code is not an active code for this user (unknown, or a
   * concurrent request just spent it).  Otherwise the count of codes left.
   *
   * A `getAuth` + `setAuth(recoveryCodeHashes: remaining)` cannot express this
   * for two independent reasons.  The first is the ordinary one: two requests
   * presenting the SAME code both read it present and both write a list without
   * it, so a single-use code is used twice — and the second write also
   * resurrects any code the first spent in between, because it rewrites the
   * whole list from a stale snapshot.  The second is that the list is a
   * PROJECTION of `mfa_recovery_codes` rows, so "set the list" has to diff the
   * old and new sets to decide which rows to stamp — a wide write standing in
   * for a one-row transition.
   *
   * As one statement it is also the only shape that can join the unit that
   * records it: consuming outside and auditing inside means an append failure
   * burns the code without granting access — worst on the last one, where it
   * costs the account its remaining way in.
   */
  consumeRecoveryCode(
    userId: string,
    codeHash: string,
    /** The session this code is being spent to verify, so the verification can
     *  be RESUMED if the (Redis) grant fails after this commits. Without it the
     *  last recovery code is consumed by a fault on our side and the account is
     *  locked out with no retry that can work. */
    verificationSessionHash: string,
  ): Promise<{ remaining: number } | null>;
  /**
   * A code already SPENT for this session, whose verification did not finish.
   *
   * The resume half of `consumeRecoveryCode`. Returns the session the code was
   * spent for; the CALLER decides whether the presenter may finish it, because
   * that question needs the session store and this one does not have it.
   *
   * Cleared whenever the recovery-code set is replaced (`setAuth`): a pending
   * continuation is about the factor it was issued for, and re-enrolling ends
   * that factor.
   */
  findResumableVerification(
    userId: string,
    codeHash: string,
    /** Ignore a continuation whose consumption is older than this instant.
     *
     *  A continuation describes a verification that is still IN FLIGHT, and
     *  in-flight has a duration.  Unbounded, a row that failed to settle stays
     *  adoptable indefinitely — so a code spent successfully, whose settle
     *  happened to fail, becomes usable a second time days later once the
     *  sessions it granted have expired.  Bounding it to the window an
     *  interrupted verification could plausibly be resumed in leaves the
     *  recovery path intact and closes the rest. */
    usedSince: string,
  ): Promise<{ remaining: number; verificationSessionHash: string } | null>;
  /**
   * SETTLE a continuation once its grant has landed — and CLAIM it while doing
   * so.  Returns whether THIS caller was the one that cleared it.
   *
   * A pending row must mean "the grant never happened", or the two are
   * indistinguishable, and a fallback that reads a finished verification as
   * unfinished would make every spent code reusable.
   *
   * The boolean is what makes the completion single-winner, and it is needed
   * because the same-session resume arm has no compare-and-set to pass through:
   * the continuation already names the caller, so rebinding it to that same
   * value discriminates nothing.  Two concurrent retries carrying one cookie
   * therefore both granted and both rotated, and a single-use code produced two
   * live verified sessions.  Clearing is a one-row transition, so exactly one
   * of them removes it — the loser is told to sign in again, which by then is
   * true, because the winner's rotation has replaced the session they hold.
   */
  clearResumableVerification(
    userId: string,
    codeHash: string,
    /** Clear only while the row still names THIS session.  Ownership can change
     *  between a claim and the completion it authorises, and a settle that
     *  ignored that would let a request report a completion another session now
     *  owns. */
    expectedSessionHash: string,
  ): Promise<boolean>;
  /**
   * COMPARE-AND-SET: take a continuation over, only while it still names
   * `expectedSessionHash`.
   *
   * `false` ⇒ someone else took it first. Two primary-authenticated sessions can
   * both find the original session gone and both decide they may finish it —
   * and a code that is single-use by construction would then grant steward
   * assurance to both. The rebind is the one statement that can settle which,
   * and the loser is told the code is not valid, which for it is now true.
   */
  claimResumableVerification(
    userId: string,
    codeHash: string,
    expectedSessionHash: string,
    nextSessionHash: string,
  ): Promise<boolean>;
  // --- WebAuthn credentials ---
  /** UPSERT by `credentialId` — counter/last-used updates re-add the credential. */
  addWebauthn(cred: StoredWebauthnCredential): Promise<void>;
  getWebauthn(credentialId: string): Promise<StoredWebauthnCredential | null>;
  listWebauthn(userId: string): Promise<StoredWebauthnCredential[]>;
  deleteWebauthn(credentialId: string): Promise<void>;
  // --- Auth-wallet credentials ---
  /** UPSERT by `credentialId`. */
  addWalletAuth(cred: StoredWalletAuthCredential): Promise<void>;
  findWalletAuthByHash(addressHash: string): Promise<StoredWalletAuthCredential | null>;
  listWalletAuth(userId: string): Promise<StoredWalletAuthCredential[]>;
  deleteWalletAuth(credentialId: string): Promise<void>;
  // --- Export jobs ---
  activeExportJob(userId: string): Promise<StoredExportJob | null>;
  createExportJob(userId: string, now?: number): Promise<StoredExportJob>;
  getExportJob(jobId: string): Promise<StoredExportJob | null>;
  /** Every export job for a user, regardless of state (deletion purge sweep). */
  listExportJobs(userId: string): Promise<StoredExportJob[]>;
  updateExportJob(jobId: string, patch: Partial<StoredExportJob>): Promise<StoredExportJob | null>;
  // --- Deletion requests ---
  getDeletion(userId: string): Promise<StoredDeletionRequest | null>;
  setDeletion(req: StoredDeletionRequest): Promise<void>;
  /** Grace-period deletion requests whose purge instant has passed (scheduler). */
  duePurgeDeletions(now: number): Promise<StoredDeletionRequest[]>;
  /**
   * EVERY grace-period request, due or not — the reconciliation set.
   *
   * A deletion request commits before its session revoke (only one of the two
   * can be retried), and the revoke can fail. The client cannot retry it: the
   * same commit deactivates the account, so `authMiddleware` refuses every route
   * that is not deletion-pending-aware. The row itself is therefore the durable
   * record of unfinished work, and the sweep finishes it.
   */
  pendingDeletions(): Promise<StoredDeletionRequest[]>;
  // --- Lifecycle ---
  /** Hard-remove every trace of a user (tests / hard purge). */
  purgeUser(userId: string): Promise<void>;
  /** Complete deletion (WS-D.2.4c): strip ALL personal data, keep an FK stub. */
  tombstoneUser(userId: string, now?: number): Promise<void>;
  /** Test support: wipe all rows (same surface as SessionStore/EphemeralStore). */
  clear(): Promise<void>;
}

export class InMemoryIdentityStore implements IdentityStore, InMemoryRollback {
  readonly #users = new Map<string, StoredUser>();
  readonly #auth = new Map<string, StoredUserAuth>();
  /** `${userId}:${codeHash}` → the session a spent code was spent to verify, and
   *  WHEN it was spent.  The in-memory twin of
   *  `mfa_recovery_codes.verification_session_hash` beside its `used_at`. */
  readonly #pendingVerifications = new Map<
    string,
    { sessionHash: string; remaining: number; usedAt: string }
  >();
  readonly #webauthn = new Map<string, StoredWebauthnCredential>();
  readonly #walletAuth = new Map<string, StoredWalletAuthCredential>();
  readonly #exportJobs = new Map<string, StoredExportJob>();
  readonly #deletions = new Map<string, StoredDeletionRequest>();

  /**
   * The unit of work's undo.
   *
   * Every write here REPLACES its row (`{ ...row, ...patch }` then `set`), which
   * is what makes a shallow snapshot sound — see `mapRollback`. Six maps because
   * one identity change routinely touches several: disabling email sign-in
   *  writes `users` and `user_auth`, and a unit that restored only one of them
   * would answer a different question from the transaction it stands in for.
   */
  beginRollback(): () => void {
    const undo = [
      mapRollback(this.#users),
      mapRollback(this.#auth),
      mapRollback(this.#pendingVerifications),
      mapRollback(this.#webauthn),
      mapRollback(this.#walletAuth),
      mapRollback(this.#exportJobs),
      mapRollback(this.#deletions),
    ];
    return () => {
      for (const restore of undo) restore();
    };
  }

  // --- Users ---------------------------------------------------------------
  async createUser(
    input: Omit<StoredUser, 'userId' | 'createdAt' | 'updatedAt' | 'stewardRoles'> & {
      userId?: string;
      stewardRoles?: StewardRoleId[];
    },
    now: number = Date.now(),
  ): Promise<StoredUser> {
    const userId = input.userId ?? randomUUID();
    const iso = new Date(now).toISOString();
    const user: StoredUser = {
      stewardRoles: [],
      ...input,
      userId,
      createdAt: iso,
      updatedAt: iso,
    };
    this.#users.set(userId, user);
    this.#auth.set(userId, {
      userId,
      emailVerified: false,
      emailVerifiedAt: null,
      pendingEmail: null,
      mfaEnabled: false,
      mfaSecret: null,
      mfaPending: false,
      mfaEnrolledAt: null,
      recoveryCodeHashes: [],
    });
    return user;
  }

  async getUser(userId: string): Promise<StoredUser | null> {
    return this.#users.get(userId) ?? null;
  }

  async getUserByHandle(handle: string): Promise<StoredUser | null> {
    const lower = handle.toLowerCase();
    for (const u of this.#users.values()) if (u.handle.toLowerCase() === lower) return u;
    return null;
  }

  async getUserByEmail(email: string): Promise<StoredUser | null> {
    const lower = email.toLowerCase();
    for (const u of this.#users.values()) if (u.email?.toLowerCase() === lower) return u;
    return null;
  }

  async getUsersByIds(userIds: readonly string[]): Promise<StoredUser[]> {
    const found: StoredUser[] = [];
    for (const id of userIds) {
      const user = this.#users.get(id);
      if (user) found.push(user);
    }
    return found;
  }

  async updateUser(
    userId: string,
    patch: Partial<StoredUser>,
    now: number = Date.now(),
  ): Promise<StoredUser | null> {
    const user = this.#users.get(userId);
    if (!user) return null;
    const updated = { ...user, ...patch, updatedAt: new Date(now).toISOString() };
    this.#users.set(userId, updated);
    return updated;
  }

  // --- User auth -----------------------------------------------------------
  async getAuth(userId: string): Promise<StoredUserAuth | null> {
    return this.#auth.get(userId) ?? null;
  }

  async setAuth(userId: string, patch: Partial<StoredUserAuth>): Promise<StoredUserAuth | null> {
    const auth = this.#auth.get(userId);
    if (!auth) return null;
    const updated = { ...auth, ...patch };
    this.#auth.set(userId, updated);
    // A FACTOR RESET INVALIDATES EVERY PENDING RESUME — see the Drizzle twin: a
    // continuation is about the factor it was issued for, and replacing the code
    // set ends that factor. Without this an old session could present its
    // already-spent old code after a re-enrollment and be verified against the
    // NEW one.
    if (patch.recoveryCodeHashes !== undefined) {
      for (const key of [...this.#pendingVerifications.keys()]) {
        if (key.startsWith(`${userId}:`)) this.#pendingVerifications.delete(key);
      }
    }
    return updated;
  }

  async consumeRecoveryCode(
    userId: string,
    codeHash: string,
    verificationSessionHash: string,
  ): Promise<{ remaining: number } | null> {
    // Test and write with NO `await` between them — on a single-threaded
    // runtime that is the same guarantee the conditional UPDATE gives.
    const auth = this.#auth.get(userId);
    if (!auth) return null;
    const idx = auth.recoveryCodeHashes.indexOf(codeHash);
    if (idx < 0) return null;
    const remaining = auth.recoveryCodeHashes.filter((_, i) => i !== idx);
    this.#auth.set(userId, { ...auth, recoveryCodeHashes: remaining });
    this.#pendingVerifications.set(`${userId}:${codeHash}`, {
      sessionHash: verificationSessionHash,
      remaining: remaining.length,
      // The twin of `used_at`, set in the SAME write as the session hash — the
      // resume window is measured from the consumption, not from the lookup.
      usedAt: new Date().toISOString(),
    });
    return { remaining: remaining.length };
  }

  async findResumableVerification(
    userId: string,
    codeHash: string,
    usedSince: string,
  ): Promise<{ remaining: number; verificationSessionHash: string } | null> {
    const pending = this.#pendingVerifications.get(`${userId}:${codeHash}`);
    if (pending === undefined) return null;
    // Past the window a verification could still be in flight, the continuation
    // is not a resumable operation — it is a spent code with an unsettled row.
    if (pending.usedAt < usedSince) return null;
    return { remaining: pending.remaining, verificationSessionHash: pending.sessionHash };
  }

  async clearResumableVerification(
    userId: string,
    codeHash: string,
    expectedSessionHash: string,
  ): Promise<boolean> {
    // Test and delete with NO `await` between — the same single-winner
    // guarantee the conditional DELETE gives on a single-threaded runtime.
    const key = `${userId}:${codeHash}`;
    const pending = this.#pendingVerifications.get(key);
    if (pending === undefined || pending.sessionHash !== expectedSessionHash) return false;
    return this.#pendingVerifications.delete(key);
  }

  async claimResumableVerification(
    userId: string,
    codeHash: string,
    expectedSessionHash: string,
    nextSessionHash: string,
  ): Promise<boolean> {
    // Test and write with NO `await` between — the same guarantee the
    // conditional UPDATE gives on a single-threaded runtime.
    const key = `${userId}:${codeHash}`;
    const pending = this.#pendingVerifications.get(key);
    if (pending === undefined || pending.sessionHash !== expectedSessionHash) return false;
    this.#pendingVerifications.set(key, { ...pending, sessionHash: nextSessionHash });
    return true;
  }

  // --- WebAuthn credentials ------------------------------------------------
  async addWebauthn(cred: StoredWebauthnCredential): Promise<void> {
    this.#webauthn.set(cred.credentialId, cred);
  }

  async getWebauthn(credentialId: string): Promise<StoredWebauthnCredential | null> {
    return this.#webauthn.get(credentialId) ?? null;
  }

  async listWebauthn(userId: string): Promise<StoredWebauthnCredential[]> {
    return [...this.#webauthn.values()].filter((c) => c.userId === userId);
  }

  async deleteWebauthn(credentialId: string): Promise<void> {
    this.#webauthn.delete(credentialId);
  }

  // --- Auth-wallet credentials --------------------------------------------
  async addWalletAuth(cred: StoredWalletAuthCredential): Promise<void> {
    this.#walletAuth.set(cred.credentialId, cred);
  }

  async findWalletAuthByHash(addressHash: string): Promise<StoredWalletAuthCredential | null> {
    for (const c of this.#walletAuth.values()) if (c.addressHash === addressHash) return c;
    return null;
  }

  async listWalletAuth(userId: string): Promise<StoredWalletAuthCredential[]> {
    return [...this.#walletAuth.values()].filter((c) => c.userId === userId);
  }

  async deleteWalletAuth(credentialId: string): Promise<void> {
    this.#walletAuth.delete(credentialId);
  }

  // --- Export jobs ---------------------------------------------------------
  async activeExportJob(userId: string): Promise<StoredExportJob | null> {
    for (const j of this.#exportJobs.values()) {
      if (j.userId === userId && (j.status === 'queued' || j.status === 'processing')) return j;
    }
    return null;
  }

  async createExportJob(userId: string, now: number = Date.now()): Promise<StoredExportJob> {
    const job: StoredExportJob = {
      jobId: randomUUID(),
      userId,
      status: 'queued',
      progressPct: 0,
      attempts: 0,
      downloadUrlRef: null,
      createdAt: new Date(now).toISOString(),
      completedAt: null,
      expiresAt: null,
    };
    this.#exportJobs.set(job.jobId, job);
    return job;
  }

  async getExportJob(jobId: string): Promise<StoredExportJob | null> {
    return this.#exportJobs.get(jobId) ?? null;
  }

  /** Every export job for a user, regardless of state (deletion purge sweep). */
  async listExportJobs(userId: string): Promise<StoredExportJob[]> {
    return [...this.#exportJobs.values()].filter((j) => j.userId === userId);
  }

  async updateExportJob(
    jobId: string,
    patch: Partial<StoredExportJob>,
  ): Promise<StoredExportJob | null> {
    const job = this.#exportJobs.get(jobId);
    if (!job) return null;
    const updated = { ...job, ...patch };
    this.#exportJobs.set(jobId, updated);
    return updated;
  }

  // --- Deletion requests ---------------------------------------------------
  async getDeletion(userId: string): Promise<StoredDeletionRequest | null> {
    return this.#deletions.get(userId) ?? null;
  }

  async setDeletion(req: StoredDeletionRequest): Promise<void> {
    this.#deletions.set(req.userId, req);
  }

  /** Grace-period deletion requests whose purge instant has passed (scheduler). */
  async duePurgeDeletions(now: number): Promise<StoredDeletionRequest[]> {
    return [...this.#deletions.values()].filter(
      (d) => d.state === 'grace_period' && Date.parse(d.purgeAt) <= now,
    );
  }

  async pendingDeletions(): Promise<StoredDeletionRequest[]> {
    return [...this.#deletions.values()].filter((d) => d.state === 'grace_period');
  }

  /** Hard-remove every trace of a user (used by tests / hard purge). */
  async purgeUser(userId: string): Promise<void> {
    this.#users.delete(userId);
    this.#auth.delete(userId);
    this.#deletions.delete(userId);
    for (const [id, c] of this.#webauthn) if (c.userId === userId) this.#webauthn.delete(id);
    for (const [id, c] of this.#walletAuth) if (c.userId === userId) this.#walletAuth.delete(id);
    for (const [id, j] of this.#exportJobs) if (j.userId === userId) this.#exportJobs.delete(id);
  }

  /**
   * Complete deletion (WS-D.2.4c): remove ALL personal data — credentials,
   * user_auth (MFA secret + recovery codes), export jobs, settings —
   * keeping only a minimal `user_id` + `account_state = deleted` tombstone so
   * anonymized contributions retain FK integrity.  The tombstone handle is
   * derived from sha256(user_id) (22 hex chars ⇒ 88 bits), so it fits the 30-char
   * handle CHECK, collides with negligible probability under the unique
   * lower(handle) index, and carries no personal data.
   */
  async tombstoneUser(userId: string, now: number = Date.now()): Promise<void> {
    this.#auth.delete(userId);
    for (const [id, c] of this.#webauthn) if (c.userId === userId) this.#webauthn.delete(id);
    for (const [id, c] of this.#walletAuth) if (c.userId === userId) this.#walletAuth.delete(id);
    for (const [id, j] of this.#exportJobs) if (j.userId === userId) this.#exportJobs.delete(id);
    const user = this.#users.get(userId);
    if (user) {
      this.#users.set(userId, {
        ...user,
        handle: `deleted_${sha256Hex(userId).slice(0, 22)}`,
        displayName: '[deleted]',
        email: null,
        accountState: 'deleted',
        locale: null,
        ageBand: null,
        // Settings are PERSONAL data (topic preferences):
        // reset to pristine defaults — nothing user-derived survives (WS-D.2.4c).
        privacySettings: defaultPrivacySettings(),
        personalizationSettings: defaultPersonalizationSettings(),
        updatedAt: new Date(now).toISOString(),
      });
    }
  }

  async clear(): Promise<void> {
    this.#users.clear();
    this.#auth.clear();
    this.#webauthn.clear();
    this.#walletAuth.clear();
    this.#exportJobs.clear();
    this.#deletions.clear();
  }
}
