// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { createLogger } from '../lib/logger.js';

const logger = createLogger(process.env['LOG_LEVEL'] ?? 'info');

const TOKEN_BYTE_LENGTH = 32;
const TOKEN_TTL_MS = 3_600_000;

interface StoredToken {
  token: string;
  expiresAt: number;
}

const tokenStore = new Map<string, StoredToken>();

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
    tokenStore.set(sessionId, {
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

    const stored = tokenStore.get(sessionId);
    if (!stored) {
      logger.warn({ auditAction: 'csrf_failure', reason: 'no_stored_token', path: c.req.path });
      return c.json({ error: 'CSRF token invalid' }, 403);
    }

    if (Date.now() > stored.expiresAt) {
      tokenStore.delete(sessionId);
      logger.warn({ auditAction: 'csrf_failure', reason: 'expired_token', path: c.req.path });
      return c.json({ error: 'CSRF token expired' }, 403);
    }

    if (!constantTimeCompare(clientToken, stored.token)) {
      logger.warn({ auditAction: 'csrf_failure', reason: 'token_mismatch', path: c.req.path });
      return c.json({ error: 'CSRF token invalid' }, 403);
    }

    tokenStore.delete(sessionId);

    await next();
  };
}

export function setSessionCookie(sessionId: string): string {
  const maxAge = 86400;
  return `__Host-session=${sessionId}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

export { tokenStore as _tokenStore };
