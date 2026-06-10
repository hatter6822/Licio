// SPDX-License-Identifier: AGPL-3.0-or-later
//
// /v1/auth registration surface (WS-D.1.4a, WS-D.1.2): passkey-FIRST signup (the
// primary path — a passkey-only account with no email), email registration, and
// the email-factor verify/resend/add flows that let a registered or passkey-only
// account confirm or attach an email.  Passwordless throughout.
import { randomUUID } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import {
  authSessionResultSchema,
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  deriveAgeBand,
  emailRegisterRequestSchema,
  emailSchema,
  emptyReputationSummary,
  handleSchema,
  isMinorBand,
  registeredAgeBandSchema,
  teenFloorPrivacySettings,
  webauthnRegisterVerifyRequestSchema,
} from '@licio/shared';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { Hono } from 'hono';
import { z } from 'zod';
import { canResend, startEmailVerification, verifyEmailFactor } from '../identity/email-otp.js';
import type { IdentityServices } from '../identity/services.js';
import { buildSessionCookie, readSessionToken, rotateSession } from '../identity/sessions.js';
import { createRegistrationOptions, verifyRegistration } from '../identity/webauthn.js';
import { type AuthEnv, authMiddleware, requireStepUp } from '../middleware/auth.js';
import {
  ATTEMPT_COOKIES,
  buildAttemptCookie,
  clearAttemptCookie,
  err,
  finalizeLogin,
  publicUser,
  readAttempt,
} from './auth-support.js';

const PENDING_SIGNUP_TTL_MS = 5 * 60_000;
const pendingKey = (attemptId: string) => `pksignup:${attemptId}`;

const passkeySignupRequestSchema = z
  .object({
    handle: handleSchema,
    display_name: z.string().min(1).max(80),
    date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

const emailAddRequestSchema = z.object({ email: emailSchema }).strict();

interface PendingSignup {
  handle: string;
  displayName: string;
  ageBand: 'adult' | 'teen_16_17' | 'teen_13_15';
}

export function createRegisterRoutes(resolve: () => IdentityServices) {
  return (
    new Hono<AuthEnv>()
      // --- Passkey-FIRST signup (WebAuthn primary) --------------------------
      .post(
        '/webauthn/signup/options',
        zValidator('json', passkeySignupRequestSchema),
        async (c) => {
          const services = resolve();
          const body = c.req.valid('json');
          const gate = deriveAgeBand(body.date_of_birth);
          if (!gate.allowed) {
            return c.json(err('age_restricted', 'We are unable to create an account.'), 403);
          }
          if (services.store.getUserByHandle(body.handle)) {
            return c.json(err('handle_taken', 'That handle is unavailable.'), 409);
          }
          // A temporary id binds the WebAuthn challenge to this signup attempt; the
          // real user row is created only on a verified attestation.
          const attemptId = randomUUID();
          const pending: PendingSignup = {
            handle: body.handle,
            displayName: body.display_name,
            ageBand: gate.band,
          };
          await services.challenges.set(
            pendingKey(attemptId),
            JSON.stringify(pending),
            PENDING_SIGNUP_TTL_MS,
          );
          const options = await createRegistrationOptions(
            services.challenges,
            services.config.webauthn,
            {
              userId: attemptId,
              userName: body.handle,
              userDisplayName: body.display_name,
              existingCredentials: [],
            },
          );
          c.header('Set-Cookie', buildAttemptCookie(ATTEMPT_COOKIES.passkeySignup, attemptId), {
            append: true,
          });
          return c.json(options);
        },
      )

      .post(
        '/webauthn/signup/verify',
        zValidator('json', webauthnRegisterVerifyRequestSchema),
        async (c) => {
          const services = resolve();
          const attemptId = readAttempt(c.req.header('cookie'), ATTEMPT_COOKIES.passkeySignup);
          if (!attemptId)
            return c.json(err('registration_failed', 'Could not register passkey.'), 400);
          const rawPending = await services.challenges.take(pendingKey(attemptId));
          if (!rawPending) return c.json(err('registration_failed', 'Signup expired.'), 400);
          const pending = JSON.parse(rawPending) as PendingSignup;
          if (services.store.getUserByHandle(pending.handle)) {
            return c.json(err('handle_taken', 'That handle is unavailable.'), 409);
          }

          const { response, device_name } = c.req.valid('json');
          const result = await verifyRegistration(services.challenges, services.config.webauthn, {
            userId: attemptId,
            response: response as RegistrationResponseJSON,
          });
          if (!result.ok)
            return c.json(err('registration_failed', 'Could not register passkey.'), 400);

          const teen = isMinorBand(pending.ageBand);
          const user = services.store.createUser({
            handle: pending.handle,
            displayName: pending.displayName,
            email: null,
            accountState: 'active',
            locale: null,
            ageBand: pending.ageBand,
            privacySettings: teen ? teenFloorPrivacySettings() : defaultPrivacySettings(),
            personalizationSettings: defaultPersonalizationSettings(),
            reputationSummary: emptyReputationSummary(),
            roles: ['user'],
          });
          services.store.addWebauthn({
            credentialId: result.credential.credentialId,
            userId: user.userId,
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
            actorUserId: user.userId,
            eventType: 'auth_method_add',
            context: { auth_method: 'webauthn' },
          });
          const created = await finalizeLogin(services, c, {
            userId: user.userId,
            authMethod: 'webauthn',
            credentialRef: result.credential.credentialId,
            rememberMe: true,
          });
          c.header('Set-Cookie', clearAttemptCookie(ATTEMPT_COOKIES.passkeySignup), {
            append: true,
          });
          c.header('Set-Cookie', buildSessionCookie(created.token, created.maxAgeSec), {
            append: true,
          });
          return c.json(
            authSessionResultSchema.parse({ status: 'authenticated', user: publicUser(user) }),
          );
        },
      )

      // --- Passwordless email registration (age-gated; logs in, reduced cap) -
      .post('/register', zValidator('json', emailRegisterRequestSchema), async (c) => {
        const services = resolve();
        const body = c.req.valid('json');
        const gate = deriveAgeBand(body.date_of_birth);
        if (!gate.allowed) {
          return c.json(err('age_restricted', 'We are unable to create an account.'), 403);
        }
        // Anti-enumeration: a duplicate email returns the same generic response and
        // notifies the existing owner instead of creating a second account.
        if (services.store.getUserByEmail(body.email)) {
          await services.mailer.sendNotice(body.email, 'duplicate_registration');
          return c.json(registeredAgeBandSchema.parse({ age_band: gate.band }));
        }
        if (services.store.getUserByHandle(body.handle)) {
          return c.json(err('handle_taken', 'That handle is unavailable.'), 409);
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
        const { code } = await startEmailVerification(services.otp, user.userId);
        await services.mailer.sendCode(body.email, code, 'verify');
        // The account is active (reduced capability until the email is verified).
        const created = await finalizeLogin(services, c, {
          userId: user.userId,
          authMethod: 'email_otp',
          credentialRef: null,
          rememberMe: false,
        });
        c.header('Set-Cookie', buildSessionCookie(created.token, created.maxAgeSec), {
          append: true,
        });
        return c.json(registeredAgeBandSchema.parse({ age_band: gate.band }));
      })

      // --- Email factor verify / resend / add (authenticated) ---------------
      .post(
        '/email/verify',
        authMiddleware(resolve),
        zValidator('json', z.object({ code: z.string().trim().min(1) })),
        async (c) => {
          const services = resolve();
          const auth = c.get('auth');
          if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
          const result = await verifyEmailFactor(
            services.otp,
            auth.userId,
            c.req.valid('json').code,
          );
          if (!result.ok) return c.json(err('invalid_code', 'Invalid or expired code.'), 400);
          services.store.setAuth(auth.userId, {
            emailVerified: true,
            emailVerifiedAt: new Date().toISOString(),
          });
          await services.audit.append({
            actorUserId: auth.userId,
            eventType: 'auth_method_add',
            context: { auth_method: 'email_otp' },
          });
          // Privilege change ⇒ rotate the session id (WS-D.1.3e).
          const token = readSessionToken(c.req.header('cookie'));
          const rotated = token ? await rotateSession(services.sessions, token) : null;
          if (rotated) {
            c.header('Set-Cookie', buildSessionCookie(rotated.token, rotated.maxAgeSec), {
              append: true,
            });
          }
          return c.json({ status: 'verified' as const });
        },
      )

      .post('/email/resend', authMiddleware(resolve), async (c) => {
        const services = resolve();
        const auth = c.get('auth');
        if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
        const user = services.store.getUser(auth.userId);
        if (!user?.email || services.store.getAuth(auth.userId)?.emailVerified) {
          return c.json(err('not_applicable', 'No unverified email on file.'), 400);
        }
        const accountRef = `resend:${auth.userId}`;
        if (!(await canResend(services.otp, accountRef))) {
          return c.json(err('cooldown', 'Please wait before requesting another code.'), 429);
        }
        const { code } = await startEmailVerification(services.otp, auth.userId);
        await services.mailer.sendCode(user.email, code, 'verify');
        return c.json({ status: 'sent' as const });
      })

      .post(
        '/email/add',
        authMiddleware(resolve),
        requireStepUp(),
        zValidator('json', emailAddRequestSchema),
        async (c) => {
          const services = resolve();
          const auth = c.get('auth');
          if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
          const { email } = c.req.valid('json');
          // Generic response on a taken email (no enumeration); notify the owner.
          if (services.store.getUserByEmail(email)) {
            await services.mailer.sendNotice(email, 'duplicate_email_add');
            return c.json({ status: 'sent' as const });
          }
          services.store.updateUser(auth.userId, { email });
          services.store.setAuth(auth.userId, { emailVerified: false, emailVerifiedAt: null });
          const { code } = await startEmailVerification(services.otp, auth.userId);
          await services.mailer.sendCode(email, code, 'verify');
          return c.json({ status: 'sent' as const });
        },
      )
  );
}
