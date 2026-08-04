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
import type { IdentityServices, IdentityTx } from '../identity/services.js';
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

/**
 * How long a spent recovery code can still FINISH the verification it was spent
 * for.
 *
 * A continuation describes an operation in flight, and in flight has a duration:
 * the user is retrying the request they just made, or signing in again after the
 * one that failed. Fifteen minutes covers that generously.
 *
 * Unbounded it would be a slow leak instead. The continuation is cleared on
 * success, but that clear is a separate write from the grant it settles — so a
 * verification that succeeded and then failed to settle leaves a pending row
 * forever, and once the sessions its grant created have expired, the spent code
 * becomes usable a second time.
 */
const RESUMABLE_VERIFICATION_WINDOW_MS = 15 * 60_000;

/**
 * Is the verification this continuation names still UNFINISHED?
 *
 * The only session that can answer is the one the continuation was spent for.
 * Alive and `mfa_verified` ⇒ the grant landed, and a single-use code has no
 * second grant to give.  Gone, or alive and unverified ⇒ it did not, and the
 * holder may finish it — which is the lockout this whole path exists to
 * prevent, since on the last code there is no other way back.
 *
 * This deliberately does NOT ask whether the USER holds a verified session
 * anywhere.  That was the first cut and it read as evidence when it was not: a
 * verified session on a device the holder cannot reach says nothing about this
 * grant, and it permanently blocked a continuation their last code had paid
 * for.
 */
async function isUnfinished(services: IdentityServices, sessionHash: string): Promise<boolean> {
  const stored = await services.sessions.get(sessionHash);
  return stored === null || !stored.record.mfa_verified;
}

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
              await finishMfa(services, auth.userId, auth.tokenHash, c);
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
            let spent: { remaining: number } | null;
            try {
              spent = await finishMfa(
                services,
                auth.userId,
                auth.tokenHash,
                c,
                (tx) => tx.store.consumeRecoveryCode(auth.userId, matched, auth.tokenHash),
                // SETTLED before the rotation that would otherwise hide it: the
                // grant landed, so there is nothing left to resume, and the row
                // is cleared while the session it names is still alive.
                () => services.store.clearResumableVerification(auth.userId, matched),
              );
            } catch (error) {
              // The code IS spent and recorded, and its continuation is pending:
              // the next session this user opens finishes it (see the resume
              // block below). Reporting success here would be a lie, and
              // reporting an unrecoverable failure would be the lockout.
              if (error instanceof SessionVanishedError) {
                return c.json(err('session_expired', 'Sign in again to finish verifying.'), 401);
              }
              throw error;
            }
            // Lost the race — another request spent this code between the read
            // and the write. Nothing was consumed and nothing was recorded.
            if (spent === null) return c.json(err('invalid_code', 'Invalid code.'), 400);
            return c.json({
              status: 'mfa_verified' as const,
              recovery_used: true,
              recovery_remaining: spent.remaining,
            });
          }

          // …OR A VERIFICATION TO RESUME.
          //
          // The consumption commits before the Redis grant (a privilege must
          // not be granted ahead of the record of it), which leaves one case the
          // ordering cannot fix: the unit commits and the grant then fails. On
          // any code but the last that costs a retry with another one; on the
          // LAST it costs the account, permanently, for a fault on our side.
          //
          // So a code already spent FOR THIS SESSION resumes its own
          // verification rather than being called invalid. Single-use is
          // untouched: the code grants MFA to exactly one session, the session
          // hash says which, and a holder presenting it from anywhere else still
          // gets nothing. No second consumption and no second `mfa_verify` row —
          // this is the same verification finishing, not a new one.
          //
          // SETTLING IS NOT THE ONLY THING HOLDING THIS SHUT, because settling
          // is a second write and it can fail. `finishMfa` grants in Redis and
          // ROTATES — which deletes the session the continuation names — and
          // only then does the caller clear the row. If that clear fails, the
          // continuation is left naming a session that no longer exists, which
          // is exactly what "the grant never landed" looks like, and the code
          // would verify a second session.
          //
          // So the settle now runs BEFORE the rotation (`grantVerification`),
          // which is what makes the continuation's own session the evidence: a
          // settle that fails leaves the row naming a session that is alive AND
          // VERIFIED, and the takeover arm below refuses exactly that.
          //
          // It asks about the NAMED session and not about the user. Asking "does
          // this user hold any verified session" was the first cut, and it was
          // too coarse in the ordinary multi-device case: a verified session on
          // a phone the holder cannot reach is no evidence about THIS grant, and
          // it permanently blocked the continuation their last code had paid
          // for.
          const resumable = await services.store.findResumableVerification(
            auth.userId,
            presentedHash,
            new Date(Date.now() - RESUMABLE_VERIFICATION_WINDOW_MS).toISOString(),
          );
          // WHO MAY FINISH IT: this session, or — if the session it was spent
          // for no longer exists — any session of the same user.
          //
          // The strict rule alone stranded the very case it was written for.
          // `markMfaVerified` returns silently when the session is gone, so a
          // session that expired or was revoked between the middleware check and
          // the post-commit grant left the code spent, the continuation bound to
          // a dead token hash, and (on the last code) no way back at all.
          //
          // The fallback costs nothing: the holder already proved possession of
          // a recovery code and this session already cleared primary auth, which
          // is exactly the bar an UNSPENT code would have met. And it opens only
          // once the original session is unusable, so while that session lives
          // the code still grants MFA to precisely one.
          // TAKING IT OVER IS A COMPARE-AND-SET, not a decision made from a read.
          //
          // Two primary-authenticated sessions can both find the original gone
          // and both conclude they may finish it — and a code that is single-use
          // by construction would grant steward assurance to both. The rebind
          // settles which; the loser is told the code is invalid, which for it
          // now is.
          const claimed =
            resumable === null
              ? false
              : resumable.verificationSessionHash === auth.tokenHash ||
                // DID THIS GRANT ALREADY LAND?  The one session that can answer
                // is the one the continuation names: alive and verified means it
                // landed and there is no second grant to give; gone, or alive
                // and unverified, means it did not.
                ((await isUnfinished(services, resumable.verificationSessionHash)) &&
                  (await services.store.claimResumableVerification(
                    auth.userId,
                    presentedHash,
                    resumable.verificationSessionHash,
                    auth.tokenHash,
                  )));
          if (resumable !== null && claimed) {
            try {
              // The SAME ordering as a fresh consumption — grant, settle (which
              // is also the claim that makes concurrent retries single-winner),
              // then rotate.
              await grantVerification(services, auth.userId, auth.tokenHash, c, () =>
                services.store.clearResumableVerification(auth.userId, presentedHash),
              );
            } catch (error) {
              // The session went away underneath us, or another request is
              // already finishing this continuation — say so rather than
              // answering `mfa_verified` for a grant this request did not make.
              if (error instanceof SessionVanishedError) {
                return c.json(err('session_expired', 'Sign in again to finish verifying.'), 401);
              }
              throw error;
            }
            return c.json({
              status: 'mfa_verified' as const,
              recovery_used: true,
              recovery_remaining: resumable.remaining,
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

/** The session disappeared between the middleware's check and the post-commit
 *  grant (expired, or revoked from elsewhere). The verification is recorded and
 *  its factor spent, but no session was verified — so the caller is told to sign
 *  in again, and the pending continuation lets the next session finish it. */
class SessionVanishedError extends Error {
  constructor() {
    super('the session no longer exists');
    this.name = 'SessionVanishedError';
  }
}

/** The presented recovery code was spent by another request between the read
 *  and the conditional write. Thrown INSIDE the unit so the verification rolls
 *  back whole rather than half-applying. */
class RecoveryCodeAlreadySpentError extends Error {
  constructor() {
    super('the recovery code is no longer active');
    this.name = 'RecoveryCodeAlreadySpentError';
  }
}

/**
 * Mark the session MFA-verified, reset the attempt counter, audit success, and
 * rotate the session id on the privilege change — mirroring /confirm and every
 * other privilege transition (a new mfa_verified session id defeats fixation).
 * `markMfaVerified` runs BEFORE the rotation so the rotated record — which
 * `rotateSession` copies from the stored one — carries `mfa_verified=true`.
 */
async function finishMfa<T>(
  services: IdentityServices,
  userId: string,
  tokenHash: string,
  c: Context<AuthEnv>,
  /**
   * The durable factor this verification SPENDS, run inside the same unit.
   *
   * A recovery code is consumed by clearing it; a TOTP step is not, so this is
   * absent there. Returning `null` from it aborts the whole verification —
   * a code another request spent first must not produce a verified session,
   * and must not leave a record saying it did.
   */
  consume?: (tx: IdentityTx) => Promise<T | null>,
  /** Settle the continuation this grant completes — run BEFORE the rotation,
   *  and its `false` means another request is already completing it. */
  settle?: () => Promise<boolean>,
): Promise<T | null> {
  // THE PRIVILEGE IS GRANTED AFTER THE COMMIT, and this ordering is the whole
  // point of the function.
  //
  // The session flag lives in Redis and cannot join a Postgres transaction, so
  // one of the two orderings has to be chosen deliberately. It used to sit
  // INSIDE the unit, on the reasoning that a failed `markMfaVerified` would
  // then abort the record — true, and it bought the smaller half. The other
  // half is what a failure actually looks like: Postgres accepting the callback
  // and then failing to COMMIT left Redis already holding a verified session
  // while the consumption and the `mfa_verify` row both rolled back. The
  // request answered 500, the recovery code stayed reusable, and the session
  // held steward privileges with nothing recording that it ever cleared MFA.
  //
  // After the commit, the two failure modes are: nothing happens at all, or the
  // factor is spent and RECORDED while the session stays unverified — costing
  // the user a retry with another code, never granting authority no record
  // accounts for. A privilege gate must fail closed on the privilege.
  const spent = await services
    .transact(async (tx) => {
      const consumed = consume === undefined ? (undefined as T) : await consume(tx);
      if (consumed === null) throw new RecoveryCodeAlreadySpentError();
      await tx.audit.append({ actorUserId: userId, eventType: 'mfa_verify', context: {} });
      return consumed;
    })
    .catch((error: unknown) => {
      // The unit rolled back: no consumption, no record, no verified session.
      if (error instanceof RecoveryCodeAlreadySpentError) return null;
      throw error;
    });
  if (spent === null) return null;
  await grantVerification(services, userId, tokenHash, c, settle);
  return spent;
}

/**
 * The post-commit half of a verification: GRANT, then SETTLE, then ROTATE.
 *
 * One ordering, shared by the fresh consumption above and the resume path in
 * the route, because the two had drifted and the drift was the bug.
 *
 * SETTLE BEFORE ROTATE.  The rotation deletes the session the continuation
 * names, so a settle that runs after it — and fails — leaves a pending row
 * pointing at a session that no longer exists, which is exactly what "the grant
 * never landed" looks like.  Settling first means a failure there leaves the
 * continuation naming a session that is alive AND verified, which no resume arm
 * will touch.  That is also why the takeover arm can ask about the NAMED
 * session rather than about the user: an unrelated verified session on another
 * device is no evidence about THIS grant, and treating it as such locked a
 * multi-device user out of the continuation their last code had paid for.
 *
 * AND THE SETTLE IS THE CLAIM.  It reports whether this caller cleared the row,
 * so exactly one of several concurrent completions proceeds to the rotation.
 * The same-session arm has no compare-and-set available — the continuation
 * already names the caller — so without this, two retries carrying one cookie
 * both granted and both rotated, and one single-use code left two live verified
 * sessions behind.
 */
async function grantVerification(
  services: IdentityServices,
  userId: string,
  tokenHash: string,
  c: Context<AuthEnv>,
  settle?: () => Promise<boolean>,
): Promise<void> {
  // A grant that could not be applied must not be reported as one. The record
  // and any consumption are already committed, so the caller answers honestly
  // and the continuation is what makes the spent factor recoverable.
  if (!(await markMfaVerified(services.sessions, tokenHash))) {
    throw new SessionVanishedError();
  }
  if (settle !== undefined && !(await settle())) throw new SessionVanishedError();
  await services.otp.delete(attemptsKey(userId));
  const token = readSessionToken(c.req.header('cookie'));
  if (token === undefined) return;
  // `rotateSession` TAKES the old session, so a concurrent rotation of the same
  // cookie yields null here rather than a second successor. Either way the
  // session this request arrived on is gone, and answering `mfa_verified` with
  // no usable cookie would be a success the caller cannot act on.
  const rotated = await rotateSession(services.sessions, token);
  if (rotated === null) throw new SessionVanishedError();
  c.header('Set-Cookie', buildSessionCookie(rotated.token, rotated.maxAgeSec), {
    append: true,
  });
}
