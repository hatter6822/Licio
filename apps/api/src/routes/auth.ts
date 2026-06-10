// SPDX-License-Identifier: AGPL-3.0-or-later
//
// /v1/auth/* — the WS-D authentication surface.  WebAuthn-first, passwordless
// always: passkey + email one-time-code + adult-only Sign-In with Ethereum.  No
// password endpoint exists, and there is no password-reset route (recovery is
// "sign in with a remaining enrolled method", WS-D.1.4d).
//
// This module owns LOGIN + session management; registration (incl. passkey-first
// signup) is in `auth-register.ts`, credential management + step-up in
// `auth-credentials.ts`, and steward MFA in `auth-mfa.ts` — all composed below.

import { randomUUID } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import {
  authSessionResultSchema,
  authStatusResponseSchema,
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  deriveAgeBand,
  emailStartRequestSchema,
  emailVerifyRequestSchema,
  emptyReputationSummary,
  isMinorBand,
  securityActivityResponseSchema,
  sessionListResponseSchema,
  siweVerifyRequestSchema,
  webauthnAuthenticateVerifyRequestSchema,
} from '@licio/shared';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { Hono } from 'hono';
import { z } from 'zod';
import { generateOneTimeCode, hashOneTimeCode } from '../identity/codes.js';
import {
  canResend,
  peekEmailLoginUserId,
  startEmailLogin,
  verifyEmailLogin,
} from '../identity/email-otp.js';
import { getIdentityServices, type IdentityServices } from '../identity/services.js';
import {
  buildSessionCookie,
  clearSessionCookie,
  readSessionToken,
  revokeOthersForUser,
  sessionSummaries,
  validateSession,
} from '../identity/sessions.js';
import { hashAuthWalletAddress, issueSiweNonce, verifySiwe } from '../identity/siwe.js';
import { createAuthenticationOptions, verifyAuthentication } from '../identity/webauthn.js';
import { rateLimit } from '../lib/rate-limit.js';
import { type AuthEnv, authMiddleware } from '../middleware/auth.js';
import { createCredentialRoutes } from './auth-credentials.js';
import { createMfaRoutes } from './auth-mfa.js';
import { createRegisterRoutes } from './auth-register.js';
import {
  ATTEMPT_COOKIES,
  accountRefForEmail,
  accountRefForUser,
  accountRefForWallet,
  buildAttemptCookie,
  checkRateLimit,
  clearAttemptCookie,
  contractVerifierFor,
  deriveSessionRef,
  err,
  finalizeLogin,
  loginDenialResponse,
  publicUser,
  readAttempt,
  recordAuthFailure,
} from './auth-support.js';

function createLoginRoutes(resolve: () => IdentityServices) {
  // GLOBAL (identity-free) budget for the unauthenticated secret-minting
  // endpoints (codes, challenges, nonces): a pure per-process cost ceiling that
  // reads nothing about the requester — no IP, hashed or otherwise (§19.1).
  // Per-mailbox cooldowns + the per-account limiter do the targeted work;
  // connection-level flood fairness belongs to the edge.
  const mintLimit = rateLimit({ limit: 600, windowMs: 60_000 });
  return (
    new Hono<AuthEnv>()
      // --- Session status (parsed through the shared contract) --------------
      .get('/status', async (c) => {
        const services = resolve();
        const token = readSessionToken(c.req.header('cookie'));
        const unauth = authStatusResponseSchema.parse({ authenticated: false });
        if (!token) return c.json(unauth);
        const validated = await validateSession(services.sessions, token);
        if (!validated) return c.json(unauth);
        const user = await services.store.getUser(validated.record.user_id);
        if (user?.accountState !== 'active') return c.json(unauth);
        return c.json(
          authStatusResponseSchema.parse({
            authenticated: true,
            user: {
              id: user.userId,
              handle: user.handle,
              display_name: user.displayName,
              account_state: 'active',
              locale: user.locale ?? 'en-US',
            },
          }),
        );
      })

      // --- Email one-time-code login (anti-enumeration, rate-limited) --------
      .post('/email/start', mintLimit, zValidator('json', emailStartRequestSchema), async (c) => {
        const services = resolve();
        const { email } = c.req.valid('json');
        // Canonical per-account key by email (WS-D.1.3d).
        const accountKey = accountRefForEmail(services, email);
        const gate = await checkRateLimit(services, accountKey);
        if (!gate.allowed) {
          c.header('Retry-After', String(gate.retryAfterSec));
          return c.json({ status: 'accepted' as const }, 202);
        }

        // Per-mailbox issuance cooldown (60s), applied UNIFORMLY to existing and
        // non-existing accounts: a flood of starts cannot bomb a victim's inbox,
        // and the identical 202 keeps account existence unobservable.
        const sendable = await canResend(services.otp, `login:${accountKey}`);

        // Timing equalization: always do the code-hash work so the response time
        // does not reveal whether the account exists.
        hashOneTimeCode(generateOneTimeCode());

        const user = await services.store.getUserByEmail(email);
        const attemptId = randomUUID();
        // Send a login code to ANY account whose email matches — verified OR not.
        // Completing the code proves mailbox control and verifies the email on
        // success (below), so a signup that lost its session before verifying can
        // still recover instead of being permanently stranded.  Identical 202
        // either way keeps account existence unobservable.
        if (sendable && user) {
          const { code } = await startEmailLogin(services.otp, attemptId, user.userId);
          await services.mailer.sendCode(email, code, 'login');
        }
        c.header('Set-Cookie', buildAttemptCookie(ATTEMPT_COOKIES.emailLogin, attemptId), {
          append: true,
        });
        return c.json({ status: 'accepted' as const }, 202);
      })

      .post('/email/verify-login', zValidator('json', emailVerifyRequestSchema), async (c) => {
        const services = resolve();
        const { code } = c.req.valid('json');
        const attemptId = readAttempt(c.req.header('cookie'), ATTEMPT_COOKIES.emailLogin);
        if (!attemptId) return c.json(err('invalid_code', 'Invalid or expired code.'), 400);

        const userId = await peekEmailLoginUserId(services.otp, attemptId);
        const accountKey = userId ? accountRefForUser(services, userId) : null;
        if (accountKey) {
          const gate = await checkRateLimit(services, accountKey);
          if (!gate.allowed) {
            c.header('Retry-After', String(gate.retryAfterSec));
            return c.json(err('rate_limited', 'Too many attempts. Try again later.'), 429);
          }
        }

        const result = await verifyEmailLogin(services.otp, attemptId, code);
        if (!result.ok) {
          await recordAuthFailure(services, {
            accountKey,
            ...(userId ? { alertUserId: userId } : {}),
            authMethod: 'email_otp',
          });
          return c.json(err('invalid_code', 'Invalid or expired code.'), 400);
        }
        const fin = await finalizeLogin(services, c, {
          userId: result.userId,
          authMethod: 'email_otp',
          credentialRef: null,
          rememberMe: false,
        });
        if (!fin.ok) return c.json(loginDenialResponse(fin.code), 403);
        const created = fin.session;
        // Completing the OTP proves mailbox control: verify the email if it was
        // still unverified (the stranded-signup recovery path).
        if (!(await services.store.getAuth(result.userId))?.emailVerified) {
          await services.store.setAuth(result.userId, {
            emailVerified: true,
            emailVerifiedAt: new Date().toISOString(),
          });
        }
        c.header('Set-Cookie', clearAttemptCookie(ATTEMPT_COOKIES.emailLogin), { append: true });
        c.header('Set-Cookie', buildSessionCookie(created.token, created.maxAgeSec), {
          append: true,
        });
        return c.json(
          authSessionResultSchema.parse({
            status: 'authenticated',
            user: publicUser(await services.store.getUser(result.userId)),
          }),
        );
      })

      // --- WebAuthn passkey login -------------------------------------------
      .post('/webauthn/authenticate/options', mintLimit, async (c) => {
        const services = resolve();
        const attemptId = randomUUID();
        const options = await createAuthenticationOptions(
          services.challenges,
          services.config.webauthn,
          {
            challengeRef: attemptId,
          },
        );
        c.header('Set-Cookie', buildAttemptCookie(ATTEMPT_COOKIES.webauthnLogin, attemptId), {
          append: true,
        });
        return c.json(options);
      })

      .post(
        '/webauthn/authenticate/verify',
        zValidator('json', webauthnAuthenticateVerifyRequestSchema),
        async (c) => {
          const services = resolve();
          const attemptId = readAttempt(c.req.header('cookie'), ATTEMPT_COOKIES.webauthnLogin);
          if (!attemptId) return c.json(err('auth_failed', 'Authentication failed.'), 400);
          const { response } = c.req.valid('json');
          const stored = await services.store.getWebauthn(response.id);
          const userId = stored?.userId;
          const accountKey = userId ? accountRefForUser(services, userId) : null;
          if (accountKey) {
            const gate = await checkRateLimit(services, accountKey);
            if (!gate.allowed) {
              c.header('Retry-After', String(gate.retryAfterSec));
              return c.json(err('rate_limited', 'Too many attempts. Try again later.'), 429);
            }
          }
          if (!stored) {
            await recordAuthFailure(services, { accountKey: null, authMethod: 'webauthn' });
            return c.json(err('auth_failed', 'Authentication failed.'), 400);
          }

          const result = await verifyAuthentication(services.challenges, services.config.webauthn, {
            challengeRef: attemptId,
            response: response as AuthenticationResponseJSON,
            credential: {
              credentialId: stored.credentialId,
              publicKey: stored.publicKey,
              counter: stored.counter,
              transports: stored.transports as never,
            },
          });
          if (!result.ok) {
            if (result.reason === 'counter_regression') {
              const { sendSecurityAlert } = await import('../identity/security-alerts.js');
              const user = await services.store.getUser(stored.userId);
              await sendSecurityAlert({
                userId: stored.userId,
                hasEmail: !!user?.email,
                hasPush: false,
                audit: services.audit,
                event: { type: 'cloned_authenticator', authMethod: 'webauthn' },
              });
            }
            await recordAuthFailure(services, {
              accountKey,
              ...(userId ? { alertUserId: userId } : {}),
              authMethod: 'webauthn',
            });
            return c.json(err('auth_failed', 'Authentication failed.'), 400);
          }
          await services.store.addWebauthn({
            ...stored,
            counter: result.newCounter,
            lastUsedAt: new Date().toISOString(),
          });
          const fin = await finalizeLogin(services, c, {
            userId: stored.userId,
            authMethod: 'webauthn',
            credentialRef: stored.credentialId,
            rememberMe: true,
          });
          if (!fin.ok) return c.json(loginDenialResponse(fin.code), 403);
          const created = fin.session;
          c.header('Set-Cookie', clearAttemptCookie(ATTEMPT_COOKIES.webauthnLogin), {
            append: true,
          });
          c.header('Set-Cookie', buildSessionCookie(created.token, created.maxAgeSec), {
            append: true,
          });
          return c.json(
            authSessionResultSchema.parse({
              status: 'authenticated',
              user: publicUser(await services.store.getUser(stored.userId)),
            }),
          );
        },
      )

      // --- Sign-In with Ethereum (adult-only; EOA + contract wallets) -------
      .post('/wallet/nonce', mintLimit, async (c) => {
        const services = resolve();
        const attemptId = randomUUID();
        const nonce = await issueSiweNonce(services.challenges, attemptId);
        c.header('Set-Cookie', buildAttemptCookie(ATTEMPT_COOKIES.walletLogin, attemptId), {
          append: true,
        });
        return c.json({ nonce: nonce.nonce, issued_at: nonce.issuedAt });
      })

      .post('/wallet/verify', zValidator('json', siweVerifyRequestSchema), async (c) => {
        const services = resolve();
        const attemptId = readAttempt(c.req.header('cookie'), ATTEMPT_COOKIES.walletLogin);
        if (!attemptId) return c.json(err('auth_failed', 'Authentication failed.'), 400);
        const body = c.req.valid('json');
        const contractVerifier = contractVerifierFor(services);
        const result = await verifySiwe({
          store: services.challenges,
          attemptId,
          message: body.message,
          signature: body.signature,
          config: services.config.siwe,
          ...(contractVerifier ? { contractVerifier } : {}),
        });
        if (!result.ok) {
          // An invalid signature is unattributable ⇒ null account key (IP only).
          await recordAuthFailure(services, { accountKey: null, authMethod: 'wallet' });
          return c.json(err('auth_failed', 'Authentication failed.'), 400);
        }
        const addressHash = hashAuthWalletAddress(
          services.config.masterSecret,
          result.addressLower,
        );
        const existing = await services.store.findWalletAuthByHash(addressHash);

        if (existing) {
          const gate = await checkRateLimit(services, accountRefForWallet(services, addressHash));
          if (!gate.allowed) {
            c.header('Retry-After', String(gate.retryAfterSec));
            return c.json(err('rate_limited', 'Too many attempts. Try again later.'), 429);
          }
          const fin = await finalizeLogin(services, c, {
            userId: existing.userId,
            authMethod: 'wallet',
            credentialRef: addressHash,
            rememberMe: true,
          });
          if (!fin.ok) return c.json(loginDenialResponse(fin.code), 403);
          const created = fin.session;
          c.header('Set-Cookie', clearAttemptCookie(ATTEMPT_COOKIES.walletLogin), { append: true });
          c.header('Set-Cookie', buildSessionCookie(created.token, created.maxAgeSec), {
            append: true,
          });
          return c.json(
            authSessionResultSchema.parse({
              status: 'authenticated',
              user: publicUser(await services.store.getUser(existing.userId)),
            }),
          );
        }

        // New wallet signup is ADULT-ONLY and requires profile fields.
        if (!body.handle || !body.display_name || !body.date_of_birth) {
          return c.json(err('signup_required', 'Additional details required.'), 400);
        }
        const gate = deriveAgeBand(body.date_of_birth);
        if (!gate.allowed || isMinorBand(gate.band)) {
          return c.json(err('adult_required', 'Wallet sign-in is adults only.'), 403);
        }
        if (await services.store.getUserByHandle(body.handle)) {
          return c.json(err('handle_taken', 'That handle is unavailable.'), 409);
        }
        const user = await services.store.createUser({
          handle: body.handle,
          displayName: body.display_name,
          email: null,
          accountState: 'active',
          locale: null,
          ageBand: 'adult',
          privacySettings: defaultPrivacySettings(),
          personalizationSettings: defaultPersonalizationSettings(),
          reputationSummary: emptyReputationSummary(),
          roles: ['user'],
        });
        await services.store.addWalletAuth({
          credentialId: randomUUID(),
          userId: user.userId,
          addressHash,
          addressTruncated: result.addressTruncated,
          chainId: result.chainId,
          walletType: result.walletType,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
        });
        await services.audit.append({
          actorUserId: user.userId,
          eventType: 'auth_method_add',
          context: { auth_method: 'wallet' },
        });
        const fin = await finalizeLogin(services, c, {
          userId: user.userId,
          authMethod: 'wallet',
          credentialRef: addressHash,
          rememberMe: true,
        });
        if (!fin.ok) return c.json(loginDenialResponse(fin.code), 403);
        const created = fin.session;
        c.header('Set-Cookie', clearAttemptCookie(ATTEMPT_COOKIES.walletLogin), { append: true });
        c.header('Set-Cookie', buildSessionCookie(created.token, created.maxAgeSec), {
          append: true,
        });
        return c.json(
          authSessionResultSchema.parse({ status: 'authenticated', user: publicUser(user) }),
        );
      })

      // --- Active sessions (object-level authz) -----------------------------
      .get('/sessions', authMiddleware(resolve), async (c) => {
        const services = resolve();
        const auth = c.get('auth');
        if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
        const summaries = await sessionSummaries(
          services.sessions,
          auth.userId,
          auth.tokenHash,
          services.config.masterSecret,
        );
        return c.json(sessionListResponseSchema.parse({ sessions: summaries }));
      })

      .delete(
        '/sessions/:ref',
        authMiddleware(resolve),
        zValidator('param', z.object({ ref: z.string().min(1) })),
        async (c) => {
          const services = resolve();
          const auth = c.get('auth');
          if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
          const { ref } = c.req.valid('param');
          const sessions = await services.sessions.listForUser(auth.userId);
          const target = sessions.find(
            (s) => deriveSessionRef(services.config.masterSecret, s.tokenHash) === ref,
          );
          if (!target) return c.json(err('not_found', 'Session not found.'), 404);
          await services.sessions.delete(target.tokenHash);
          await services.audit.append({
            actorUserId: auth.userId,
            eventType: 'session_revoke',
            context: {},
          });
          if (target.tokenHash === auth.tokenHash) {
            c.header('Set-Cookie', clearSessionCookie(), { append: true });
          }
          return c.json({ ok: true });
        },
      )

      .post('/sessions/revoke-others', authMiddleware(resolve), async (c) => {
        const services = resolve();
        const auth = c.get('auth');
        if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
        const revoked = await revokeOthersForUser(services.sessions, auth.userId, auth.tokenHash);
        return c.json({ ok: true, revoked });
      })

      // --- Recent security activity (owner-only) ----------------------------
      .get('/security-activity', authMiddleware(resolve), async (c) => {
        const services = resolve();
        const auth = c.get('auth');
        if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
        const activity = await services.audit.securityActivityForUser(auth.userId);
        return c.json(securityActivityResponseSchema.parse({ activity }));
      })
  );
}

export function createAuthRoutes(resolve: () => IdentityServices = getIdentityServices) {
  return new Hono<AuthEnv>()
    .route('/', createLoginRoutes(resolve))
    .route('/', createRegisterRoutes(resolve))
    .route('/', createCredentialRoutes(resolve))
    .route('/', createMfaRoutes(resolve));
}

export type AuthRoutes = ReturnType<typeof createAuthRoutes>;
