// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
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

  async set(sessionId: string, token: StoredToken): Promise<void> {
    this.map.set(sessionId, token);
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

class RedisTokenStore implements TokenStore {
  private readonly redis: import('ioredis').default;
  private readonly prefix = 'csrf:';

  constructor(redis: import('ioredis').default) {
    this.redis = redis;
  }

  async get(sessionId: string): Promise<StoredToken | undefined> {
    const raw = await this.redis.get(`${this.prefix}${sessionId}`);
    if (!raw) return undefined;
    return JSON.parse(raw) as StoredToken;
  }

  async set(sessionId: string, token: StoredToken): Promise<void> {
    const ttlSeconds = Math.ceil((token.expiresAt - Date.now()) / 1000);
    if (ttlSeconds > 0) {
      await this.redis.set(`${this.prefix}${sessionId}`, JSON.stringify(token), 'EX', ttlSeconds);
    }
  }

  async delete(sessionId: string): Promise<void> {
    await this.redis.del(`${this.prefix}${sessionId}`);
  }

  async clear(): Promise<void> {
    const keys = await this.redis.keys(`${this.prefix}*`);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}

let _tokenStore: TokenStore | undefined;

export async function createTokenStore(): Promise<TokenStore> {
  const redisUrl = process.env['REDIS_URL'];
  if (redisUrl && process.env['NODE_ENV'] !== 'test') {
    try {
      const Redis = (await import('ioredis')).default;
      const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
      await redis.connect();
      logger.info('CSRF token store: Redis');
      return new RedisTokenStore(redis);
    } catch (err) {
      logger.warn({ err }, 'Redis unavailable for CSRF tokens, falling back to in-memory store');
    }
  }
  logger.info('CSRF token store: in-memory');
  return new MemoryTokenStore();
}

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

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function getSessionId(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  // Prefer the WS-D session cookie (`__Host-sid`); fall back to the WS-C name.
  const match = cookieHeader.match(/(?:^|;\s*)__Host-(?:sid|session)=([^;]+)/);
  return match?.[1];
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

export function csrfTokenRoute(): MiddlewareHandler {
  return async (c) => {
    const sessionId = getSessionId(c.req.header('cookie'));
    if (!sessionId) {
      return c.json({ error: 'No session' }, 401);
    }

    const token = generateToken();
    const store = getTokenStore();
    await store.set(sessionId, {
      token,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });

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

    const sessionId = getSessionId(c.req.header('cookie'));
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
    const stored = await store.get(sessionId);
    if (!stored) {
      logger.warn({ auditAction: 'csrf_failure', reason: 'no_stored_token', path: c.req.path });
      return c.json({ error: 'CSRF token invalid' }, 403);
    }

    if (Date.now() > stored.expiresAt) {
      await store.delete(sessionId);
      logger.warn({ auditAction: 'csrf_failure', reason: 'expired_token', path: c.req.path });
      return c.json({ error: 'CSRF token expired' }, 403);
    }

    if (!constantTimeCompare(clientToken, stored.token)) {
      logger.warn({ auditAction: 'csrf_failure', reason: 'token_mismatch', path: c.req.path });
      return c.json({ error: 'CSRF token invalid' }, 403);
    }

    await store.delete(sessionId);

    await next();
  };
}

export function setSessionCookie(sessionId: string): string {
  const maxAge = 86400;
  return `__Host-session=${sessionId}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}
