// SPDX-License-Identifier: AGPL-3.0-or-later
//
// /v1/auth credential management + step-up satisfaction (WS-D.1.2c, WS-D.1.3e).
// Removing a credential is step-up-protected and consults the single "at least one
// auth method" guard (countAuthMethods): an account can never be left unable to
// sign in.  Every method add/remove rotates the session (defeating fixation), is
// audited, and a step-up satisfies the fresh-assertion requirement WITHOUT losing
// the in-progress action.
import { randomUUID } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import {
  credentialListResponseSchema,
  webauthnAuthenticateVerifyRequestSchema,
  webauthnRegisterVerifyRequestSchema,
} from '@licio/shared';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { Hono } from 'hono';
import { z } from 'zod';
import { isLastMethodRemoval } from '../identity/auth-methods.js';
import { startEmailVerification, verifyEmailFactor } from '../identity/email-otp.js';
import { authMethodInventory, type IdentityServices } from '../identity/services.js';
import {
  buildSessionCookie,
  markStepUp,
  readSessionToken,
  rotateSession,
} from '../identity/sessions.js';
import { hashAuthWalletAddress, issueSiweNonce, verifySiwe } from '../identity/siwe.js';
import {
  createAuthenticationOptions,
  createRegistrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from '../identity/webauthn.js';
import { type AuthEnv, authMiddleware, requireStepUp } from '../middleware/auth.js';
import {
  ATTEMPT_COOKIES,
  buildAttemptCookie,
  clearAttemptCookie,
  contractVerifierFor,
  err,
  readAttempt,
} from './auth-support.js';

/** Rotate the current session after a privilege change and set the new cookie. */
async function rotateAndSet(
  services: IdentityServices,
  c: {
    req: { header: (k: string) => string | undefined };
    header: (k: string, v: string, o?: { append: boolean }) => void;
  },
): Promise<void> {
  const token = readSessionToken(c.req.header('cookie'));
  if (!token) return;
  const rotated = await rotateSession(services.sessions, token);
  if (rotated) {
    c.header('Set-Cookie', buildSessionCookie(rotated.token, rotated.maxAgeSec), { append: true });
  }
}

export function createCredentialRoutes(resolve: () => IdentityServices) {
  return (
    new Hono<AuthEnv>()
      // --- List enrolled credentials ----------------------------------------
      .get('/credentials', authMiddleware(resolve), (c) => {
        const services = resolve();
        const auth = c.get('auth');
        if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
        const userAuth = services.store.getAuth(auth.userId);
        return c.json(
          credentialListResponseSchema.parse({
            passkeys: services.store.listWebauthn(auth.userId).map((p) => ({
              credential_id: p.credentialId,
              device_name: p.deviceName,
              device_type: p.deviceType,
              backed_up: p.backedUp,
              created_at: p.createdAt,
              last_used_at: p.lastUsedAt,
            })),
            wallets: services.store.listWalletAuth(auth.userId).map((w) => ({
              credential_id: w.credentialId,
              address_truncated: w.addressTruncated,
              chain_id: w.chainId,
              created_at: w.createdAt,
              last_used_at: w.lastUsedAt,
            })),
            email: {
              present: !!services.store.getUser(auth.userId)?.email,
              verified: userAuth?.emailVerified ?? false,
            },
          }),
        );
      })

      // --- Add a passkey to the current account (step-up) -------------------
      .post('/webauthn/register/options', authMiddleware(resolve), requireStepUp(), async (c) => {
        const services = resolve();
        const auth = c.get('auth');
        if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
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
          if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
          const { response, device_name } = c.req.valid('json');
          const result = await verifyRegistration(services.challenges, services.config.webauthn, {
            userId: auth.userId,
            response: response as RegistrationResponseJSON,
          });
          if (!result.ok)
            return c.json(err('registration_failed', 'Could not register passkey.'), 400);
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
          await rotateAndSet(services, c);
          return c.json({ status: 'registered' as const });
        },
      )

      // --- Rename a passkey -------------------------------------------------
      .patch(
        '/credentials/webauthn/:credentialId',
        authMiddleware(resolve),
        zValidator('param', z.object({ credentialId: z.string().min(1) })),
        zValidator('json', z.object({ device_name: z.string().min(1).max(128) })),
        (c) => {
          const services = resolve();
          const auth = c.get('auth');
          if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
          const cred = services.store.getWebauthn(c.req.valid('param').credentialId);
          // Cross-user / missing → 404 (no existence oracle).
          if (!cred || cred.userId !== auth.userId)
            return c.json(err('not_found', 'Not found.'), 404);
          services.store.addWebauthn({ ...cred, deviceName: c.req.valid('json').device_name });
          return c.json({ ok: true });
        },
      )

      // --- Remove a passkey (step-up + last-method guard) -------------------
      .delete(
        '/credentials/webauthn/:credentialId',
        authMiddleware(resolve),
        requireStepUp(),
        zValidator('param', z.object({ credentialId: z.string().min(1) })),
        async (c) => {
          const services = resolve();
          const auth = c.get('auth');
          if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
          const cred = services.store.getWebauthn(c.req.valid('param').credentialId);
          if (!cred || cred.userId !== auth.userId)
            return c.json(err('not_found', 'Not found.'), 404);
          if (isLastMethodRemoval(authMethodInventory(services, auth.userId), 'passkey')) {
            return c.json(err('last_method', 'Set up another way to sign in first.'), 409);
          }
          services.store.deleteWebauthn(cred.credentialId);
          await services.audit.append({
            actorUserId: auth.userId,
            eventType: 'auth_method_remove',
            context: { auth_method: 'webauthn' },
          });
          await rotateAndSet(services, c);
          return c.json({ ok: true });
        },
      )

      // --- Unlink an auth-wallet (step-up + last-method guard) --------------
      .delete(
        '/credentials/wallet/:credentialId',
        authMiddleware(resolve),
        requireStepUp(),
        zValidator('param', z.object({ credentialId: z.string().uuid() })),
        async (c) => {
          const services = resolve();
          const auth = c.get('auth');
          if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
          const cred = services.store
            .listWalletAuth(auth.userId)
            .find((w) => w.credentialId === c.req.valid('param').credentialId);
          if (!cred) return c.json(err('not_found', 'Not found.'), 404);
          if (isLastMethodRemoval(authMethodInventory(services, auth.userId), 'wallet')) {
            return c.json(err('last_method', 'Set up another way to sign in first.'), 409);
          }
          services.store.deleteWalletAuth(cred.credentialId);
          await services.audit.append({
            actorUserId: auth.userId,
            eventType: 'auth_method_remove',
            context: { auth_method: 'wallet' },
          });
          await rotateAndSet(services, c);
          return c.json({ ok: true });
        },
      )

      // --- Disable the email factor (step-up + last-method guard) ----------
      .post('/email/disable', authMiddleware(resolve), requireStepUp(), async (c) => {
        const services = resolve();
        const auth = c.get('auth');
        if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
        if (isLastMethodRemoval(authMethodInventory(services, auth.userId), 'email')) {
          return c.json(err('last_method', 'Set up another way to sign in first.'), 409);
        }
        services.store.updateUser(auth.userId, { email: null });
        services.store.setAuth(auth.userId, { emailVerified: false, emailVerifiedAt: null });
        await services.audit.append({
          actorUserId: auth.userId,
          eventType: 'auth_method_remove',
          context: { auth_method: 'email_otp' },
        });
        await rotateAndSet(services, c);
        return c.json({ ok: true });
      })

      // --- Step-up satisfaction: WebAuthn -----------------------------------
      .post('/step-up/webauthn/options', authMiddleware(resolve), async (c) => {
        const services = resolve();
        const auth = c.get('auth');
        if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
        const attemptId = randomUUID();
        const options = await createAuthenticationOptions(
          services.challenges,
          services.config.webauthn,
          {
            challengeRef: attemptId,
            allowCredentials: services.store
              .listWebauthn(auth.userId)
              .map((p) => ({ id: p.credentialId, transports: p.transports as never })),
          },
        );
        c.header('Set-Cookie', buildAttemptCookie(ATTEMPT_COOKIES.stepUp, attemptId), {
          append: true,
        });
        return c.json(options);
      })

      .post(
        '/step-up/webauthn/verify',
        authMiddleware(resolve),
        zValidator('json', webauthnAuthenticateVerifyRequestSchema),
        async (c) => {
          const services = resolve();
          const auth = c.get('auth');
          if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
          const attemptId = readAttempt(c.req.header('cookie'), ATTEMPT_COOKIES.stepUp);
          if (!attemptId) return c.json(err('step_up_failed', 'Step-up failed.'), 400);
          const { response } = c.req.valid('json');
          const cred = services.store.getWebauthn(response.id);
          // The credential must belong to the CURRENT user.
          if (!cred || cred.userId !== auth.userId) {
            return c.json(err('step_up_failed', 'Step-up failed.'), 400);
          }
          const result = await verifyAuthentication(services.challenges, services.config.webauthn, {
            challengeRef: attemptId,
            response: response as AuthenticationResponseJSON,
            credential: {
              credentialId: cred.credentialId,
              publicKey: cred.publicKey,
              counter: cred.counter,
              transports: cred.transports as never,
            },
          });
          if (!result.ok) return c.json(err('step_up_failed', 'Step-up failed.'), 400);
          services.store.addWebauthn({ ...cred, counter: result.newCounter });
          await markStepUp(services.sessions, auth.tokenHash);
          c.header('Set-Cookie', clearAttemptCookie(ATTEMPT_COOKIES.stepUp), { append: true });
          return c.json({ status: 'stepped_up' as const });
        },
      )

      // --- Step-up satisfaction: email one-time code ------------------------
      .post('/step-up/email/start', authMiddleware(resolve), async (c) => {
        const services = resolve();
        const auth = c.get('auth');
        if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
        const user = services.store.getUser(auth.userId);
        if (!user?.email || !services.store.getAuth(auth.userId)?.emailVerified) {
          return c.json(err('not_applicable', 'No verified email for step-up.'), 400);
        }
        const { code } = await startEmailVerification(services.otp, auth.userId);
        await services.mailer.sendCode(user.email, code, 'verify');
        return c.json({ status: 'sent' as const });
      })

      .post(
        '/step-up/email/verify',
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
          if (!result.ok) return c.json(err('step_up_failed', 'Step-up failed.'), 400);
          await markStepUp(services.sessions, auth.tokenHash);
          return c.json({ status: 'stepped_up' as const });
        },
      )

      // --- Step-up satisfaction: wallet signature ---------------------------
      .post('/step-up/wallet/nonce', authMiddleware(resolve), async (c) => {
        const services = resolve();
        const auth = c.get('auth');
        if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
        const attemptId = randomUUID();
        const nonce = await issueSiweNonce(services.challenges, attemptId);
        c.header('Set-Cookie', buildAttemptCookie(ATTEMPT_COOKIES.stepUp, attemptId), {
          append: true,
        });
        return c.json({ nonce: nonce.nonce, issued_at: nonce.issuedAt });
      })

      .post(
        '/step-up/wallet/verify',
        authMiddleware(resolve),
        zValidator(
          'json',
          z.object({
            message: z.string().min(1).max(4096),
            signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
          }),
        ),
        async (c) => {
          const services = resolve();
          const auth = c.get('auth');
          if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
          const attemptId = readAttempt(c.req.header('cookie'), ATTEMPT_COOKIES.stepUp);
          if (!attemptId) return c.json(err('step_up_failed', 'Step-up failed.'), 400);
          const body = c.req.valid('json');
          const verifier = contractVerifierFor(services);
          const result = await verifySiwe({
            store: services.challenges,
            attemptId,
            message: body.message,
            signature: body.signature,
            config: services.config.siwe,
            ...(verifier ? { contractVerifier: verifier } : {}),
          });
          if (!result.ok) return c.json(err('step_up_failed', 'Step-up failed.'), 400);
          const addressHash = hashAuthWalletAddress(
            services.config.masterSecret,
            result.addressLower,
          );
          const owns = services.store
            .listWalletAuth(auth.userId)
            .some((w) => w.addressHash === addressHash);
          if (!owns) return c.json(err('step_up_failed', 'Step-up failed.'), 400);
          await markStepUp(services.sessions, auth.tokenHash);
          c.header('Set-Cookie', clearAttemptCookie(ATTEMPT_COOKIES.stepUp), { append: true });
          return c.json({ status: 'stepped_up' as const });
        },
      )
  );
}
