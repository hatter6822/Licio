// SPDX-License-Identifier: AGPL-3.0-or-later
//
// /v1/auth/mfa/totp/* — steward/moderator TOTP MFA (WS-D.1.5).  The secret is
// stored AES-256-GCM-sealed (never plaintext).  MFA is PER-SESSION: a steward
// session is reduced-capability until it clears a TOTP code (markMfaVerified),
// so a single phished primary credential cannot wield steward power.  Codes are
// replay-protected (the used time-step is remembered) and attempt-capped; ten
// single-use recovery codes are issued once, hashed at rest.

import { zValidator } from '@hono/zod-validator';
import {
  totpConfirmRequestSchema,
  totpConfirmResponseSchema,
  totpEnrollResponseSchema,
  totpVerifyRequestSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { constantTimeEqual } from '../identity/crypto.js';
import type { IdentityServices } from '../identity/services.js';
import {
  buildSessionCookie,
  markMfaVerified,
  readSessionToken,
  rotateSession,
} from '../identity/sessions.js';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  otpauthUri,
  verifyTotp,
} from '../identity/totp.js';
import { type AuthEnv, authMiddleware, requireStepUp } from '../middleware/auth.js';
import { err } from './auth-support.js';

const MFA_MAX_ATTEMPTS = 5;
const MFA_ATTEMPT_WINDOW_MS = 5 * 60_000;
const MFA_STEP_MEMORY_MS = 90_000; // remember the used step for ~3 windows

const attemptsKey = (userId: string) => `mfaattempts:${userId}`;
const usedStepKey = (userId: string) => `mfastep:${userId}`;

/** Per-user attempt gate (5 per 5 minutes).  Returns false when the cap is hit. */
async function attemptAllowed(services: IdentityServices, userId: string): Promise<boolean> {
  const raw = await services.otp.get(attemptsKey(userId));
  const count = raw ? Number(raw) : 0;
  if (count >= MFA_MAX_ATTEMPTS) return false;
  await services.otp.set(attemptsKey(userId), String(count + 1), MFA_ATTEMPT_WINDOW_MS);
  return true;
}

export function createMfaRoutes(resolve: () => IdentityServices) {
  return (
    new Hono<AuthEnv>()
      // --- Enroll: generate + seal a pending secret -------------------------
      .post('/mfa/totp/enroll', authMiddleware(resolve), requireStepUp(), (c) => {
        const services = resolve();
        const auth = c.get('auth');
        if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
        // Re-enrolling OVER an already-active TOTP is a sensitive action: it must
        // require the CURRENT factor (this session has cleared the existing TOTP,
        // `mfaVerified`), not merely a primary step-up.  Otherwise a session opened
        // with a compromised primary credential could swap in an attacker-chosen
        // secret and regain steward MFA without knowing the victim's code (the
        // §WS-D.1.5b "primary compromise ≠ steward power" guarantee).  Initial
        // enrollment (no active MFA yet) is unaffected.
        if (services.store.getAuth(auth.userId)?.mfaEnabled && !auth.mfaVerified) {
          return c.json(err('mfa_reverify_required', 'Verify your current code first.'), 403);
        }
        const secret = generateTotpSecret();
        const user = services.store.getUser(auth.userId);
        services.store.setAuth(auth.userId, {
          mfaSecret: services.secretBox.seal(secret), // AES-256-GCM at rest
          mfaPending: true,
          mfaEnabled: false,
        });
        return c.json(
          totpEnrollResponseSchema.parse({
            otpauth_uri: otpauthUri(secret, user?.handle ?? auth.userId, 'Licio'),
          }),
        );
      })

      // --- Confirm: activate + issue recovery codes -------------------------
      .post(
        '/mfa/totp/confirm',
        authMiddleware(resolve),
        requireStepUp(),
        zValidator('json', totpConfirmRequestSchema),
        async (c) => {
          const services = resolve();
          const auth = c.get('auth');
          if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
          const userAuth = services.store.getAuth(auth.userId);
          if (!userAuth?.mfaSecret || !userAuth.mfaPending) {
            return c.json(err('not_enrolling', 'No pending MFA enrollment.'), 400);
          }
          // The same attempt cap as /verify: a confirm code is equally guessable.
          if (!(await attemptAllowed(services, auth.userId))) {
            return c.json(err('rate_limited', 'Too many attempts. Try again later.'), 429);
          }
          const secret = services.secretBox.open(userAuth.mfaSecret);
          if (!verifyTotp(secret, c.req.valid('json').code).valid) {
            return c.json(err('invalid_code', 'Invalid code.'), 400);
          }
          const recoveryCodes = generateRecoveryCodes();
          services.store.setAuth(auth.userId, {
            mfaEnabled: true,
            mfaPending: false,
            mfaEnrolledAt: new Date().toISOString(),
            recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode),
          });
          await services.otp.delete(attemptsKey(auth.userId));
          await services.audit.append({
            actorUserId: auth.userId,
            eventType: 'mfa_enroll',
            context: {},
          });
          // The enrolling session is now MFA-verified; rotate on the privilege change.
          await markMfaVerified(services.sessions, auth.tokenHash);
          const token = readSessionToken(c.req.header('cookie'));
          const rotated = token ? await rotateSession(services.sessions, token) : null;
          if (rotated) {
            c.header('Set-Cookie', buildSessionCookie(rotated.token, rotated.maxAgeSec), {
              append: true,
            });
          }
          return c.json(totpConfirmResponseSchema.parse({ recovery_codes: recoveryCodes }));
        },
      )

      // --- Verify: clear MFA on the current session (TOTP or recovery code) -
      .post(
        '/mfa/totp/verify',
        authMiddleware(resolve),
        zValidator('json', totpVerifyRequestSchema),
        async (c) => {
          const services = resolve();
          const auth = c.get('auth');
          if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
          const userAuth = services.store.getAuth(auth.userId);
          if (!userAuth?.mfaEnabled || !userAuth.mfaSecret) {
            return c.json(err('mfa_not_enabled', 'MFA is not enabled.'), 400);
          }
          if (!(await attemptAllowed(services, auth.userId))) {
            return c.json(err('rate_limited', 'Too many attempts. Try again later.'), 429);
          }
          const code = c.req.valid('json').code;

          const secret = services.secretBox.open(userAuth.mfaSecret);
          const result = verifyTotp(secret, code);
          if (result.valid && result.step !== null) {
            // Replay prevention: reject a code reused within the same time step.
            const usedRaw = await services.otp.get(usedStepKey(auth.userId));
            if (usedRaw && Number(usedRaw) === result.step) {
              return c.json(err('replayed', 'Code already used.'), 400);
            }
            await services.otp.set(
              usedStepKey(auth.userId),
              String(result.step),
              MFA_STEP_MEMORY_MS,
            );
            await finishMfa(services, auth.userId, auth.tokenHash);
            return c.json({ status: 'mfa_verified' as const });
          }

          // Fall back to a single-use recovery code (constant-time compare).
          const presentedHash = hashRecoveryCode(code);
          const idx = userAuth.recoveryCodeHashes.findIndex((h) =>
            constantTimeEqual(presentedHash, h),
          );
          if (idx >= 0) {
            const remaining = userAuth.recoveryCodeHashes.filter((_, i) => i !== idx);
            services.store.setAuth(auth.userId, { recoveryCodeHashes: remaining });
            await finishMfa(services, auth.userId, auth.tokenHash);
            return c.json({
              status: 'mfa_verified' as const,
              recovery_used: true,
              recovery_remaining: remaining.length,
            });
          }

          await services.audit.append({
            actorUserId: auth.userId,
            eventType: 'mfa_verify',
            context: {},
          });
          return c.json(err('invalid_code', 'Invalid code.'), 400);
        },
      )

      // --- Disable MFA (step-up) --------------------------------------------
      .post('/mfa/totp/disable', authMiddleware(resolve), requireStepUp(), async (c) => {
        const services = resolve();
        const auth = c.get('auth');
        if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
        services.store.setAuth(auth.userId, {
          mfaEnabled: false,
          mfaPending: false,
          mfaSecret: null,
          mfaEnrolledAt: null,
          recoveryCodeHashes: [],
        });
        await services.audit.append({
          actorUserId: auth.userId,
          eventType: 'mfa_disable',
          context: {},
        });
        const token = readSessionToken(c.req.header('cookie'));
        const rotated = token ? await rotateSession(services.sessions, token) : null;
        if (rotated) {
          c.header('Set-Cookie', buildSessionCookie(rotated.token, rotated.maxAgeSec), {
            append: true,
          });
        }
        return c.json({ ok: true });
      })
  );
}

/** Mark the session MFA-verified, reset the attempt counter, and audit success. */
async function finishMfa(
  services: IdentityServices,
  userId: string,
  tokenHash: string,
): Promise<void> {
  await markMfaVerified(services.sessions, tokenHash);
  await services.otp.delete(attemptsKey(userId));
  await services.audit.append({ actorUserId: userId, eventType: 'mfa_verify', context: {} });
}
