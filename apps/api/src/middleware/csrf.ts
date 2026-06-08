import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { RedisClientType } from 'redis';

const stateChangingMethods = new Set(['POST', 'PATCH', 'DELETE']);
const exemptPaths = new Set(['/health', '/api/csp-report', '/api/csrf-token']);
export const csrfTokenTtlSeconds = 900;

export interface CsrfStore {
  set(sessionId: string, token: string, ttlSeconds: number): Promise<void>;
  consume(sessionId: string): Promise<string | undefined>;
}

interface StoredCsrfToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

export class MemoryCsrfStore implements CsrfStore {
  private readonly tokens = new Map<string, StoredCsrfToken>();

  async set(sessionId: string, token: string, ttlSeconds: number): Promise<void> {
    this.tokens.set(sessionId, { token, expiresAtMs: Date.now() + ttlSeconds * 1000 });
  }

  async consume(sessionId: string): Promise<string | undefined> {
    const storedToken = this.tokens.get(sessionId);
    this.tokens.delete(sessionId);
    if (storedToken === undefined || storedToken.expiresAtMs < Date.now()) {
      return undefined;
    }
    return storedToken.token;
  }
}

export class RedisCsrfStore implements CsrfStore {
  constructor(private readonly redis: Pick<RedisClientType, 'getDel' | 'setEx'>) {}

  async set(sessionId: string, token: string, ttlSeconds: number): Promise<void> {
    await this.redis.setEx(this.key(sessionId), ttlSeconds, token);
  }

  async consume(sessionId: string): Promise<string | undefined> {
    return (await this.redis.getDel(this.key(sessionId))) ?? undefined;
  }

  private key(sessionId: string): string {
    return `csrf:${sessionId}`;
  }
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function readSessionId(cookieHeader: string | undefined): string | undefined {
  return cookieHeader
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('__Host-licio-session='))
    ?.split('=')[1];
}

export function csrfProtection(store: CsrfStore): MiddlewareHandler {
  return async (context, next) => {
    const url = new URL(context.req.url);
    if (!stateChangingMethods.has(context.req.method) || exemptPaths.has(url.pathname)) {
      return next();
    }

    const sessionId = readSessionId(context.req.header('Cookie'));
    const token = context.req.header('X-CSRF-Token');
    if (sessionId === undefined || token === undefined) {
      return context.json({ error: 'Missing CSRF token.' }, 403);
    }

    const expectedToken = await store.consume(sessionId);
    if (expectedToken === undefined || !constantTimeEqual(token, expectedToken)) {
      return context.json({ error: 'Invalid CSRF token.' }, 403);
    }

    return next();
  };
}
