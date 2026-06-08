// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { createLogger } from '../lib/logger.js';

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
  const match = cookieHeader.match(/(?:^|;\s*)__Host-session=([^;]+)/);
  return match?.[1];
}

const EXEMPT_PATHS = new Set(['/health', '/api/security/csp-report']);
const STATE_CHANGING_METHODS = new Set(['POST', 'PATCH', 'DELETE', 'PUT']);

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

    if (EXEMPT_PATHS.has(c.req.path)) {
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
