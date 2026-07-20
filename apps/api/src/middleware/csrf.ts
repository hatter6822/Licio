// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomBytes } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { constantTimeEqual } from '../identity/crypto.js';
import { getIdentityServices, type IdentityServices } from '../identity/services.js';
import { readSessionToken, validateSession } from '../identity/sessions.js';
import { createLogger } from '../lib/logger.js';
import { getAllowedOrigins } from './cors.js';

const logger = createLogger(process.env['LOG_LEVEL'] ?? 'info');

const TOKEN_BYTE_LENGTH = 32;
const TOKEN_TTL_MS = 3_600_000;
const CLEANUP_INTERVAL_MS = 300_000;

interface StoredToken {
  token: string;
  expiresAt: number;
}

export interface TokenStore {
  get(sessionId: string): Promise<StoredToken | undefined>;
  /**
   * Atomically read-and-remove the stored token (single-use consumption).  A
   * get→compare→delete sequence is NOT atomic on a shared store, so concurrent
   * replays of the same token could all observe it before any delete lands;
   * `consume` collapses the read+delete into one atomic step (Redis `GETDEL`;
   * a synchronous get+delete with no intervening await in memory).
   */
  consume(sessionId: string): Promise<StoredToken | undefined>;
  set(sessionId: string, token: StoredToken): Promise<void>;
  delete(sessionId: string): Promise<void>;
  clear(): Promise<void>;
}

class MemoryTokenStore implements TokenStore {
  private readonly map = new Map<string, StoredToken>();
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  async get(sessionId: string): Promise<StoredToken | undefined> {
    return this.map.get(sessionId);
  }

  /** Atomic in the single-threaded event loop: no await sits between the read
   *  and the delete, so two concurrent consumers can never both observe it. */
  async consume(sessionId: string): Promise<StoredToken | undefined> {
    const value = this.map.get(sessionId);
    this.map.delete(sessionId);
    return value;
  }

  async set(sessionId: string, token: StoredToken): Promise<void> {
    this.map.set(sessionId, token);
    // Re-arm the expiry sweep lazily: `clear()` may have disposed the timer, and
    // a store that keeps accepting writes must keep sweeping expired entries.
    if (!this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
      this.cleanupTimer.unref?.();
    }
  }

  async delete(sessionId: string): Promise<void> {
    this.map.delete(sessionId);
  }

  async clear(): Promise<void> {
    this.map.clear();
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, value] of this.map) {
      if (now > value.expiresAt) {
        this.map.delete(key);
      }
    }
  }
}

/** Shape guard for the Redis round-trip: a corrupted value must read as "no
 *  token" (→ 403, fail closed), never as a crash or a forged acceptance. */
const storedTokenSchema = z.object({ token: z.string(), expiresAt: z.number() });

/**
 * The PRODUCTION token store: tokens live in Redis (TTL-bounded), so a token
 * minted on one instance verifies on every other and survives a process
 * restart.  Wired at boot (`setTokenStore`) alongside the other Redis-backed
 * identity stores — the in-memory default below is the dev/test posture only.
 */
export class RedisTokenStore implements TokenStore {
  private readonly redis: import('ioredis').default;
  private readonly prefix = 'csrf:';

  constructor(redis: import('ioredis').default) {
    this.redis = redis;
  }

  /** The Redis key is a SHA-256 of the session id, never the raw value: the
   *  cookie value is a BEARER session token, and raw keys would expose it to
   *  keyspace scans, monitoring, and backups (the session store itself only
   *  ever persists token hashes).  High-entropy input ⇒ a plain hash suffices. */
  #key(sessionId: string): string {
    return `${this.prefix}${createHash('sha256').update(sessionId).digest('hex')}`;
  }

  /** Decode a Redis round-trip: a corrupted value reads as "no token" (fail
   *  closed), never a crash or a forged acceptance. */
  #decode(raw: string | null): StoredToken | undefined {
    if (!raw) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const result = storedTokenSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  }

  async get(sessionId: string): Promise<StoredToken | undefined> {
    return this.#decode(await this.redis.get(this.#key(sessionId)));
  }

  /** `GETDEL` is a single atomic Redis command: read-and-remove in one round
   *  trip, so concurrent replays of the same token can never all pass. */
  async consume(sessionId: string): Promise<StoredToken | undefined> {
    return this.#decode(await this.redis.getdel(this.#key(sessionId)));
  }

  async set(sessionId: string, token: StoredToken): Promise<void> {
    const ttlSeconds = Math.ceil((token.expiresAt - Date.now()) / 1000);
    if (ttlSeconds > 0) {
      await this.redis.set(this.#key(sessionId), JSON.stringify(token), 'EX', ttlSeconds);
    }
  }

  async delete(sessionId: string): Promise<void> {
    await this.redis.del(this.#key(sessionId));
  }

  async clear(): Promise<void> {
    const keys = await this.redis.keys(`${this.prefix}*`);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}

let _tokenStore: TokenStore | undefined;

export function getTokenStore(): TokenStore {
  if (!_tokenStore) {
    _tokenStore = new MemoryTokenStore();
  }
  return _tokenStore;
}

export function setTokenStore(store: TokenStore): void {
  _tokenStore = store;
}

function generateToken(): string {
  return randomBytes(TOKEN_BYTE_LENGTH).toString('hex');
}

// Fully CSRF-exempt paths (no token, no Origin check). Two rationales:
//   • Telemetry/RUM + CSP-report are non-state-changing analytics delivered by
//     `sendBeacon` (which cannot set a CSRF header) and are cross-origin by
//     design.
//   • `/v1/takedowns` is PUBLIC copyright/legal intake (WS-F.1.4f): a rights
//     holder need not hold an account, so the request carries NO session
//     cookie — there is no victim session for CSRF to ride, and the Origin
//     check would wrongly block a legitimate embedded intake form on a rights
//     holder's own site. Abuse is bounded by the endpoint's own global rate
//     limit (30/min) and mandatory steward review before any action.
const EXEMPT_PATHS = new Set([
  '/health',
  '/api/security/csp-report',
  '/v1/telemetry',
  '/v1/takedowns',
  // The LCAP sync surface (WS-R.12.4) is device-certificate-authenticated CONTENT:
  // records carry their own COSE proofs (validate() is the real authentication), and
  // a native sync client holds NO session cookie — so there is no session for CSRF to
  // ride. `/packs` + `/exchange` import content (every record self-authenticating);
  // `/pulse` is a non-state-changing frontier exchange that returns only public tree
  // sizes + the revocation epoch. Abuse is bounded by each endpoint's own rate limit +
  // the §27 resource caps + the §27.2 malicious-graph guard before any expansion.
  '/api/lcap/v2/packs',
  '/api/lcap/v2/pulse',
  '/api/lcap/v2/exchange',
  // WS-R.15.6a — the server-blind WebRTC SIGNALING rendezvous: both POSTs route only an
  // OPAQUE sealed blob to/from an opaque peer key (the server never decodes it, holds no keys,
  // and runs no ACL — knowledge of the peer key IS the capability), and the syncRoomOverP2p
  // browser flow holds no session cookie for these, so there is no session for CSRF to ride.
  // Like the Private P2P rendezvous below, abuse is bounded by each endpoint's own rate limit.
  // (Without this, the browser's tokenless fetch 403s and WebRTC setup always falls back to
  // HTTPS — the cap/peer path is never exercised.)
  '/api/lcap/v2/p2p/signal',
  '/api/lcap/v2/p2p/signal/poll',
  // The §29.8 server export is gated by a device-signed, freshness-windowed `export_request`
  // (the requester must hold a non-revoked `may_export_bundle` capability for the room); the
  // signature IS the authentication, and a native peer holds no session cookie — so, like
  // `/packs`, there is no session for CSRF to ride. Abuse is bounded by its own rate limit +
  // the export gate. (The web-UI `/bundles/import` alias stays NON-exempt — it is a
  // session-bearing browser flow that keeps the double-submit token.)
  '/api/lcap/v2/bundles/export',
  // WS-S.6.6 — the server-blind Private P2P rendezvous endpoints carry only OPAQUE
  // blind ids + ciphertext + a short TTL (§15.3): the server holds no keys and
  // performs no ACL (knowledge of the rendezvous_key IS the capability), and a P2P
  // client holds no session cookie — so there is no session for CSRF to ride.
  // Abuse is bounded by each endpoint's own global rate limit + the server-side TTL
  // clamp + the bounded body/field sizes (§21.5/§27.2).
  '/v1/private-rendezvous/announce',
  '/v1/private-rendezvous/poll',
  '/v1/private-rendezvous/signal',
  '/v1/private-rendezvous/signal/poll',
]);
// WS-D identity/privacy endpoints rely on `SameSite=Strict` + the opaque session
// model (and a per-flow `login_attempt_id` binding) as the CSRF defense, so they do
// not use the WS-C double-submit token (WS-D.1.3b). Pre-auth flows (login/register)
// have no session to scope a token against in any case.
const EXEMPT_PREFIXES = ['/v1/auth/', '/v1/privacy/'];
const STATE_CHANGING_METHODS = new Set(['POST', 'PATCH', 'DELETE', 'PUT']);

function isTokenExemptPrefix(path: string): boolean {
  return EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Defense-in-depth against SAME-SITE CSRF (a malicious sibling subdomain).
 * `SameSite=Strict` still sends the session cookie on same-site requests, so for
 * every credentialed state-changing request we additionally require that a
 * present `Origin` (or, failing that, `Referer`) is the canonical app origin.
 * Browsers always send `Origin` on cross-origin POST/PATCH/DELETE, so a
 * cross-subdomain form POST is rejected; a header-less non-browser client is not
 * a CSRF vector and is allowed.  Returns true when the request must be REJECTED.
 */
function originMismatch(c: { req: { header: (k: string) => string | undefined } }): boolean {
  const allowed = getAllowedOrigins();
  const origin = c.req.header('origin');
  if (origin !== undefined) return !allowed.has(origin);
  const referer = c.req.header('referer');
  if (referer !== undefined) {
    try {
      return !allowed.has(new URL(referer).origin);
    } catch {
      return true; // a malformed Referer on a state-changing request → reject
    }
  }
  return false; // neither header present → not a browser-driven CSRF vector
}

export function csrfTokenRoute(
  resolveIdentity: () => IdentityServices = getIdentityServices,
): MiddlewareHandler {
  return async (c) => {
    const sessionId = readSessionToken(c.req.header('cookie'));
    if (!sessionId) {
      return c.json({ error: 'No session' }, 401);
    }

    // Mint a token ONLY for a session that actually exists.  Without this a
    // forged/expired cookie mints a fresh TTL-bounded store entry per request, so
    // an attacker cycling ids could grow the token store unbounded (the entries
    // are worthless to them — they can't ride a real session — but the store
    // still grows).  A validation-store outage degrades to 503, never an open
    // mint (fail closed).
    let valid: boolean;
    try {
      valid = (await validateSession(resolveIdentity().sessions, sessionId)) !== null;
    } catch {
      return c.json({ error: 'Session validation unavailable' }, 503);
    }
    if (!valid) {
      return c.json({ error: 'No session' }, 401);
    }

    const token = generateToken();
    const store = getTokenStore();
    await store.set(sessionId, {
      token,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });

    c.header('Cache-Control', 'no-store');
    return c.json({ token });
  };
}

export function csrfMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (!STATE_CHANGING_METHODS.has(c.req.method)) {
      await next();
      return;
    }

    // sendBeacon/report ingest is cross-origin BY DESIGN and header-less (it
    // cannot set a CSRF header); it carries no credentials and keeps its own
    // per-endpoint budget, so it is fully exempt — including from the Origin check.
    if (EXEMPT_PATHS.has(c.req.path)) {
      await next();
      return;
    }

    // Origin/Referer allowlist applies to EVERY remaining state-changing request,
    // including the SameSite-only WS-D identity/privacy endpoints (closes the
    // same-site sibling-subdomain CSRF gap).
    if (originMismatch(c)) {
      logger.warn({ auditAction: 'csrf_failure', reason: 'origin_mismatch', path: c.req.path });
      return c.json({ error: 'Forbidden' }, 403);
    }

    // WS-D identity/privacy endpoints rely on SameSite=Strict + the Origin check
    // above + a per-flow `login_attempt_id` binding instead of the WS-C
    // double-submit token (no session exists yet for the pre-auth flows).
    if (isTokenExemptPrefix(c.req.path)) {
      await next();
      return;
    }

    const sessionId = readSessionToken(c.req.header('cookie'));
    if (!sessionId) {
      logger.warn({ auditAction: 'csrf_failure', reason: 'no_session', path: c.req.path });
      return c.json({ error: 'Forbidden' }, 403);
    }

    const clientToken = c.req.header('x-csrf-token');
    if (!clientToken) {
      logger.warn({ auditAction: 'csrf_failure', reason: 'missing_token', path: c.req.path });
      return c.json({ error: 'CSRF token required' }, 403);
    }

    const store = getTokenStore();
    // Single-use: atomically read-and-remove so concurrent replays cannot all
    // pass.  A mismatch also consumes the stored token — hardening, since a
    // legitimate client always submits the freshly-minted correct value, and it
    // denies any retry oracle.
    const stored = await store.consume(sessionId);
    if (!stored) {
      logger.warn({ auditAction: 'csrf_failure', reason: 'no_stored_token', path: c.req.path });
      return c.json({ error: 'CSRF token invalid' }, 403);
    }

    if (Date.now() > stored.expiresAt) {
      logger.warn({ auditAction: 'csrf_failure', reason: 'expired_token', path: c.req.path });
      return c.json({ error: 'CSRF token expired' }, 403);
    }

    if (!constantTimeEqual(clientToken, stored.token)) {
      logger.warn({ auditAction: 'csrf_failure', reason: 'token_mismatch', path: c.req.path });
      return c.json({ error: 'CSRF token invalid' }, 403);
    }

    await next();
  };
}
