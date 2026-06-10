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
import {
  type AgeBand,
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  type ExportJobState,
  emptyReputationSummary,
  type PersonalizationSettings,
  type PrivacySettings,
  type ReputationSummaryPrivate,
  type UserAccountState,
} from '@licio/shared';
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
  reputationSummary: ReputationSummaryPrivate;
  roles: Role[];
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
    input: Omit<StoredUser, 'userId' | 'createdAt' | 'updatedAt'> & { userId?: string },
    now?: number,
  ): Promise<StoredUser>;
  getUser(userId: string): Promise<StoredUser | null>;
  getUserByHandle(handle: string): Promise<StoredUser | null>;
  getUserByEmail(email: string): Promise<StoredUser | null>;
  updateUser(userId: string, patch: Partial<StoredUser>, now?: number): Promise<StoredUser | null>;
  // --- User auth ---
  getAuth(userId: string): Promise<StoredUserAuth | null>;
  setAuth(userId: string, patch: Partial<StoredUserAuth>): Promise<StoredUserAuth | null>;
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
  // --- Lifecycle ---
  /** Hard-remove every trace of a user (tests / hard purge). */
  purgeUser(userId: string): Promise<void>;
  /** Complete deletion (WS-D.2.4c): strip ALL personal data, keep an FK stub. */
  tombstoneUser(userId: string, now?: number): Promise<void>;
  /** Test support: wipe all rows (same surface as SessionStore/EphemeralStore). */
  clear(): Promise<void>;
}

export class InMemoryIdentityStore implements IdentityStore {
  readonly #users = new Map<string, StoredUser>();
  readonly #auth = new Map<string, StoredUserAuth>();
  readonly #webauthn = new Map<string, StoredWebauthnCredential>();
  readonly #walletAuth = new Map<string, StoredWalletAuthCredential>();
  readonly #exportJobs = new Map<string, StoredExportJob>();
  readonly #deletions = new Map<string, StoredDeletionRequest>();

  // --- Users ---------------------------------------------------------------
  async createUser(
    input: Omit<StoredUser, 'userId' | 'createdAt' | 'updatedAt'> & { userId?: string },
    now: number = Date.now(),
  ): Promise<StoredUser> {
    const userId = input.userId ?? randomUUID();
    const iso = new Date(now).toISOString();
    const user: StoredUser = { ...input, userId, createdAt: iso, updatedAt: iso };
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
    return updated;
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
   * user_auth (MFA secret + recovery codes), export jobs, settings, reputation —
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
        // Settings and reputation are PERSONAL data (topic preferences, scores):
        // reset to pristine defaults — nothing user-derived survives (WS-D.2.4c).
        privacySettings: defaultPrivacySettings(),
        personalizationSettings: defaultPersonalizationSettings(),
        reputationSummary: emptyReputationSummary(),
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
