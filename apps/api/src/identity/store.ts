// SPDX-License-Identifier: AGPL-3.0-or-later
//
// In-memory identity data store backing the BFF auth/privacy routes (WS-D).  It is
// the test/CI adapter mirroring the Drizzle schema in packages/db; a Drizzle-backed
// implementation with the same surface is the gated-integration concern (the
// established interface + in-memory pattern, e.g. TokenStore).
//
// Lookups by handle/email are case-insensitive (matching the partial/lower indexes
// in WS-D.1.1c).  Email is optional throughout.

import { randomUUID } from 'node:crypto';
import type {
  AgeBand,
  ExportJobState,
  PersonalizationSettings,
  PrivacySettings,
  ReputationSummaryPrivate,
  UserAccountState,
} from '@licio/shared';
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

export class IdentityStore {
  readonly #users = new Map<string, StoredUser>();
  readonly #auth = new Map<string, StoredUserAuth>();
  readonly #webauthn = new Map<string, StoredWebauthnCredential>();
  readonly #walletAuth = new Map<string, StoredWalletAuthCredential>();
  readonly #exportJobs = new Map<string, StoredExportJob>();
  readonly #deletions = new Map<string, StoredDeletionRequest>();

  // --- Users ---------------------------------------------------------------
  createUser(
    input: Omit<StoredUser, 'userId' | 'createdAt' | 'updatedAt'> & { userId?: string },
    now: number = Date.now(),
  ): StoredUser {
    const userId = input.userId ?? randomUUID();
    const iso = new Date(now).toISOString();
    const user: StoredUser = { ...input, userId, createdAt: iso, updatedAt: iso };
    this.#users.set(userId, user);
    this.#auth.set(userId, {
      userId,
      emailVerified: false,
      emailVerifiedAt: null,
      mfaEnabled: false,
      mfaSecret: null,
      mfaPending: false,
      mfaEnrolledAt: null,
      recoveryCodeHashes: [],
    });
    return user;
  }

  getUser(userId: string): StoredUser | null {
    return this.#users.get(userId) ?? null;
  }

  getUserByHandle(handle: string): StoredUser | null {
    const lower = handle.toLowerCase();
    for (const u of this.#users.values()) if (u.handle.toLowerCase() === lower) return u;
    return null;
  }

  getUserByEmail(email: string): StoredUser | null {
    const lower = email.toLowerCase();
    for (const u of this.#users.values()) if (u.email?.toLowerCase() === lower) return u;
    return null;
  }

  updateUser(
    userId: string,
    patch: Partial<StoredUser>,
    now: number = Date.now(),
  ): StoredUser | null {
    const user = this.#users.get(userId);
    if (!user) return null;
    const updated = { ...user, ...patch, updatedAt: new Date(now).toISOString() };
    this.#users.set(userId, updated);
    return updated;
  }

  // --- User auth -----------------------------------------------------------
  getAuth(userId: string): StoredUserAuth | null {
    return this.#auth.get(userId) ?? null;
  }

  setAuth(userId: string, patch: Partial<StoredUserAuth>): StoredUserAuth | null {
    const auth = this.#auth.get(userId);
    if (!auth) return null;
    const updated = { ...auth, ...patch };
    this.#auth.set(userId, updated);
    return updated;
  }

  // --- WebAuthn credentials ------------------------------------------------
  addWebauthn(cred: StoredWebauthnCredential): void {
    this.#webauthn.set(cred.credentialId, cred);
  }

  getWebauthn(credentialId: string): StoredWebauthnCredential | null {
    return this.#webauthn.get(credentialId) ?? null;
  }

  listWebauthn(userId: string): StoredWebauthnCredential[] {
    return [...this.#webauthn.values()].filter((c) => c.userId === userId);
  }

  deleteWebauthn(credentialId: string): void {
    this.#webauthn.delete(credentialId);
  }

  // --- Auth-wallet credentials --------------------------------------------
  addWalletAuth(cred: StoredWalletAuthCredential): void {
    this.#walletAuth.set(cred.credentialId, cred);
  }

  findWalletAuthByHash(addressHash: string): StoredWalletAuthCredential | null {
    for (const c of this.#walletAuth.values()) if (c.addressHash === addressHash) return c;
    return null;
  }

  listWalletAuth(userId: string): StoredWalletAuthCredential[] {
    return [...this.#walletAuth.values()].filter((c) => c.userId === userId);
  }

  deleteWalletAuth(credentialId: string): void {
    this.#walletAuth.delete(credentialId);
  }

  // --- Export jobs ---------------------------------------------------------
  activeExportJob(userId: string): StoredExportJob | null {
    for (const j of this.#exportJobs.values()) {
      if (j.userId === userId && (j.status === 'queued' || j.status === 'processing')) return j;
    }
    return null;
  }

  createExportJob(userId: string, now: number = Date.now()): StoredExportJob {
    const job: StoredExportJob = {
      jobId: randomUUID(),
      userId,
      status: 'queued',
      progressPct: 0,
      attempts: 0,
      createdAt: new Date(now).toISOString(),
      completedAt: null,
      expiresAt: null,
    };
    this.#exportJobs.set(job.jobId, job);
    return job;
  }

  getExportJob(jobId: string): StoredExportJob | null {
    return this.#exportJobs.get(jobId) ?? null;
  }

  updateExportJob(jobId: string, patch: Partial<StoredExportJob>): StoredExportJob | null {
    const job = this.#exportJobs.get(jobId);
    if (!job) return null;
    const updated = { ...job, ...patch };
    this.#exportJobs.set(jobId, updated);
    return updated;
  }

  // --- Deletion requests ---------------------------------------------------
  getDeletion(userId: string): StoredDeletionRequest | null {
    return this.#deletions.get(userId) ?? null;
  }

  setDeletion(req: StoredDeletionRequest): void {
    this.#deletions.set(req.userId, req);
  }

  /** Hard-remove every trace of a user (WS-D.2.4c complete removal). */
  purgeUser(userId: string): void {
    this.#users.delete(userId);
    this.#auth.delete(userId);
    for (const [id, c] of this.#webauthn) if (c.userId === userId) this.#webauthn.delete(id);
    for (const [id, c] of this.#walletAuth) if (c.userId === userId) this.#walletAuth.delete(id);
    for (const [id, j] of this.#exportJobs) if (j.userId === userId) this.#exportJobs.delete(id);
  }

  clear(): void {
    this.#users.clear();
    this.#auth.clear();
    this.#webauthn.clear();
    this.#walletAuth.clear();
    this.#exportJobs.clear();
    this.#deletions.clear();
  }
}
