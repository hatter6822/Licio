// SPDX-License-Identifier: AGPL-3.0-or-later
//
// /v1/auth/mfa/totp/* — steward/moderator TOTP MFA (WS-D.1.5).  The secret is
// stored AES-256-GCM-sealed (never plaintext).  MFA is PER-SESSION: a steward
// session is reduced-capability until it clears a TOTP code (markMfaVerified),
// so a single phished primary credential cannot wield steward power.  Codes are
// replay-protected (the used time-step is remembered) and attempt-capped; ten
// single-use recovery codes are issued once, hashed at rest.

import {
  totpConfirmRequestSchema,
  totpConfirmResponseSchema,
  totpEnrollResponseSchema,
  totpVerifyRequestSchema,
} from '@licio/shared';
import { type Context, Hono } from 'hono';
import { constantTimeEqual } from '../identity/crypto.js';
import type { IdentityServices } from '../identity/services.js';
import {
  buildSessionCookie,
  markMfaVerified,
  readSessionToken,
  revokeMfaVerified,
  rotateSession,
} from '../identity/sessions.js';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  isReplayedStep,
  otpauthUri,
  verifyTotp,
} from '../identity/totp.js';
import { zValidator } from '../lib/validate.js';
import { type AuthEnv, authMiddleware, requireStepUp } from '../middleware/auth.js';
import { err } from './auth-support.js';

const MFA_MAX_ATTEMPTS = 5;
const MFA_ATTEMPT_WINDOW_MS = 5 * 60_000;
const MFA_STEP_MEMORY_MS = 90_000; // remember the used step for ~3 windows

const attemptsKey = (userId: string) => `mfaattempts:${userId}`;
const usedStepKey = (userId: string) => `mfastep:${userId}`;

/**
 * Per-user attempt gate (5 per 5 minutes).  Returns false when the cap is hit.
 *
 * ONE atomic increment, not a read followed by a write.  This is the only
 * limiter in front of `POST /v1/auth/mfa/totp/verify` — the route carries no
 * `rateLimit()` middleware — so a get-then-set here bounded nothing: against
 * Redis the two calls are separate round trips, every overlapping request read
 * the same `count`, every one passed the test, and every one wrote the same
 * `count + 1`.  The stored counter simply pinned near 1 while the codes were
 * brute-forced.
 */
async function attemptAllowed(services: IdentityServices, userId: string): Promise<boolean> {
  const attempts = await services.otp.increment(attemptsKey(userId), MFA_ATTEMPT_WINDOW_MS);
  return attempts <= MFA_MAX_ATTEMPTS;
}

export function createMfaRoutes(resolve: () => IdentityServices) {
  return (
    new Hono<AuthEnv>()
      // --- Enroll: generate + seal a pending secret -------------------------
      .post('/mfa/totp/enroll', authMiddleware(resolve), requireStepUp(), async (c) => {
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
        if ((await services.store.getAuth(auth.userId))?.mfaEnabled && !auth.mfaVerified) {
          return c.json(err('mfa_reverify_required', 'Verify your current code first.'), 403);
        }
        const secret = generateTotpSecret();
        const user = await services.store.getUser(auth.userId);
        await services.store.setAuth(auth.userId, {
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
          const userAuth = await services.store.getAuth(auth.userId);
          if (!userAuth?.mfaSecret || !userAuth.mfaPending) {
            return c.json(err('not_enrolling', 'No pending MFA enrollment.'), 400);
          }
          // The same attempt cap as /verify: a confirm code is equally guessable.
          if (!(await attemptAllowed(services, auth.userId))) {
            return c.json(err('rate_limited', 'Too many attempts. Try again later.'), 429);
          }
          const secret = services.secretBox.open(userAuth.mfaSecret);
          const result = verifyTotp(secret, c.req.valid('json').code);
          if (!result.valid || result.step === null) {
            return c.json(err('invalid_code', 'Invalid code.'), 400);
          }
          // Burn the confirmation step against the SAME forward-only replay memory
          // /verify enforces — otherwise the enrollment code is replayable once at
          // /verify (no prior accepted step exists at initial enrollment, so no
          // isReplayedStep check is needed here, only the high-water-mark write).
          await services.otp.set(usedStepKey(auth.userId), String(result.step), MFA_STEP_MEMORY_MS);
          const recoveryCodes = generateRecoveryCodes();
          // Enrolling MFA and recording it are one fact: an append failure would
          // leave a second factor active with nothing in the trail — and this is
          // the trail a compromised-account investigation reads first.
          await services.transact(async (tx) => {
            await tx.store.setAuth(auth.userId, {
              mfaEnabled: true,
              mfaPending: false,
              mfaEnrolledAt: new Date().toISOString(),
              recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode),
            });
            await tx.audit.append({
              actorUserId: auth.userId,
              eventType: 'mfa_enroll',
              context: {},
            });
          });
          await services.otp.delete(attemptsKey(auth.userId));
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
          const userAuth = await services.store.getAuth(auth.userId);
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
            // Replay prevention (WS-D.1.5b): forward-only step acceptance against
            // the highest previously-accepted step — see `isReplayedStep`.  (A
            // ±1 window means several steps are valid at once, so single-step
            // equality memory could be clobbered by a newer verify and re-open
            // replay of an older, still-in-window code.)
            const usedRaw = await services.otp.get(usedStepKey(auth.userId));
            const lastStep = usedRaw ? Number(usedRaw) : null;
            if (isReplayedStep(lastStep, result.step)) {
              return c.json(err('replayed', 'Code already used.'), 400);
            }
            await services.otp.set(
              usedStepKey(auth.userId),
              String(result.step),
              MFA_STEP_MEMORY_MS,
            );
            try {
              await finishTotpVerification(services, auth.userId, auth.tokenHash, c);
            } catch (error) {
              // The TOTP path spends nothing, so a vanished session is simply a
              // sign-in-again — never a success reported for a grant that did
              // not land.
              if (error instanceof SessionVanishedError) {
                return c.json(err('session_expired', 'Sign in again to finish verifying.'), 401);
              }
              throw error;
            }
            return c.json({ status: 'mfa_verified' as const });
          }

          // Fall back to a single-use recovery code (constant-time compare).
          //
          // The compare is over the READ list only to find which stored hash
          // was presented; SPENDING it is `consumeRecoveryCode`, whose own
          // predicate ("still active") decides the outcome — so the code is
          // burned exactly once even under two simultaneous presentations, and
          // it is burned INSIDE the unit that records the verification. It used
          // to be spent by a `setAuth` before `finishMfa` opened its
          // transaction: an audit failure then answered 500 having permanently
          // consumed the code without granting access, which on the user's last
          // code costs them the account.
          const presentedHash = hashRecoveryCode(code);
          const matched = userAuth.recoveryCodeHashes.find((h) =>
            constantTimeEqual(presentedHash, h),
          );
          if (matched !== undefined) {
            // THE COMMIT IS THE GRANT.  `consumeRecoveryCode` spends the code
            // and records the session it verifies in ONE statement, and
            // `sessionHasRecoveryGrant` reads that back — so a session is
            // MFA-verified the moment this transaction commits, whether or not
            // anything else succeeds afterwards.
            //
            // That is why there is no continuation here any more, and no resume
            // path, window, settle, claim or takeover rule.  All of it existed
            // to reconcile a Postgres spend with a Redis grant that could fail
            // independently, and every ordering of those two writes has a window
            // in it: grant-then-record loses the record, record-then-grant loses
            // the grant.  With one durable fact there is nothing to reconcile.
            const spent = await services.transact(async (tx) => {
              const consumed = await tx.store.consumeRecoveryCode(
                auth.userId,
                matched,
                auth.tokenHash,
              );
              if (consumed === null) return null;
              await tx.audit.append({
                actorUserId: auth.userId,
                eventType: 'mfa_verify',
                context: {},
              });
              return consumed;
            });
            // Lost the race — another request spent this code between the read
            // and the write. Nothing was consumed and nothing was recorded.
            if (spent === null) return c.json(err('invalid_code', 'Invalid code.'), 400);

            // The session flag and the rotation are an OPTIMISATION over the
            // grant above, not the grant itself, so neither can fail the
            // request.  The flag saves the derived lookup on later requests; the
            // rotation is the privilege-change fixation defence.
            //
            // ORDER MATTERS ONLY HERE: rotate a session that carries the flag,
            // never one that does not.  Rotating an unflagged session would move
            // the holder to a token the durable grant does not name, and THAT
            // would be the lockout — the one case this ordering has to exclude.
            try {
              if (await markMfaVerified(services.sessions, auth.tokenHash)) {
                const token = readSessionToken(c.req.header('cookie'));
                const rotated = token ? await rotateSession(services.sessions, token) : null;
                if (rotated) {
                  c.header('Set-Cookie', buildSessionCookie(rotated.token, rotated.maxAgeSec), {
                    append: true,
                  });
                }
              }
              await services.otp.delete(attemptsKey(auth.userId));
            } catch {
              // The session store is unavailable. The grant is already durable,
              // so this session is verified from its next request onward — the
              // code is not lost and the account is not locked.
            }
            return c.json({
              status: 'mfa_verified' as const,
              recovery_used: true,
              recovery_remaining: spent.remaining,
            });
          }

          // A FAILED verification, recorded as one.
          //
          // This appended `mfa_verify` — the same event a SUCCESS writes — so
          // the trail an investigator reads to answer "did this account clear
          // MFA?" could not distinguish a clearance from a wrong code, and a
          // brute-force run and a normal sign-in produced identical rows.
          await services.transact(async (tx) => {
            await tx.audit.append({
              actorUserId: auth.userId,
              eventType: 'mfa_verify_failed',
              context: {},
            });
          });
          return c.json(err('invalid_code', 'Invalid code.'), 400);
        },
      )

      // --- Disable MFA (step-up) --------------------------------------------
      .post('/mfa/totp/disable', authMiddleware(resolve), requireStepUp(), async (c) => {
        const services = resolve();
        const auth = c.get('auth');
        if (!auth) return c.json(err('unauthenticated', 'Authentication required'), 401);
        // Disabling ACTIVE MFA requires this session to have cleared the CURRENT TOTP
        // (`mfaVerified`), not merely a primary step-up — mirroring the enroll guard
        // (§WS-D.1.5b: primary compromise ≠ steward power).  Otherwise a session opened
        // with a phished primary credential could /disable, then /enroll + /confirm an
        // attacker-chosen secret, and obtain a fully mfaVerified steward session.
        if ((await services.store.getAuth(auth.userId))?.mfaEnabled && !auth.mfaVerified) {
          return c.json(err('mfa_reverify_required', 'Verify your current code first.'), 403);
        }
        // Removing a factor is the change an investigation most wants a record
        // of, so the two commit together.
        await services.transact(async (tx) => {
          await tx.store.setAuth(auth.userId, {
            mfaEnabled: false,
            mfaPending: false,
            mfaSecret: null,
            mfaEnrolledAt: null,
            recoveryCodeHashes: [],
          });
          await tx.audit.append({
            actorUserId: auth.userId,
            eventType: 'mfa_disable',
            context: {},
          });
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

/** The session disappeared between the middleware's check and the grant
 *  (expired, or revoked from elsewhere).  Only the TOTP path raises it: TOTP
 *  spends nothing, so signing in again costs the holder a fresh code and
 *  nothing else. */
class SessionVanishedError extends Error {
  constructor() {
    super('the session no longer exists');
    this.name = 'SessionVanishedError';
  }
}

/**
 * Record a TOTP verification and grant it to the session.
 *
 * ONLY the TOTP path needs this shape.  A TOTP step spends nothing durable, so
 * a failed grant costs the holder one retry with the next code — there is
 * nothing to lose and nothing to reconcile.  The recovery-code path used to
 * share it, and that sharing was the mistake: it made a spend whose loss is
 * unrecoverable look like one whose loss is free, and every round of trying to
 * order the Postgres spend against the Redis grant was an attempt to paper over
 * the difference.  A recovery code now grants itself, durably, in the
 * transaction that spends it.
 *
 * The audit row still commits first: a privilege must not be granted ahead of
 * the record of it.  Postgres accepting the callback and then failing to COMMIT
 * would otherwise leave Redis holding a verified session with nothing recording
 * that it ever cleared MFA.
 */
async function finishTotpVerification(
  services: IdentityServices,
  userId: string,
  tokenHash: string,
  c: Context<AuthEnv>,
): Promise<void> {
  // THE GRANT FIRST, then the record of it — the opposite of the recovery path,
  // and for the reason that separates them.
  //
  // A TOTP step spends nothing durable, so there is no resource to lose by
  // granting first: a failure costs the holder one retry with the next code.
  // What the audit trail must never do is claim a clearance that did not
  // happen. Committing `mfa_verify` before the grant did exactly that — the
  // session could be revoked between the middleware's check and this call, or
  // the store could throw, and the request answered 401/500 leaving a durable
  // success row behind. Splitting `mfa_verify_failed` out for invalid codes made
  // that row MORE misleading, not less: an investigator asking "did this account
  // clear MFA?" now reads it as an unambiguous yes.
  if (!(await markMfaVerified(services.sessions, tokenHash))) throw new SessionVanishedError();
  try {
    await services.transact(async (tx) => {
      await tx.audit.append({ actorUserId: userId, eventType: 'mfa_verify', context: {} });
    });
  } catch (error) {
    // Granted but unrecorded is the other lie, so it is taken back. The revert
    // is best-effort — nothing durable was spent, so the honest answer to the
    // caller is "that did not work, try again", and the trail says nothing
    // rather than something untrue.
    await revokeMfaVerified(services.sessions, tokenHash).catch(() => undefined);
    throw error;
  }
  await services.otp.delete(attemptsKey(userId));
  const token = readSessionToken(c.req.header('cookie'));
  if (token === undefined) return;
  // `rotateSession` MOVES the session in one step, so a concurrent rotation of
  // the same cookie yields null here rather than a second successor. Either way
  // the session this request arrived on is gone, and answering `mfa_verified`
  // with no usable cookie would be a success the caller cannot act on.
  const rotated = await rotateSession(services.sessions, token);
  if (rotated === null) throw new SessionVanishedError();
  c.header('Set-Cookie', buildSessionCookie(rotated.token, rotated.maxAgeSec), {
    append: true,
  });
}
