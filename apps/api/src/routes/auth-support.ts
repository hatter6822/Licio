// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared helpers for the WS-D /v1/auth/* route modules: per-flow attempt cookies,
// the canonical rate-limit keying (WS-D.1.3d), session finalization with a
// new-device alert, and the contract-wallet verifier.
//
// Privacy amendment (§19.1): the application NEVER reads the client network
// address — there is no per-IP key, hashed or otherwise, anywhere.  Rate
// limiting is per-account (a non-reversible ref of the account under attack)
// plus a global identity-free backstop; a static test enforces that no source
// file reads the forwarded-address header.
import type { AuthMethod } from '@licio/shared';
import { accountRef, sessionRef as deriveSessionRef } from '../identity/crypto.js';
import { assessLogin, deviceProfile, sendSecurityAlert } from '../identity/security-alerts.js';
import type { IdentityServices } from '../identity/services.js';
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

/** Pre-attempt gate: blocked when the account is locked or the global backstop is on. */
export async function checkRateLimit(
  services: IdentityServices,
  accountKey: string,
): Promise<RateGate> {
  return services.rateLimit.check(accountKey);
}

/**
 * Record one auth failure (account + global counters) and, on the transition into
 * the 30-minute hard lock, fire the owner account-lockout alert (WS-D.1.3d).
 * `accountKey` is null for unattributable attempts (only the global counter moves).
 */
export async function recordAuthFailure(
  services: IdentityServices,
  opts: { accountKey: string | null; alertUserId?: string; authMethod?: AuthMethod },
): Promise<void> {
  const outcome = await services.rateLimit.recordFailure(opts.accountKey);
  await services.audit.append({
    actorUserId: opts.alertUserId ?? null,
    eventType: 'login_failure',
    context: opts.authMethod ? { auth_method: opts.authMethod } : {},
  });
  if (outcome.lockoutTriggered && opts.alertUserId) {
    const user = await services.store.getUser(opts.alertUserId);
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

export type LoginFinalization =
  | { ok: true; session: CreatedSession }
  | { ok: false; code: 'account_suspended' | 'account_unavailable' };

/**
 * Account-state gate at the session-mint chokepoint (fail closed).  A session is
 * created ONLY for an `active` account or a `deactivated` one inside its deletion
 * grace period (that session is restricted by the middleware to the deletion
 * status/cancel routes — the recovery path for a no-email account).  A suspended,
 * deleted, or otherwise non-active account never mints a session, even with a
 * valid credential.
 */
async function loginDenial(
  services: IdentityServices,
  userId: string,
): Promise<Extract<LoginFinalization, { ok: false }> | null> {
  const user = await services.store.getUser(userId);
  if (!user) return { ok: false, code: 'account_unavailable' };
  if (user.accountState === 'active') return null;
  if (
    user.accountState === 'deactivated' &&
    (await services.store.getDeletion(userId))?.state === 'grace_period'
  ) {
    return null;
  }
  return {
    ok: false,
    code: user.accountState === 'suspended' ? 'account_suspended' : 'account_unavailable',
  };
}

/**
 * Create a session on successful auth and raise a NEW-DEVICE alert if warranted.
 * No IP, no location is recorded — only a coarse device descriptor (§19.1).
 * Denies (without minting a session) when the account state forbids login.
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
): Promise<LoginFinalization> {
  const denial = await loginDenial(services, params.userId);
  if (denial) {
    await services.audit.append({
      actorUserId: params.userId,
      eventType: 'login_failure',
      context: { auth_method: params.authMethod },
    });
    return denial;
  }

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
    const user = await services.store.getUser(params.userId);
    await sendSecurityAlert({
      userId: params.userId,
      hasEmail: !!user?.email,
      hasPush: false,
      audit: services.audit,
      event: { type: 'new_signin', device: profile, authMethod: params.authMethod },
    });
  }
  return { ok: true, session: created };
}

/** The uniform 403 body for a state-denied login (post-credential-proof). */
export function loginDenialResponse(code: 'account_suspended' | 'account_unavailable') {
  return err(code, 'This account is not available.');
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
