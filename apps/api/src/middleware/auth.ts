// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Authentication middleware + capability guards (WS-D.1.6a).  It validates the
// `__Host-sid` session, attaches a typed AuthContext, gates account state, and
// FAILS CLOSED: any error loading/validating the session denies rather than
// allows.  Routes never re-parse cookies — AuthContext is the single identity
// source.
import type {
  AgeBand,
  AuthAssurance,
  AuthMethod,
  StewardRoleId,
  UserAccountState,
} from '@licio/shared';
import type { MiddlewareHandler } from 'hono';
import { hasVerifiedCredential } from '../identity/auth-methods.js';
import { isAiTeam, isSteward, type Role } from '../identity/rbac.js';
import {
  authMethodInventory,
  getIdentityServices,
  type IdentityServices,
} from '../identity/services.js';
import {
  readSessionToken,
  SESSION_POLICY,
  touchSession,
  validateSession,
} from '../identity/sessions.js';

export interface AuthContext {
  userId: string;
  accountState: UserAccountState;
  roles: Role[];
  /** Doctrine steward-role grants (WS-J console authorization). */
  stewardRoles: StewardRoleId[];
  authMethod: AuthMethod;
  authAssurance: AuthAssurance;
  emailVerified: boolean;
  /** True when the account holds any verified credential (passkey/wallet/verified email). */
  accountVerified: boolean;
  ageBand: AgeBand | null;
  /** Whether the account has TOTP MFA enrolled+active. */
  mfaActive: boolean;
  /** Whether THIS session has cleared a TOTP code (per-session steward MFA). */
  mfaVerified: boolean;
  tokenHash: string;
}

export type AuthEnv = {
  Variables: {
    requestId: string;
    auth?: AuthContext;
  };
};

const deny = (code: string, message: string) => ({ error: { code, message } }) as const;

/** Validate the session and attach AuthContext, or reject (fail-closed). */
export function authMiddleware(
  resolve: () => IdentityServices = getIdentityServices,
  opts: { allowDeletionPending?: boolean } = {},
): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const services = resolve();
    const token = readSessionToken(c.req.header('cookie'));
    if (!token) return c.json(deny('unauthenticated', 'Authentication required'), 401);

    let validated: Awaited<ReturnType<typeof validateSession>>;
    try {
      validated = await validateSession(services.sessions, token);
    } catch {
      // An outage degrades to "no access", never "open access".
      return c.json(deny('unavailable', 'Authentication temporarily unavailable'), 503);
    }
    if (!validated) return c.json(deny('unauthenticated', 'Authentication required'), 401);

    const user = await services.store.getUser(validated.record.user_id);
    if (!user) return c.json(deny('unauthenticated', 'Authentication required'), 401);
    // A `restricted` account (WS-J `restrict` sanction) may authenticate and
    // READ + self-serve (profile, data-rights, appeals, block/mute, notices);
    // its public-contribution attempts are denied at the write routes (403
    // `account_restricted`), not here.  `suspended`/`deleted`/non-grace
    // `deactivated` are denied outright.
    if (user.accountState !== 'active' && user.accountState !== 'restricted') {
      // A deactivated account in its deletion grace period may reach ONLY the
      // deletion cancel/status routes (so a no-email account can still cancel).
      const inGrace =
        opts.allowDeletionPending &&
        user.accountState === 'deactivated' &&
        (await services.store.getDeletion(user.userId))?.state === 'grace_period';
      if (!inGrace) {
        return c.json(deny(`account_${user.accountState}`, 'Account is not active'), 403);
      }
    }

    const inv = await authMethodInventory(services, user.userId);
    const auth = await services.store.getAuth(user.userId);
    c.set('auth', {
      userId: user.userId,
      accountState: user.accountState,
      roles: user.roles,
      stewardRoles: user.stewardRoles,
      authMethod: validated.record.auth_method,
      authAssurance: validated.record.auth_assurance,
      emailVerified: auth?.emailVerified ?? false,
      accountVerified: hasVerifiedCredential(inv),
      ageBand: user.ageBand,
      mfaActive: auth?.mfaEnabled ?? false,
      mfaVerified: validated.record.mfa_verified,
      tokenHash: validated.tokenHash,
    });

    await touchSession(services.sessions, validated.tokenHash);
    await next();
    return;
  };
}

/** Read the attached AuthContext (assumes authMiddleware ran). */
export function getAuth(c: {
  get: (k: 'auth') => AuthContext | undefined;
}): AuthContext | undefined {
  return c.get('auth');
}

/** Require any verified credential — passkey/wallet/verified email (WS-D.1.6a). */
export function requireVerifiedAccount(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const auth = c.get('auth');
    if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
    if (!auth.accountVerified) {
      return c.json(deny('verification_required', 'Verify your account to continue'), 403);
    }
    await next();
    return;
  };
}

/** Deny a `restricted` account from creating PUBLIC content (the WS-J `restrict`
 *  sanction): a restricted user may authenticate, read, and self-serve (profile,
 *  data-rights, appeals, block/mute, notices), but not publicly contribute.
 *  Apply to every public-content-creating route (contributions, stories,
 *  summaries, evidence).  Non-restricted accounts pass through. */
export function requireUnrestricted(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const auth = c.get('auth');
    if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
    if (auth.accountState === 'restricted') {
      return c.json(deny('account_restricted', 'Your account is restricted from posting'), 403);
    }
    await next();
    return;
  };
}

/** Whether the session's assurance is stale and a fresh step-up is required. */
export function assuranceStale(assurance: AuthAssurance, now: number = Date.now()): boolean {
  return now - Date.parse(assurance.last_verified_at) > SESSION_POLICY.stepUpWindowMs;
}

/** Require a fresh step-up assertion for sensitive actions (WS-D.1.3e). */
export function requireStepUp(now: () => number = Date.now): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const auth = c.get('auth');
    if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
    if (assuranceStale(auth.authAssurance, now())) {
      return c.json(
        {
          status: 'step_up_required' as const,
          methods: ['webauthn', 'email_otp', 'wallet'] as const,
        },
        401,
      );
    }
    await next();
    return;
  };
}

/** Require an active steward/admin role AND active MFA (WS-D.1.5b / D.1.6b). */
export function requireSteward(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const auth = c.get('auth');
    if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
    if (!isSteward(auth.roles)) {
      await denyAudit(auth.userId);
      return c.json(deny('forbidden', 'Steward role required'), 403);
    }
    // Reduced-assurance-until-MFA: a steward session must have cleared TOTP
    // (mfaVerified), not merely have MFA enrolled on the account (WS-D.1.5b).
    if (!auth.mfaActive || !auth.mfaVerified) {
      return c.json(deny('mfa_required', 'Verify MFA to perform steward actions'), 403);
    }
    await next();
    return;
  };
}

/**
 * Require AI-team membership (the `ai.model.manage` capability) AND active MFA
 * (WS-K.1.1b). The deployment-gated registry writes — register/version/
 * deprecate — are restricted to the AI team; model-card LOOKUP stays open to
 * any authenticated user and uses `authMiddleware()` alone.
 */
export function requireAiTeam(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const auth = c.get('auth');
    if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
    if (!isAiTeam(auth.roles)) {
      await denyAudit(auth.userId);
      return c.json(deny('forbidden', 'AI-team role required'), 403);
    }
    if (!auth.mfaActive || !auth.mfaVerified) {
      return c.json(deny('mfa_required', 'Verify MFA to manage AI models'), 403);
    }
    await next();
    return;
  };
}

/** Best-effort audit of a denied authorization attempt (WS-D.1.6b/6c). */
async function denyAudit(actorUserId: string): Promise<void> {
  try {
    const { getIdentityServices } = await import('../identity/services.js');
    await getIdentityServices().audit.append({
      actorUserId,
      eventType: 'authz_denied',
      context: {},
    });
  } catch {
    // Auditing must never block the deny path.
  }
}

/** Require a confirmed adult.  Fails closed on teen OR unknown age (WS-D.1.7c). */
export function requireAdult(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const auth = c.get('auth');
    if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
    if (auth.ageBand !== 'adult') {
      return c.json(deny('adult_required', 'This feature is not available'), 403);
    }
    await next();
    return;
  };
}
