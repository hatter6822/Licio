// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Server-side session lifecycle (WS-D.1.3b/c/e).  The cookie carries the RAW
// opaque token; Redis/the store is keyed by sha256(token), so a store leak yields
// no usable cookie.  Sessions slide on activity up to an absolute 90-day cap,
// rotate on privilege change (defeating fixation), and carry an `auth_assurance`
// clock that step-up re-authentication is measured against.
//
// Cookie: `__Host-sid; HttpOnly; Secure; SameSite=Strict; Path=/` (no Domain) —
// the `__Host-` prefix binds it to the exact host and blocks subdomain injection.
import type { AuthMethod, SessionRecord, SessionSummary } from '@licio/shared';
import { sessionRecordSchema } from '@licio/shared';
import { sessionRef as deriveSessionRef, randomToken, sha256Hex } from './crypto.js';

export const SESSION_COOKIE = '__Host-sid';

export const SESSION_POLICY = {
  defaultTtlMs: 24 * 60 * 60_000, // 24h
  rememberTtlMs: 30 * 24 * 60 * 60_000, // 30d
  absoluteCapMs: 90 * 24 * 60 * 60_000, // 90d absolute ceiling
  slideThrottleMs: 5 * 60_000, // refresh last_active_at at most every 5 min
  stepUpWindowMs: 5 * 60_000, // fresh-assertion window for sensitive actions
  maxConcurrent: 10, // bounded concurrent sessions per user
} as const;

const iso = (ms: number): string => new Date(ms).toISOString();
const truncate = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

export interface StoredSession {
  record: SessionRecord;
  /** Sliding expiry instant (epoch ms); never exceeds the record's absolute cap. */
  expiresAt: number;
}

export interface SessionStore {
  put(tokenHash: string, stored: StoredSession): Promise<void>;
  get(tokenHash: string): Promise<StoredSession | null>;
  delete(tokenHash: string): Promise<void>;
  listForUser(userId: string): Promise<Array<{ tokenHash: string; stored: StoredSession }>>;
  clear(): Promise<void>;
}

/** In-memory session store with a per-user index (mirrors a Redis user→tokens set). */
export class InMemorySessionStore implements SessionStore {
  readonly #byHash = new Map<string, StoredSession>();
  readonly #byUser = new Map<string, Set<string>>();

  async put(tokenHash: string, stored: StoredSession): Promise<void> {
    this.#byHash.set(tokenHash, stored);
    const set = this.#byUser.get(stored.record.user_id) ?? new Set<string>();
    set.add(tokenHash);
    this.#byUser.set(stored.record.user_id, set);
  }

  async get(tokenHash: string): Promise<StoredSession | null> {
    return this.#byHash.get(tokenHash) ?? null;
  }

  async delete(tokenHash: string): Promise<void> {
    const stored = this.#byHash.get(tokenHash);
    this.#byHash.delete(tokenHash);
    if (stored) this.#byUser.get(stored.record.user_id)?.delete(tokenHash);
  }

  async listForUser(userId: string): Promise<Array<{ tokenHash: string; stored: StoredSession }>> {
    const hashes = this.#byUser.get(userId) ?? new Set<string>();
    const out: Array<{ tokenHash: string; stored: StoredSession }> = [];
    for (const tokenHash of hashes) {
      const stored = this.#byHash.get(tokenHash);
      if (stored) out.push({ tokenHash, stored });
    }
    return out;
  }

  async clear(): Promise<void> {
    this.#byHash.clear();
    this.#byUser.clear();
  }
}

export interface CreateSessionInput {
  userId: string;
  authMethod: AuthMethod;
  credentialRef?: string | null;
  ipHash: string;
  userAgent: string;
  deviceLabel: string;
  country?: string | null;
  rememberMe: boolean;
}

export interface CreatedSession {
  token: string;
  tokenHash: string;
  record: SessionRecord;
  expiresAt: number;
  maxAgeSec: number;
}

/** Create a new session, returning the RAW token (cookie value) and stored record. */
export async function createSession(
  store: SessionStore,
  input: CreateSessionInput,
  now: number = Date.now(),
): Promise<CreatedSession> {
  const token = randomToken(32);
  const tokenHash = sha256Hex(token);
  const ttl = input.rememberMe ? SESSION_POLICY.rememberTtlMs : SESSION_POLICY.defaultTtlMs;
  const absolute = now + SESSION_POLICY.absoluteCapMs;
  const expiresAt = Math.min(now + ttl, absolute);
  const record = sessionRecordSchema.parse({
    user_id: input.userId,
    auth_method: input.authMethod,
    credential_ref: input.credentialRef ?? null,
    created_at: iso(now),
    last_active_at: iso(now),
    ip_hash: input.ipHash,
    user_agent_truncated: truncate(input.userAgent, 256),
    device_label: truncate(input.deviceLabel, 128),
    country: input.country ?? null,
    remember_me: input.rememberMe,
    auth_assurance: { level: 'full', last_verified_at: iso(now) },
    absolute_expires_at: iso(absolute),
  });
  await store.put(tokenHash, { record, expiresAt });
  await enforceConcurrencyCap(store, input.userId, now);
  return { token, tokenHash, record, expiresAt, maxAgeSec: Math.ceil((expiresAt - now) / 1000) };
}

/** Evict the oldest sessions beyond the concurrency cap (bounded device list). */
async function enforceConcurrencyCap(
  store: SessionStore,
  userId: string,
  now: number,
): Promise<void> {
  const sessions = (await store.listForUser(userId)).filter((s) => s.stored.expiresAt > now);
  if (sessions.length <= SESSION_POLICY.maxConcurrent) return;
  sessions
    .sort((a, b) => Date.parse(a.stored.record.created_at) - Date.parse(b.stored.record.created_at))
    .slice(0, sessions.length - SESSION_POLICY.maxConcurrent)
    .forEach((s) => void store.delete(s.tokenHash));
}

export interface ValidatedSession {
  tokenHash: string;
  record: SessionRecord;
}

/**
 * Validate a presented raw token.  Returns null (and deletes the row) when the
 * session is absent, past its sliding expiry, or past its absolute cap.
 */
export async function validateSession(
  store: SessionStore,
  token: string,
  now: number = Date.now(),
): Promise<ValidatedSession | null> {
  const tokenHash = sha256Hex(token);
  const stored = await store.get(tokenHash);
  if (!stored) return null;
  if (now >= stored.expiresAt || now >= Date.parse(stored.record.absolute_expires_at)) {
    await store.delete(tokenHash);
    return null;
  }
  return { tokenHash, record: stored.record };
}

/** Sliding refresh of `last_active_at`, throttled to once per 5 minutes. */
export async function touchSession(
  store: SessionStore,
  tokenHash: string,
  now: number = Date.now(),
): Promise<void> {
  const stored = await store.get(tokenHash);
  if (!stored) return;
  if (now - Date.parse(stored.record.last_active_at) < SESSION_POLICY.slideThrottleMs) return;
  const ttl = stored.record.remember_me
    ? SESSION_POLICY.rememberTtlMs
    : SESSION_POLICY.defaultTtlMs;
  const absolute = Date.parse(stored.record.absolute_expires_at);
  await store.put(tokenHash, {
    record: { ...stored.record, last_active_at: iso(now) },
    expiresAt: Math.min(now + ttl, absolute),
  });
}

/**
 * Rotate the session id (WS-D.1.3e): mint a new token, copy the record (preserving
 * assurance + absolute cap), write the new key, delete the old.  Other concurrent
 * sessions are untouched.  Returns the new raw token, or null if the old is gone.
 */
export async function rotateSession(
  store: SessionStore,
  oldToken: string,
  now: number = Date.now(),
): Promise<CreatedSession | null> {
  const oldHash = sha256Hex(oldToken);
  const stored = await store.get(oldHash);
  if (!stored) return null;
  const token = randomToken(32);
  const tokenHash = sha256Hex(token);
  await store.put(tokenHash, stored);
  await store.delete(oldHash);
  return {
    token,
    tokenHash,
    record: stored.record,
    expiresAt: stored.expiresAt,
    maxAgeSec: Math.max(0, Math.ceil((stored.expiresAt - now) / 1000)),
  };
}

/** Whether a sensitive action requires a fresh step-up (assurance is stale). */
export function needsStepUp(
  record: SessionRecord,
  now: number = Date.now(),
  windowMs: number = SESSION_POLICY.stepUpWindowMs,
): boolean {
  return now - Date.parse(record.auth_assurance.last_verified_at) > windowMs;
}

/** Record a fresh step-up assertion, refreshing the assurance clock to `now`. */
export async function markStepUp(
  store: SessionStore,
  tokenHash: string,
  now: number = Date.now(),
): Promise<void> {
  const stored = await store.get(tokenHash);
  if (!stored) return;
  await store.put(tokenHash, {
    ...stored,
    record: {
      ...stored.record,
      auth_assurance: { level: 'full', last_verified_at: iso(now) },
    },
  });
}

/** Revoke all of a user's sessions except `exceptHash`; returns the revoked count. */
export async function revokeOthersForUser(
  store: SessionStore,
  userId: string,
  exceptHash: string,
): Promise<number> {
  const sessions = await store.listForUser(userId);
  let revoked = 0;
  for (const { tokenHash } of sessions) {
    if (tokenHash !== exceptHash) {
      await store.delete(tokenHash);
      revoked += 1;
    }
  }
  return revoked;
}

/** Revoke ALL of a user's sessions (e.g. on deletion request). */
export async function revokeAllForUser(store: SessionStore, userId: string): Promise<number> {
  const sessions = await store.listForUser(userId);
  for (const { tokenHash } of sessions) await store.delete(tokenHash);
  return sessions.length;
}

/** Build the active-sessions list for the owner UI (no token, no plaintext IP). */
export async function sessionSummaries(
  store: SessionStore,
  userId: string,
  currentHash: string,
  masterSecret: string,
  now: number = Date.now(),
): Promise<SessionSummary[]> {
  const sessions = await store.listForUser(userId);
  return sessions
    .filter((s) => s.stored.expiresAt > now)
    .map(({ tokenHash, stored }) => ({
      session_ref: deriveSessionRef(masterSecret, tokenHash),
      device_label: stored.record.device_label,
      auth_method: stored.record.auth_method,
      country: stored.record.country,
      created_at: stored.record.created_at,
      last_active_at: stored.record.last_active_at,
      current: tokenHash === currentHash,
    }))
    .sort((a, b) => Date.parse(b.last_active_at) - Date.parse(a.last_active_at));
}

// ---------------------------------------------------------------------------
// Cookie helpers.
// ---------------------------------------------------------------------------

export function buildSessionCookie(token: string, maxAgeSec: number): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export function readSessionToken(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  return cookieHeader.match(/(?:^|;\s*)__Host-sid=([^;]+)/)?.[1];
}
