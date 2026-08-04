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
  /**
   * Bumped on every write — the handle a conditional write compares against.
   *
   * Every mutation here is read-modify-write over the WHOLE record, so two of
   * them racing do not merge: the later write replaces the earlier one wholesale
   * with a snapshot taken before it. That is not a lost update in the abstract —
   * a throttled activity slide, holding a copy read just before an MFA grant,
   * put `mfa_verified: false` back after the grant had landed, and the
   * verification then rotated the REVERTED record and reported success. The
   * recovery code was spent and no session ever became verified.
   *
   * A row written before this field existed reads as version 0, so a first
   * conditional write against it still behaves.
   */
  version: number;
}

export interface SessionStore {
  put(tokenHash: string, stored: StoredSession): Promise<void>;
  get(tokenHash: string): Promise<StoredSession | null>;
  delete(tokenHash: string): Promise<void>;
  /**
   * Get AND delete in one step, returning what was there — the primitive a
   * ROTATION needs.
   *
   * A rotation is a hand-off, so exactly one caller may take the old session.
   * Read-then-delete is not that: two concurrent requests carrying the same
   * cookie both read it, both mint a successor, and one session becomes two —
   * from one privilege transition, and (on the recovery path) from one
   * single-use code.  `take` makes the delete the claim, so the loser gets
   * `null` and mints nothing.
   */
  take(tokenHash: string): Promise<StoredSession | null>;
  /**
   * Write ONLY if the session is still there AND still at `expectedVersion`;
   * `false` otherwise.  The stored version is bumped by the write.
   *
   * Existence alone was not enough, and both halves are load-bearing:
   *
   *  • WITHOUT the existence half, a mutation RESURRECTS a session a concurrent
   *    rotation or sign-out deleted, restoring it with whatever privilege the
   *    edit was adding.
   *  • WITHOUT the version half, a mutation silently REVERTS one: these writes
   *    replace the whole record, so a caller holding a snapshot read before
   *    someone else's change puts that change back the way it was.  A throttled
   *    activity slide did exactly that to an MFA grant — the verification then
   *    rotated the reverted record and reported success, and the recovery code
   *    was spent without any session becoming verified.
   */
  putIfVersion(tokenHash: string, expectedVersion: number, stored: StoredSession): Promise<boolean>;
  /**
   * Move a session to a new token in ONE step, returning the moved record.
   *
   * The rotation is a hand-off and must not be able to stop half way. As
   * `take` then `put` it could: the old key was already gone when the write of
   * the successor failed, leaving the holder with NO session — and because the
   * recovery continuation is settled before the rotation, a spent last code was
   * no longer resumable either. That is the lockout the continuation exists to
   * prevent, reintroduced one step further along. Atomically, a failure leaves
   * the old session exactly where it was, still holding the grant.
   */
  rotate(oldHash: string, newHash: string): Promise<StoredSession | null>;
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

  async take(tokenHash: string): Promise<StoredSession | null> {
    // Read and remove with NO `await` between them — on a single-threaded
    // runtime that is the same guarantee Redis's GETDEL gives.
    const stored = this.#byHash.get(tokenHash);
    if (stored === undefined) return null;
    this.#byHash.delete(tokenHash);
    this.#byUser.get(stored.record.user_id)?.delete(tokenHash);
    return stored;
  }

  async putIfVersion(
    tokenHash: string,
    expectedVersion: number,
    stored: StoredSession,
  ): Promise<boolean> {
    // Test and write with NO `await` between — the same guarantee the Redis
    // twin gets from a Lua script: a session deleted while the caller was
    // editing it is not brought back, and one changed underneath the caller is
    // not reverted to the copy they read.
    const current = this.#byHash.get(tokenHash);
    if (current === undefined || current.version !== expectedVersion) return false;
    this.#byHash.set(tokenHash, { ...stored, version: expectedVersion + 1 });
    return true;
  }

  async rotate(oldHash: string, newHash: string): Promise<StoredSession | null> {
    // One step: the old token is gone and the new one exists, or neither
    // happened. No `await` between, so nothing observes the gap.
    const stored = this.#byHash.get(oldHash);
    if (stored === undefined) return null;
    const moved = { ...stored, version: stored.version + 1 };
    this.#byHash.delete(oldHash);
    this.#byHash.set(newHash, moved);
    const index = this.#byUser.get(stored.record.user_id);
    index?.delete(oldHash);
    index?.add(newHash);
    return moved;
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
  /** Coarse device descriptor (e.g. "iOS/Safari"). NO IP, NO location are accepted. */
  deviceLabel: string;
  rememberMe: boolean;
  /** True for a steward session that has already cleared TOTP MFA (WS-D.1.5b). */
  mfaVerified?: boolean;
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
    device_label: truncate(input.deviceLabel, 128),
    remember_me: input.rememberMe,
    mfa_verified: input.mfaVerified ?? false,
    auth_assurance: { level: 'full', last_verified_at: iso(now) },
    absolute_expires_at: iso(absolute),
  });
  await store.put(tokenHash, { record, expiresAt, version: 0 });
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
  const toEvict = sessions
    .sort((a, b) => Date.parse(a.stored.record.created_at) - Date.parse(b.stored.record.created_at))
    .slice(0, sessions.length - SESSION_POLICY.maxConcurrent);
  // Await the deletions (the store is async/Redis-backed): a login must not
  // resolve while the user is still above the advertised cap, and a backing-store
  // error must surface rather than become an unhandled rejection.
  await Promise.all(toEvict.map((s) => store.delete(s.tokenHash)));
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

/**
 * Read-modify-write a session under the version CAS, retrying a lost race.
 *
 * These mutations edit ONE field of a whole-record snapshot, so two racing
 * writers do not merge — the later one replaces the earlier wholesale. The CAS
 * turns that silent revert into a visible miss, and the retry re-reads and
 * re-applies the edit on top of whatever landed. Returns false only when the
 * session is genuinely gone.
 *
 * Bounded: a caller that cannot win in a few attempts is contending with a
 * writer far hotter than any real session, and looping forever inside a request
 * is worse than reporting the miss.
 */
async function mutateSession(
  store: SessionStore,
  tokenHash: string,
  edit: (stored: StoredSession) => StoredSession,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stored = await store.get(tokenHash);
    if (!stored) return false;
    if (await store.putIfVersion(tokenHash, stored.version, edit(stored))) return true;
  }
  return false;
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
  // Under the CAS, so a slide can neither RE-CREATE a session revoked
  // mid-request nor REVERT a privilege granted since it read — it once put
  // `mfa_verified: false` back over a landed MFA grant, from a copy read a
  // moment earlier.
  await mutateSession(store, tokenHash, (current) => {
    const ttl = current.record.remember_me
      ? SESSION_POLICY.rememberTtlMs
      : SESSION_POLICY.defaultTtlMs;
    const absolute = Date.parse(current.record.absolute_expires_at);
    return {
      ...current,
      record: { ...current.record, last_active_at: iso(now) },
      expiresAt: Math.min(now + ttl, absolute),
    };
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
  // ONE STEP, and exactly one caller may take it.  This was a read, a write of
  // the successor, then a delete of the old — which fails in both directions.
  // Two concurrent requests carrying the same cookie both passed the read and
  // both wrote a successor, so one session became TWO: a privilege transition
  // that multiplies instead of moving (one single-use recovery code granting
  // MFA twice; a stolen cookie replayed alongside the genuine request keeping a
  // session of its own). Taking the old session first fixed that and opened the
  // opposite hole — the old key was already gone when the successor's write
  // failed, leaving the holder with NO session and, since the continuation is
  // settled before this point, no way to resume a spent last code either.
  //
  // `rotate` is both halves at once: after it, the old token is gone and the new
  // one exists, or neither is true and the old session still holds the grant.
  const token = randomToken(32);
  const tokenHash = sha256Hex(token);
  const stored = await store.rotate(oldHash, tokenHash);
  if (!stored) return null;
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
  // Under the CAS — see `mutateSession`.
  await mutateSession(store, tokenHash, (current) => ({
    ...current,
    record: {
      ...current.record,
      auth_assurance: { level: 'full', last_verified_at: iso(now) },
    },
  }));
}

/**
 * Mark the CURRENT session as having cleared steward TOTP MFA (WS-D.1.5b).  A
 * steward session is reduced-capability until this is set; it grants steward
 * capabilities only afterwards.  Also refreshes the step-up clock.
 */
/**
 * Grant the session its MFA-verified standing.
 *
 * Returns FALSE when there is no such session — expired, or revoked between the
 * middleware's check and this call. Silently returning made the caller report
 * `mfa_verified` for a grant that did not happen, which on the recovery-code
 * path meant a spent code, a success in the audit trail, and a session that was
 * never verified.
 */
export async function markMfaVerified(
  store: SessionStore,
  tokenHash: string,
  now: number = Date.now(),
): Promise<boolean> {
  // UNDER THE CAS.  A plain `put` here resurrected a session a concurrent
  // rotation had already taken — handing the grant to a row that was supposed
  // to be gone — and, in the other direction, let a concurrent activity slide
  // put `mfa_verified: false` back over this very grant from a stale snapshot.
  return mutateSession(store, tokenHash, (current) => ({
    ...current,
    record: {
      ...current.record,
      mfa_verified: true,
      auth_assurance: { level: 'full', last_verified_at: iso(now) },
    },
  }));
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
