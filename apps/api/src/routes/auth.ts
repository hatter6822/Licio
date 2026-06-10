// SPDX-License-Identifier: AGPL-3.0-or-later
//
// /v1/auth/* — the WS-D authentication surface.  WebAuthn-first, passwordless
// always: passkey registration/authentication, email one-time-code login, and
// adult-only Sign-In with Ethereum.  No password endpoint exists, and there is no
// password-reset route (recovery is "sign in with a remaining enrolled method",
// WS-D.1.4d).
import { randomUUID } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import {
  authSessionResultSchema,
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  deriveAgeBand,
  emailRegisterRequestSchema,
  emailStartRequestSchema,
  emailVerifyRequestSchema,
  emptyReputationSummary,
  isMinorBand,
  securityActivityResponseSchema,
  sessionListResponseSchema,
  siweVerifyRequestSchema,
  teenFloorPrivacySettings,
  webauthnAuthenticateVerifyRequestSchema,
  webauthnRegisterVerifyRequestSchema,
} from '@licio/shared';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { Hono } from 'hono';
import { z } from 'zod';
import { accountRef, sessionRef as deriveSessionRef } from '../identity/crypto.js';
import { startEmailLogin, verifyEmailLogin } from '../identity/email-otp.js';
import { assessLogin, deviceProfile, sendSecurityAlert } from '../identity/security-alerts.js';
import { getIdentityServices, hashIp, type IdentityServices } from '../identity/services.js';
import {
  buildSessionCookie,
  clearSessionCookie,
  createSession,
  readSessionToken,
  revokeOthersForUser,
  sessionSummaries,
  validateSession,
} from '../identity/sessions.js';
import { hashAuthWalletAddress, issueSiweNonce, verifySiwe } from '../identity/siwe.js';
import {
  createAuthenticationOptions,
  createRegistrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from '../identity/webauthn.js';
import { type AuthEnv, authMiddleware, requireStepUp } from '../middleware/auth.js';

const ATTEMPT_COOKIE = '__Host-otp';

const attemptCookie = (id: string): string =>
  `${ATTEMPT_COOKIE}=${id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=600`;
const clearAttemptCookie = (): string =>
  `${ATTEMPT_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
const readAttempt = (cookie: string | undefined): string | undefined =>
  cookie?.match(/(?:^|;\s*)__Host-otp=([^;]+)/)?.[1];

// The client IP is used ONLY transiently as a rate-limit counter key (hashed by
// the limiter); it is NEVER stored in a session, audit entry, or log (§19.1).
const clientIp = (c: { req: { header: (k: string) => string | undefined } }): string =>
  c.req.header('x-forwarded-for') ?? 'unknown';

/**
 * Create a session on successful auth, raising a NEW-DEVICE alert if warranted.
 * Per the privacy amendment (§19.1) no IP and no location are recorded — only a
 * coarse device descriptor derived from the user-agent.
 */
async function finalizeLogin(
  services: IdentityServices,
  c: { req: { header: (k: string) => string | undefined } },
  params: {
    userId: string;
    authMethod: 'webauthn' | 'email_otp' | 'wallet';
    credentialRef: string | null;
    rememberMe: boolean;
    mfaVerified?: boolean;
  },
) {
  const profile = deviceProfile(c.req.header('user-agent') ?? '');

  // History is the device descriptors of the user's OTHER active sessions.
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

/**
 * The canonical per-account rate-limit key (WS-D.1.3d): keyed by the resolved
 * user id so failures across rotating attempt-ids accumulate and a success on the
 * same account resets them.  Returned hashed (no plaintext id in the keyspace).
 */
function accountRefForUser(services: IdentityServices, userId: string): string {
  return accountRef(services.config.masterSecret, `user:${userId}`);
}

export function createAuthRoutes(resolve: () => IdentityServices = getIdentityServices) {
  return (
    new Hono<AuthEnv>()
      // --- Session status (replaces the WS-C stub) --------------------------
      .get('/status', async (c) => {
        const services = resolve();
        const token = readSessionToken(c.req.header('cookie'));
        if (!token) return c.json({ authenticated: false as const });
        const validated = await validateSession(services.sessions, token);
        if (!validated) return c.json({ authenticated: false as const });
        const user = services.store.getUser(validated.record.user_id);
        if (user?.accountState !== 'active') return c.json({ authenticated: false as const });
        return c.json({
          authenticated: true as const,
          user: {
            id: user.userId,
            handle: user.handle,
            display_name: user.displayName,
            account_state:
              user.accountState === 'active' ? ('active' as const) : ('suspended' as const),
            locale: user.locale ?? 'en-US',
          },
        });
      })

      // --- Passwordless email registration (age-gated) ----------------------
      .post('/register', zValidator('json', emailRegisterRequestSchema), async (c) => {
        const services = resolve();
        const body = c.req.valid('json');
        const gate = deriveAgeBand(body.date_of_birth);
        if (!gate.allowed) {
          // Under-13 is a hard block; no user row is created (WS-D.1.7a).
          return c.json(
            { error: { code: 'age_restricted', message: 'We are unable to create an account.' } },
            403,
          );
        }

        // Anti-enumeration: a duplicate email returns the same generic response and
        // notifies the existing owner instead of creating a second account.
        const existing = services.store.getUserByEmail(body.email);
        if (existing) {
          await services.mailer.sendNotice(body.email, 'duplicate_registration');
          return c.json({ age_band: gate.band });
        }
        if (services.store.getUserByHandle(body.handle)) {
          return c.json(
            { error: { code: 'handle_taken', message: 'That handle is unavailable.' } },
            409,
          );
        }

        const teen = isMinorBand(gate.band);
        const user = services.store.createUser({
          handle: body.handle,
          displayName: body.display_name,
          email: body.email,
          accountState: 'active',
          locale: null,
          ageBand: gate.band,
          privacySettings: teen ? teenFloorPrivacySettings() : defaultPrivacySettings(),
          personalizationSettings: defaultPersonalizationSettings(),
          reputationSummary: emptyReputationSummary(),
          roles: ['user'],
        });
        // Email-factor verification reuses the one-time-code primitive.
        const { code } = await startEmailLogin(services.otp, `verify:${user.userId}`, user.userId);
        await services.mailer.sendCode(body.email, code, 'verify');
        return c.json({ age_band: gate.band });
      })

      // --- Email one-time-code login (anti-enumeration) ---------------------
      .post('/email/start', zValidator('json', emailStartRequestSchema), async (c) => {
        const services = resolve();
        const { email } = c.req.valid('json');
        const ipHash = hashIp(services.config.masterSecret, clientIp(c));
        const acct = accountRef(services.config.masterSecret, email);

        const gate = await services.rateLimit.check(acct, ipHash);
        if (!gate.allowed) {
          c.header('Retry-After', String(gate.retryAfterSec));
          return c.json({ status: 'accepted' as const }, 202); // uniform body even when limited
        }

        const user = services.store.getUserByEmail(email);
        const attemptId = randomUUID();
        // Only mint+send a code for a real, email-verified account; otherwise the
        // response is identical (no enumeration), no code is sent.
        if (user && services.store.getAuth(user.userId)?.emailVerified) {
          const { code } = await startEmailLogin(services.otp, attemptId, user.userId);
          await services.mailer.sendCode(email, code, 'login');
        }
        c.header('Set-Cookie', attemptCookie(attemptId), { append: true });
        return c.json({ status: 'accepted' as const }, 202);
      })

      .post('/email/verify-login', zValidator('json', emailVerifyRequestSchema), async (c) => {
        const services = resolve();
        const { code } = c.req.valid('json');
        const attemptId = readAttempt(c.req.header('cookie'));
        if (!attemptId)
          return c.json(
            { error: { code: 'invalid_code', message: 'Invalid or expired code.' } },
            400,
          );

        const ipHash = hashIp(services.config.masterSecret, clientIp(c));
        const result = await verifyEmailLogin(services.otp, attemptId, code);
        if (!result.ok) {
          await services.rateLimit.recordFailure(`otp:${attemptId}`, ipHash);
          return c.json(
            { error: { code: 'invalid_code', message: 'Invalid or expired code.' } },
            400,
          );
        }
        const created = await finalizeLogin(services, c, {
          userId: result.userId,
          authMethod: 'email_otp',
          credentialRef: null,
          rememberMe: false,
        });
        c.header('Set-Cookie', clearAttemptCookie(), { append: true });
        c.header('Set-Cookie', buildSessionCookie(created.token, created.maxAgeSec), {
          append: true,
        });
        const user = services.store.getUser(result.userId);
        return c.json(
          authSessionResultSchema.parse({
            status: 'authenticated',
            user: publicUser(user),
          }),
        );
      })

      // --- WebAuthn authentication (passkey login) --------------------------
      .post('/webauthn/authenticate/options', async (c) => {
        const services = resolve();
        const attemptId = randomUUID();
        const options = await createAuthenticationOptions(
          services.challenges,
          services.config.webauthn,
          {
            challengeRef: attemptId,
          },
        );
        c.header('Set-Cookie', attemptCookie(attemptId), { append: true });
        return c.json(options);
      })

      .post(
        '/webauthn/authenticate/verify',
        zValidator('json', webauthnAuthenticateVerifyRequestSchema),
        async (c) => {
          const services = resolve();
          const attemptId = readAttempt(c.req.header('cookie'));
          if (!attemptId)
            return c.json(
              { error: { code: 'auth_failed', message: 'Authentication failed.' } },
              400,
            );
          const { response } = c.req.valid('json');
          const stored = services.store.getWebauthn(response.id);
          if (!stored)
            return c.json(
              { error: { code: 'auth_failed', message: 'Authentication failed.' } },
              400,
            );

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
              const user = services.store.getUser(stored.userId);
              await sendSecurityAlert({
                userId: stored.userId,
                hasEmail: !!user?.email,
                hasPush: false,
                audit: services.audit,
                event: { type: 'cloned_authenticator', authMethod: 'webauthn' },
              });
            }
            return c.json(
              { error: { code: 'auth_failed', message: 'Authentication failed.' } },
              400,
            );
          }
          services.store.addWebauthn({
            ...stored,
            counter: result.newCounter,
            lastUsedAt: new Date().toISOString(),
          });
          const created = await finalizeLogin(services, c, {
            userId: stored.userId,
            authMethod: 'webauthn',
            credentialRef: stored.credentialId,
            rememberMe: true,
          });
          c.header('Set-Cookie', clearAttemptCookie(), { append: true });
          c.header('Set-Cookie', buildSessionCookie(created.token, created.maxAgeSec), {
            append: true,
          });
          return c.json(
            authSessionResultSchema.parse({
              status: 'authenticated',
              user: publicUser(services.store.getUser(stored.userId)),
            }),
          );
        },
      )

      // --- WebAuthn registration (add a passkey; requires fresh step-up) -----
      .post('/webauthn/register/options', authMiddleware(resolve), requireStepUp(), async (c) => {
        const services = resolve();
        const auth = c.get('auth');
        if (!auth)
          return c.json(
            { error: { code: 'unauthenticated', message: 'Authentication required' } },
            401,
          );
        const user = services.store.getUser(auth.userId);
        const options = await createRegistrationOptions(
          services.challenges,
          services.config.webauthn,
          {
            userId: auth.userId,
            userName: user?.email ?? user?.handle ?? auth.userId,
            userDisplayName: user?.displayName ?? 'Licio user',
            existingCredentials: services.store
              .listWebauthn(auth.userId)
              .map((c2) => ({ id: c2.credentialId, transports: c2.transports as never })),
          },
        );
        return c.json(options);
      })

      .post(
        '/webauthn/register/verify',
        authMiddleware(resolve),
        requireStepUp(),
        zValidator('json', webauthnRegisterVerifyRequestSchema),
        async (c) => {
          const services = resolve();
          const auth = c.get('auth');
          if (!auth)
            return c.json(
              { error: { code: 'unauthenticated', message: 'Authentication required' } },
              401,
            );
          const { response, device_name } = c.req.valid('json');
          const result = await verifyRegistration(services.challenges, services.config.webauthn, {
            userId: auth.userId,
            response: response as RegistrationResponseJSON,
          });
          if (!result.ok)
            return c.json(
              { error: { code: 'registration_failed', message: 'Could not register passkey.' } },
              400,
            );
          services.store.addWebauthn({
            credentialId: result.credential.credentialId,
            userId: auth.userId,
            publicKey: result.credential.publicKey,
            counter: result.credential.counter,
            deviceType: result.credential.deviceType,
            deviceName: device_name ?? null,
            transports: result.credential.transports,
            backedUp: result.credential.backedUp,
            createdAt: new Date().toISOString(),
            lastUsedAt: null,
          });
          await services.audit.append({
            actorUserId: auth.userId,
            eventType: 'auth_method_add',
            context: { auth_method: 'webauthn' },
          });
          return c.json({ status: 'registered' as const });
        },
      )

      // --- Sign-In with Ethereum (adult-only) -------------------------------
      .post('/wallet/nonce', async (c) => {
        const services = resolve();
        const attemptId = randomUUID();
        const nonce = await issueSiweNonce(services.challenges, attemptId);
        c.header('Set-Cookie', attemptCookie(attemptId), { append: true });
        return c.json({ nonce: nonce.nonce, issued_at: nonce.issuedAt });
      })

      .post('/wallet/verify', zValidator('json', siweVerifyRequestSchema), async (c) => {
        const services = resolve();
        const attemptId = readAttempt(c.req.header('cookie'));
        if (!attemptId)
          return c.json({ error: { code: 'auth_failed', message: 'Authentication failed.' } }, 400);
        const body = c.req.valid('json');
        const result = await verifySiwe({
          store: services.challenges,
          attemptId,
          message: body.message,
          signature: body.signature,
          config: services.config.siwe,
        });
        if (!result.ok) {
          await services.rateLimit.recordFailure(
            `siwe:${attemptId}`,
            hashIp(services.config.masterSecret, clientIp(c)),
          );
          return c.json({ error: { code: 'auth_failed', message: 'Authentication failed.' } }, 400);
        }
        const addressHash = hashAuthWalletAddress(
          services.config.masterSecret,
          result.addressLower,
        );
        const existing = services.store.findWalletAuthByHash(addressHash);
        if (!existing) {
          // New wallet signup is ADULT-ONLY and requires profile fields.
          if (!body.handle || !body.display_name || !body.date_of_birth) {
            return c.json(
              { error: { code: 'signup_required', message: 'Additional details required.' } },
              400,
            );
          }
          const gate = deriveAgeBand(body.date_of_birth);
          if (!gate.allowed || isMinorBand(gate.band)) {
            return c.json(
              { error: { code: 'adult_required', message: 'Wallet sign-in is adults only.' } },
              403,
            );
          }
          const user = services.store.createUser({
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
          services.store.addWalletAuth({
            credentialId: randomUUID(),
            userId: user.userId,
            addressHash,
            addressTruncated: result.addressTruncated,
            chainId: result.chainId,
            walletType: result.walletType,
            createdAt: new Date().toISOString(),
            lastUsedAt: null,
          });
          const created = await finalizeLogin(services, c, {
            userId: user.userId,
            authMethod: 'wallet',
            credentialRef: addressHash,
            rememberMe: true,
          });
          c.header('Set-Cookie', clearAttemptCookie(), { append: true });
          c.header('Set-Cookie', buildSessionCookie(created.token, created.maxAgeSec), {
            append: true,
          });
          return c.json(
            authSessionResultSchema.parse({ status: 'authenticated', user: publicUser(user) }),
          );
        }
        const created = await finalizeLogin(services, c, {
          userId: existing.userId,
          authMethod: 'wallet',
          credentialRef: addressHash,
          rememberMe: true,
        });
        c.header('Set-Cookie', clearAttemptCookie(), { append: true });
        c.header('Set-Cookie', buildSessionCookie(created.token, created.maxAgeSec), {
          append: true,
        });
        return c.json(
          authSessionResultSchema.parse({
            status: 'authenticated',
            user: publicUser(services.store.getUser(existing.userId)),
          }),
        );
      })

      // --- Active sessions (object-level authz) -----------------------------
      .get('/sessions', authMiddleware(resolve), async (c) => {
        const services = resolve();
        const auth = c.get('auth');
        if (!auth)
          return c.json(
            { error: { code: 'unauthenticated', message: 'Authentication required' } },
            401,
          );
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
          if (!auth)
            return c.json(
              { error: { code: 'unauthenticated', message: 'Authentication required' } },
              401,
            );
          const { ref } = c.req.valid('param');
          // Resolve the ref to one of THIS user's sessions; cross-user → 404 (no oracle).
          const sessions = await services.sessions.listForUser(auth.userId);
          const target = sessions.find(
            (s) => deriveSessionRef(services.config.masterSecret, s.tokenHash) === ref,
          );
          if (!target)
            return c.json({ error: { code: 'not_found', message: 'Session not found.' } }, 404);
          await services.sessions.delete(target.tokenHash);
          await services.audit.append({
            actorUserId: auth.userId,
            eventType: 'session_revoke',
            context: {},
          });
          if (target.tokenHash === auth.tokenHash)
            c.header('Set-Cookie', clearSessionCookie(), { append: true });
          return c.json({ ok: true });
        },
      )

      .post('/sessions/revoke-others', authMiddleware(resolve), async (c) => {
        const services = resolve();
        const auth = c.get('auth');
        if (!auth)
          return c.json(
            { error: { code: 'unauthenticated', message: 'Authentication required' } },
            401,
          );
        const revoked = await revokeOthersForUser(services.sessions, auth.userId, auth.tokenHash);
        return c.json({ ok: true, revoked });
      })

      // --- Recent security activity (owner-only) ----------------------------
      .get('/security-activity', authMiddleware(resolve), async (c) => {
        const services = resolve();
        const auth = c.get('auth');
        if (!auth)
          return c.json(
            { error: { code: 'unauthenticated', message: 'Authentication required' } },
            401,
          );
        const activity = await services.audit.securityActivityForUser(auth.userId);
        return c.json(securityActivityResponseSchema.parse({ activity }));
      })
  );
}

interface PublicUserInput {
  userId: string;
  handle: string;
  displayName: string;
  accountState: 'active' | 'suspended' | 'deactivated' | 'deleted';
  locale: string | null;
  createdAt: string;
}

function publicUser(user: PublicUserInput | null) {
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

export type AuthRoutes = ReturnType<typeof createAuthRoutes>;
