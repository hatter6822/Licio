// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared helpers for the WS-D /v1/auth/* route modules: per-flow attempt cookies,
// the canonical rate-limit keying (WS-D.1.3d), session finalization with a
// new-device alert, and the contract-wallet verifier.
//
// Privacy amendment (§19.1): the client IP is used ONLY as a transient, hashed
// rate-limit counter key — never stored in a session/audit/log.
import type { AuthMethod } from '@licio/shared';
import { accountRef, sessionRef as deriveSessionRef } from '../identity/crypto.js';
import { assessLogin, deviceProfile, sendSecurityAlert } from '../identity/security-alerts.js';
import { hashIp, type IdentityServices } from '../identity/services.js';
import { type CreatedSession, createSession } from '../identity/sessions.js';
import { type ContractSignatureVerifier, createContractVerifier } from '../identity/siwe.js';

export { deriveSessionRef };

/** Distinct short-lived attempt cookies per flow so concurrent flows never collide. */
export const ATTEMPT_COOKIES = {
  emailLogin: '__Host-otp',
  webauthnLogin: '__Host-wa',
  walletLogin: '__Host-siwe',
  passkeySignup: '__Host-pksignup',
  walletSignup: '__Host-wsignup',
  stepUp: '__Host-su',
} as const;
export type AttemptCookie = (typeof ATTEMPT_COOKIES)[keyof typeof ATTEMPT_COOKIES];

const ATTEMPT_MAX_AGE = 600; // 10 minutes

export function buildAttemptCookie(name: AttemptCookie, id: string): string {
  return `${name}=${id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${ATTEMPT_MAX_AGE}`;
}
export function clearAttemptCookie(name: AttemptCookie): string {
  return `${name}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}
export function readAttempt(
  cookieHeader: string | undefined,
  name: AttemptCookie,
): string | undefined {
  return cookieHeader?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1];
}

export interface HeaderCtx {
  req: { header: (k: string) => string | undefined };
}

/** Transient client IP — hashed for the rate-limit key only, never persisted (§19.1). */
export function clientIp(c: HeaderCtx): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}
export function rateLimitIpKey(services: IdentityServices, c: HeaderCtx): string {
  return hashIp(services.config.masterSecret, clientIp(c));
}

// --- Canonical per-account rate-limit keys (WS-D.1.3d) ---------------------
export function accountRefForUser(services: IdentityServices, userId: string): string {
  return accountRef(services.config.masterSecret, `user:${userId}`);
}
export function accountRefForEmail(services: IdentityServices, email: string): string {
  return accountRef(services.config.masterSecret, `email:${email.toLowerCase()}`);
}
export function accountRefForWallet(services: IdentityServices, addressHash: string): string {
  return accountRef(services.config.masterSecret, `wallet:${addressHash}`);
}

export interface RateGate {
  allowed: boolean;
  retryAfterSec: number;
}

/** Pre-attempt gate: blocked when the account is locked or the IP is blocked. */
export async function checkRateLimit(
  services: IdentityServices,
  c: HeaderCtx,
  accountKey: string,
): Promise<RateGate> {
  return services.rateLimit.check(accountKey, rateLimitIpKey(services, c));
}

/**
 * Record one auth failure (account + IP counters) and, on the transition into the
 * 30-minute hard lock, fire the owner account-lockout alert (WS-D.1.3d).
 * `accountKey` is null for unattributable attempts (only the IP counter moves).
 */
export async function recordAuthFailure(
  services: IdentityServices,
  c: HeaderCtx,
  opts: { accountKey: string | null; alertUserId?: string; authMethod?: AuthMethod },
): Promise<void> {
  const outcome = await services.rateLimit.recordFailure(
    opts.accountKey,
    rateLimitIpKey(services, c),
  );
  await services.audit.append({
    actorUserId: opts.alertUserId ?? null,
    eventType: 'login_failure',
    context: opts.authMethod ? { auth_method: opts.authMethod } : {},
  });
  if (outcome.lockoutTriggered && opts.alertUserId) {
    const user = services.store.getUser(opts.alertUserId);
    await sendSecurityAlert({
      userId: opts.alertUserId,
      hasEmail: !!user?.email,
      hasPush: false,
      audit: services.audit,
      event: {
        type: 'account_lockout',
        ...(opts.authMethod ? { authMethod: opts.authMethod } : {}),
      },
    });
  }
}

/**
 * Create a session on successful auth and raise a NEW-DEVICE alert if warranted.
 * No IP, no location is recorded — only a coarse device descriptor (§19.1).
 */
export async function finalizeLogin(
  services: IdentityServices,
  c: HeaderCtx,
  params: {
    userId: string;
    authMethod: AuthMethod;
    credentialRef: string | null;
    rememberMe: boolean;
    mfaVerified?: boolean;
  },
): Promise<CreatedSession> {
  const profile = deviceProfile(c.req.header('user-agent') ?? '');
  const existing = await services.sessions.listForUser(params.userId);
  const history = existing.map((s) => ({ deviceProfile: s.stored.record.device_label }));

  const created = await createSession(services.sessions, {
    userId: params.userId,
    authMethod: params.authMethod,
    credentialRef: params.credentialRef,
    deviceLabel: profile,
    rememberMe: params.rememberMe,
    mfaVerified: params.mfaVerified ?? false,
  });

  await services.rateLimit.recordSuccess(accountRefForUser(services, params.userId));
  await services.audit.append({
    actorUserId: params.userId,
    eventType: 'login_success',
    context: { device: profile, auth_method: params.authMethod },
  });

  const decision = assessLogin({ deviceProfile: profile, authMethod: params.authMethod }, history);
  if (decision.suspicious) {
    const user = services.store.getUser(params.userId);
    await sendSecurityAlert({
      userId: params.userId,
      hasEmail: !!user?.email,
      hasPush: false,
      audit: services.audit,
      event: { type: 'new_signin', device: profile, authMethod: params.authMethod },
    });
  }
  return created;
}

// --- Misc -----------------------------------------------------------------

export interface PublicUserInput {
  userId: string;
  handle: string;
  displayName: string;
  accountState: 'active' | 'suspended' | 'deactivated' | 'deleted';
  locale: string | null;
  createdAt: string;
}

/** The §22.1 public projection of a user (the only shape returned to others). */
export function publicUser(user: PublicUserInput | null) {
  if (!user) throw new Error('user missing after authentication');
  return {
    user_id: user.userId,
    handle: user.handle,
    display_name: user.displayName,
    locale: user.locale,
    account_state: user.accountState,
    created_at: user.createdAt,
  };
}

export const err = (code: string, message: string) => ({ error: { code, message } }) as const;

/** Resolve the configured contract-wallet verifier (EIP-1271/6492), or undefined. */
export function contractVerifierFor(
  services: IdentityServices,
): ContractSignatureVerifier | undefined {
  return createContractVerifier(services.config.siwe.chainRpcUrls ?? {});
}

export { deviceProfile };
