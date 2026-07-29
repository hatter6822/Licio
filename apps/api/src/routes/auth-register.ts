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
  handleSchema,
  isMinorBand,
  powCaptchaDisabledSchema,
  powSolutionSchema,
  registeredAgeBandSchema,
  teenFloorPrivacySettings,
  webauthnRegisterVerifyRequestSchema,
} from '@licio/shared';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { Hono } from 'hono';
import { z } from 'zod';
import { canResend, startEmailVerification, verifyEmailFactor } from '../identity/email-otp.js';
import {
  isPowCaptchaEnabled,
  issuePowChallenge,
  SignupPressure,
  verifyPowSolution,
} from '../identity/pow-captcha.js';
import type { IdentityServices } from '../identity/services.js';
import { buildSessionCookie, readSessionToken, rotateSession } from '../identity/sessions.js';
import { createRegistrationOptions, verifyRegistration } from '../identity/webauthn.js';
import { rateLimit } from '../lib/rate-limit.js';
import { type AuthEnv, authMiddleware, requireStepUp } from '../middleware/auth.js';
import {
  ATTEMPT_COOKIES,
  accountRefForEmail,
  buildAttemptCookie,
  clearAttemptCookie,
  deliverMail,
  err,
  finalizeLogin,
  loginDenialResponse,
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
    /** Solved sign-up proof-of-work (WS-D bot-prevention layer 1); required
     *  whenever the gate is enabled — checked before any store work. */
    captcha: powSolutionSchema.optional(),
  })
  .strict();

const emailAddRequestSchema = z.object({ email: emailSchema }).strict();

// The ephemeral store hands back an opaque string; validate the JSON on read
// so a corrupted/forged pending record cannot reach account creation via a bare
// cast.  The type is derived from the schema so the two never drift.
const pendingSignupSchema = z
  .object({
    handle: handleSchema,
    displayName: z.string().min(1).max(80),
    ageBand: z.enum(['adult', 'teen_16_17', 'teen_13_15']),
  })
  .strict();
type PendingSignup = z.infer<typeof pendingSignupSchema>;

export function createRegisterRoutes(resolve: () => IdentityServices) {
  // GLOBAL (identity-free) budget on unauthenticated ACCOUNT CREATION: bounds
  // signup spam per process without reading anything about the requester (§19.1).
  // The duplicate-email notice additionally sits under a per-mailbox cooldown.
  const signupLimit = rateLimit({ limit: 120, windowMs: 60_000 });
  // The cheap PUBLIC captcha mint gets its OWN budget, SEPARATE from the
  // account-creation redeems above: a header-less bot spamming /captcha/challenge
  // must not exhaust the shared budget and 429 legitimate /register or
  // /webauthn/signup/options (the redeem paths). A roomier mint budget absorbs
  // a genuine user's prime-ahead + one retry without self-starvation.
  const challengeMintLimit = rateLimit({ limit: 240, windowMs: 60_000 });
  // Bot-prevention layer 1: the sign-up proof-of-work gate.  Every account-
  // minting entry point below requires a solved, single-use challenge BEFORE
  // any store lookup or mail send, so bulk registration pays CPU per account.
  // Difficulty scales with process-wide issuance pressure (identity-free).
  const signupPressure = new SignupPressure();
  const requirePowCaptcha = async (
    services: IdentityServices,
    captcha: Parameters<typeof verifyPowSolution>[3],
  ) =>
    verifyPowSolution(
      services.challenges,
      services.config.masterSecret,
      services.config.signupPow,
      captcha,
    );
  return (
    new Hono<AuthEnv>()
      // --- Sign-up proof-of-work challenge (WS-D bot-prevention layer 1) ----
      // POST (not GET): issuance writes the single-use store, and the CSRF
      // middleware Origin-checks state-changing /v1/auth/* requests. When the
      // gate is DISABLED (SIGNUP_POW_MAX_NUMBER=0, the operator opt-out) this
      // issues NO puzzle and returns the disabled sentinel — the client then
      // attaches no captcha and the redeem endpoints verify it as a no-op.
      // (Issuing here would throw: max_number 0 fails the schema's `.positive()`.)
      .post('/captcha/challenge', challengeMintLimit, async (c) => {
        const services = resolve();
        if (!isPowCaptchaEnabled(services.config.signupPow)) {
          return c.json(powCaptchaDisabledSchema.parse({ disabled: true }));
        }
        const challenge = await issuePowChallenge(
          services.challenges,
          services.config.masterSecret,
          services.config.signupPow,
          { pressure: signupPressure },
        );
        // issuePowChallenge already returns a schema-validated PowChallenge.
        return c.json(challenge);
      })

      // --- Passkey-FIRST signup (WebAuthn primary) --------------------------
      .post(
        '/webauthn/signup/options',
        signupLimit,
        zValidator('json', passkeySignupRequestSchema),
        async (c) => {
          const services = resolve();
          const body = c.req.valid('json');
          // Proof-of-work FIRST: nothing downstream (store lookups, challenge
          // minting) is reachable without paying the per-account CPU cost.
          const pow = await requirePowCaptcha(services, body.captcha);
          if (!pow.ok) {
            return c.json(err(pow.code, 'Sign-up verification required.'), 403);
          }
          const gate = deriveAgeBand(body.date_of_birth);
          if (!gate.allowed) {
            return c.json(err('age_restricted', 'We are unable to create an account.'), 403);
          }
          if (await services.store.getUserByHandle(body.handle)) {
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
          let pending: PendingSignup;
          try {
            const parsed = pendingSignupSchema.safeParse(JSON.parse(rawPending));
            if (!parsed.success) return c.json(err('registration_failed', 'Signup expired.'), 400);
            pending = parsed.data;
          } catch {
            return c.json(err('registration_failed', 'Signup expired.'), 400);
          }
          if (await services.store.getUserByHandle(pending.handle)) {
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
          const user = await services.store.createUser({
            handle: pending.handle,
            displayName: pending.displayName,
            email: null,
            accountState: 'active',
            locale: null,
            ageBand: pending.ageBand,
            privacySettings: teen ? teenFloorPrivacySettings() : defaultPrivacySettings(),
            personalizationSettings: defaultPersonalizationSettings(),
            roles: ['user'],
          });
          await services.store.addWebauthn({
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
          const fin = await finalizeLogin(services, c, {
            userId: user.userId,
            authMethod: 'webauthn',
            credentialRef: result.credential.credentialId,
            rememberMe: true,
          });
          if (!fin.ok) return c.json(loginDenialResponse(fin.code), 403);
          const created = fin.session;
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
      .post('/register', signupLimit, zValidator('json', emailRegisterRequestSchema), async (c) => {
        const services = resolve();
        const body = c.req.valid('json');
        // Proof-of-work FIRST — before the duplicate-email branch, so the
        // anti-enumeration notice mail path also sits behind the CPU cost.
        const pow = await requirePowCaptcha(services, body.captcha);
        if (!pow.ok) {
          return c.json(err(pow.code, 'Sign-up verification required.'), 403);
        }
        const gate = deriveAgeBand(body.date_of_birth);
        if (!gate.allowed) {
          return c.json(err('age_restricted', 'We are unable to create an account.'), 403);
        }
        // Anti-enumeration: a duplicate email returns the same generic response and
        // notifies the existing owner instead of creating a second account.  The
        // notice is under the same per-mailbox cooldown as code issuance, so
        // repeated duplicate registrations cannot bomb the owner's inbox.  The
        // send is DETACHED (`deliverMail`) on this branch and on the new-account
        // branch below, so neither pays the SES round trip on the response path
        // and the two cannot be told apart by timing.
        if (await services.store.getUserByEmail(body.email)) {
          if (await canResend(services.otp, `notice:${accountRefForEmail(services, body.email)}`)) {
            deliverMail(
              services.mailer.sendNotice(body.email, 'duplicate_registration'),
              'duplicate_registration',
            );
          }
          return c.json(registeredAgeBandSchema.parse({ age_band: gate.band }));
        }
        if (await services.store.getUserByHandle(body.handle)) {
          return c.json(err('handle_taken', 'That handle is unavailable.'), 409);
        }
        const teen = isMinorBand(gate.band);
        const user = await services.store.createUser({
          handle: body.handle,
          displayName: body.display_name,
          email: body.email,
          accountState: 'active',
          locale: null,
          ageBand: gate.band,
          privacySettings: teen ? teenFloorPrivacySettings() : defaultPrivacySettings(),
          personalizationSettings: defaultPersonalizationSettings(),
          roles: ['user'],
        });
        const { code } = await startEmailVerification(services.otp, user.userId, body.email);
        // Detached: the user row is already committed, so an SES fault must not
        // 500 the request and strand a real account with no session — the user
        // is signed in below and can pull a fresh code from /email/resend.
        deliverMail(services.mailer.sendCode(body.email, code, 'verify'), 'register_verify');
        // The account is active (reduced capability until the email is verified).
        const fin = await finalizeLogin(services, c, {
          userId: user.userId,
          authMethod: 'email_otp',
          credentialRef: null,
          rememberMe: false,
        });
        if (!fin.ok) return c.json(loginDenialResponse(fin.code), 403);
        c.header('Set-Cookie', buildSessionCookie(fin.session.token, fin.session.maxAgeSec), {
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
          const now = new Date().toISOString();
          const pending = (await services.store.getAuth(auth.userId))?.pendingEmail ?? null;
          // The consumed code is bound to the address it was delivered to.  A
          // pending change is confirmed ONLY by a code sent to the pending
          // address; confirming the on-file email requires a code sent to it.
          // This blocks promoting a DIFFERENT address with a code that only
          // proved control of the current one (WS-D.1.4b).
          const confirmedAddress =
            pending ?? (await services.store.getUser(auth.userId))?.email ?? null;
          if (confirmedAddress === null || result.target !== confirmedAddress) {
            return c.json(err('invalid_code', 'Invalid or expired code.'), 400);
          }
          if (pending) {
            // Promote the staged address.  Re-check uniqueness at confirm time so a
            // concurrent claim of the same email can't be force-promoted past the
            // unique index (the in-memory store does not enforce it on write).
            if (await services.store.getUserByEmail(pending)) {
              await services.store.setAuth(auth.userId, { pendingEmail: null });
              return c.json(err('email_taken', 'That email is no longer available.'), 409);
            }
            await services.store.updateUser(auth.userId, { email: pending });
            await services.store.setAuth(auth.userId, {
              emailVerified: true,
              emailVerifiedAt: now,
              pendingEmail: null,
            });
          } else {
            await services.store.setAuth(auth.userId, {
              emailVerified: true,
              emailVerifiedAt: now,
            });
          }
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
        const user = await services.store.getUser(auth.userId);
        if (!user?.email || (await services.store.getAuth(auth.userId))?.emailVerified) {
          return c.json(err('not_applicable', 'No unverified email on file.'), 400);
        }
        const accountRef = `resend:${auth.userId}`;
        if (!(await canResend(services.otp, accountRef))) {
          return c.json(err('cooldown', 'Please wait before requesting another code.'), 429);
        }
        const { code } = await startEmailVerification(services.otp, auth.userId, user.email);
        // The cooldown above is the real bound; the send itself is best-effort
        // and off the response path (an SES fault must not 500 a resend the
        // caller would then have to wait out the cooldown to retry).
        deliverMail(services.mailer.sendCode(user.email, code, 'verify'), 'email_resend');
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
          // Generic response on a taken email (no enumeration); notify the owner —
          // under the per-mailbox cooldown so repeats cannot bomb their inbox.
          if (await services.store.getUserByEmail(email)) {
            if (await canResend(services.otp, `notice:${accountRefForEmail(services, email)}`)) {
              deliverMail(
                services.mailer.sendNotice(email, 'duplicate_email_add'),
                'duplicate_email_add',
              );
            }
            return c.json({ status: 'sent' as const });
          }
          // STAGE the new address as pending — do NOT touch the current (possibly
          // only) verified email until the new one proves control on /email/verify.
          // This keeps an email-only account from being stranded by a typo (the
          // last-verified-method invariant the removal endpoints already enforce).
          await services.store.setAuth(auth.userId, { pendingEmail: email });
          const { code } = await startEmailVerification(services.otp, auth.userId, email);
          // Detached like the taken-address branch above: the pending address is
          // already staged, so an SES fault must not 500 the request (which would
          // leave a staged pendingEmail behind a 500 the caller reads as failure).
          deliverMail(services.mailer.sendCode(email, code, 'verify'), 'email_add_verify');
          return c.json({ status: 'sent' as const });
        },
      )

      // --- DEVELOPMENT ONLY: become verified (NEVER in production) -----------
      // A freshly EMAIL-registered account is active but UNVERIFIED (reduced
      // capability, WS-D.1.6a): verified-only surfaces such as GET
      // /v1/privacy/settings answer 403 until the email is confirmed. In local
      // development the one-time code is only surfaced to the SERVER log, so
      // there is no in-browser way to clear that state and exercise the verified
      // capabilities. This dev-only shortcut flips the account to verified
      // WITHOUT the code, mirroring /email/verify (marks the email factor
      // verified, audits, rotates the session id on the privilege change).
      //
      // FAIL-CLOSED: the gate runs BEFORE auth and ALLOWLISTS only an explicit
      // development/test NODE_ENV. Production, a staging/preview environment, or an
      // UNSET NODE_ENV all read 404, so the route is indistinguishable from "not
      // found" on any deployed environment and can never be a verification bypass
      // (an allowlist, not merely "deny production"). The calling control is ALSO
      // gated to `import.meta.env.DEV` in the client (defense in depth).
      .post(
        '/dev/verify',
        async (c, next) => {
          const nodeEnv = process.env['NODE_ENV'];
          if (nodeEnv !== 'development' && nodeEnv !== 'test') {
            return c.json(err('not_found', 'Not found.'), 404);
          }
          await next();
          return;
        },
        authMiddleware(resolve),
        async (c) => {
          const services = resolve();
          const auth = c.get('auth');
          if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
          const user = await services.store.getUser(auth.userId);
          if (!user) return c.json(err('unauthenticated', 'Authentication required'), 401);
          // Only an email factor becomes verified this way; a passkey/wallet
          // account already holds a verified credential, so this is a no-op for it.
          if (user.email && !(await services.store.getAuth(auth.userId))?.emailVerified) {
            await services.store.setAuth(auth.userId, {
              emailVerified: true,
              emailVerifiedAt: new Date().toISOString(),
            });
            await services.audit.append({
              actorUserId: auth.userId,
              eventType: 'auth_method_add',
              context: { auth_method: 'email_otp', reason: 'dev_verify' },
            });
            // Privilege change ⇒ rotate the session id (mirrors /email/verify).
            const token = readSessionToken(c.req.header('cookie'));
            const rotated = token ? await rotateSession(services.sessions, token) : null;
            if (rotated) {
              c.header('Set-Cookie', buildSessionCookie(rotated.token, rotated.maxAgeSec), {
                append: true,
              });
            }
          }
          return c.json({ status: 'verified' as const });
        },
      )
  );
}
