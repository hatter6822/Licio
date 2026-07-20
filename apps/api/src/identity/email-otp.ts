// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Passwordless email one-time-code login + email-factor verification (WS-D.1.4a/b).
// A code is single-use, expires in 10 minutes, is invalidated after 5 attempts,
// and is bound to the initiating browser via a `login_attempt_id` (so a code
// phished/forwarded to another device cannot complete a sign-in there).  Only
// sha256(code) is ever stored — a store read yields nothing replayable.
import { z } from 'zod';
import { generateOneTimeCode, hashOneTimeCode, verifyOneTimeCode } from './codes.js';
import type { EphemeralStore } from './ephemeral-store.js';

export const EMAIL_OTP_TTL_MS = 10 * 60_000;
export const MAX_OTP_ATTEMPTS = 5;
export const RESEND_COOLDOWN_MS = 60_000;

const loginKey = (attemptId: string): string => `emaillogin:${attemptId}`;
const verifyKey = (userId: string): string => `emailverify:${userId}`;
// Step-up satisfaction lives in its OWN slot, disjoint from the factor-verify
// slot: a step-up code (sent to the CURRENT verified address) must never be
// consumable by /email/verify to confirm a DIFFERENT pending address change.
const stepUpKey = (userId: string): string => `emailstepup:${userId}`;
const resendKey = (accountRef: string): string => `emailresend:${accountRef}`;

interface OtpRecord {
  /** Login: the resolved user; factor-verify: the enrolling user. */
  userId: string;
  /** The address the code was DELIVERED to.  The email-change promotion path
   *  binds a pending-address change to this, so a code proving control of the
   *  CURRENT address can never confirm a DIFFERENT pending address.  Empty for
   *  the login path (browser-bound via `login_attempt_id`, not address-bound). */
  target: string;
  codeHash: string;
  attempts: number;
  /** Absolute expiry (epoch ms) — preserved across re-store so attempts never extend it. */
  expiresAt: number;
}

/** Trust-boundary guard for records read back from the ephemeral store: a
 *  corrupted/legacy entry validates to a miss rather than an unsafe `as` cast. */
const otpRecordSchema = z.object({
  userId: z.string(),
  target: z.string(),
  codeHash: z.string(),
  attempts: z.number(),
  expiresAt: z.number(),
});

export type OtpVerifyResult =
  | { ok: true; userId: string; target: string }
  | { ok: false; reason: 'no_code' | 'expired' | 'too_many_attempts' | 'mismatch' };

/** Mint and store a login code; returns the plaintext code for the caller to email. */
export async function startEmailLogin(
  store: EphemeralStore,
  attemptId: string,
  userId: string,
  now: number = Date.now(),
): Promise<{ code: string }> {
  return issueCode(store, loginKey(attemptId), userId, '', now);
}

/**
 * Mint and store an email-factor verification code (enroll/confirm an email on
 * an account), bound to the address `target` it is delivered to.
 */
export async function startEmailVerification(
  store: EphemeralStore,
  userId: string,
  target: string,
  now: number = Date.now(),
): Promise<{ code: string }> {
  return issueCode(store, verifyKey(userId), userId, target, now);
}

/**
 * Mint and store a step-up satisfaction code (re-prove control of the account's
 * current verified email) in its OWN slot — see `stepUpKey`.
 */
export async function startEmailStepUp(
  store: EphemeralStore,
  userId: string,
  target: string,
  now: number = Date.now(),
): Promise<{ code: string }> {
  return issueCode(store, stepUpKey(userId), userId, target, now);
}

async function issueCode(
  store: EphemeralStore,
  key: string,
  userId: string,
  target: string,
  now: number,
): Promise<{ code: string }> {
  const code = generateOneTimeCode();
  const record: OtpRecord = {
    userId,
    target,
    codeHash: hashOneTimeCode(code),
    attempts: 0,
    expiresAt: now + EMAIL_OTP_TTL_MS,
  };
  await store.set(key, JSON.stringify(record), EMAIL_OTP_TTL_MS);
  return { code };
}

/**
 * Read the user id bound to a login attempt WITHOUT consuming the code — used to
 * key the per-account rate limiter before a verify attempt (WS-D.1.3d).  Returns
 * null if the attempt is absent/expired/malformed.
 */
export async function peekEmailLoginUserId(
  store: EphemeralStore,
  attemptId: string,
): Promise<string | null> {
  const raw = await store.get(loginKey(attemptId));
  if (!raw) return null;
  try {
    const parsed = otpRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.userId : null;
  } catch {
    return null;
  }
}

/** Verify a login code presented under its `login_attempt_id` (browser binding). */
export async function verifyEmailLogin(
  store: EphemeralStore,
  attemptId: string,
  submittedCode: string,
  now: number = Date.now(),
): Promise<OtpVerifyResult> {
  return consumeCode(store, loginKey(attemptId), submittedCode, now);
}

/** Verify an email-factor enrollment code for `userId`. */
export async function verifyEmailFactor(
  store: EphemeralStore,
  userId: string,
  submittedCode: string,
  now: number = Date.now(),
): Promise<OtpVerifyResult> {
  return consumeCode(store, verifyKey(userId), submittedCode, now);
}

/** Verify a step-up satisfaction email code for `userId` (its own slot). */
export async function verifyEmailStepUp(
  store: EphemeralStore,
  userId: string,
  submittedCode: string,
  now: number = Date.now(),
): Promise<OtpVerifyResult> {
  return consumeCode(store, stepUpKey(userId), submittedCode, now);
}

async function consumeCode(
  store: EphemeralStore,
  key: string,
  submittedCode: string,
  now: number,
): Promise<OtpVerifyResult> {
  const raw = await store.get(key);
  if (!raw) return { ok: false, reason: 'no_code' };

  let parsed: OtpRecord;
  try {
    const result = otpRecordSchema.safeParse(JSON.parse(raw));
    if (!result.success) {
      await store.delete(key);
      return { ok: false, reason: 'no_code' };
    }
    parsed = result.data;
  } catch {
    await store.delete(key);
    return { ok: false, reason: 'no_code' };
  }
  const record = parsed;

  if (now >= record.expiresAt) {
    await store.delete(key);
    return { ok: false, reason: 'expired' };
  }
  if (record.attempts >= MAX_OTP_ATTEMPTS) {
    await store.delete(key);
    return { ok: false, reason: 'too_many_attempts' };
  }

  if (verifyOneTimeCode(submittedCode, record.codeHash)) {
    // Atomic single-use consumption (GETDEL): only one concurrent request wins
    // the take, so a valid code can never be redeemed twice under a race.
    const claimed = await store.take(key);
    if (claimed === null) return { ok: false, reason: 'no_code' };
    return { ok: true, userId: record.userId, target: record.target ?? '' };
  }

  const attempts = record.attempts + 1;
  if (attempts >= MAX_OTP_ATTEMPTS) {
    await store.delete(key); // invalidate after the 5th failed attempt
    return { ok: false, reason: 'too_many_attempts' };
  }
  // Re-store with the incremented attempt count, preserving the ORIGINAL expiry
  // (a wrong guess must never extend the code's lifetime).
  await store.set(key, JSON.stringify({ ...record, attempts }), record.expiresAt - now);
  return { ok: false, reason: 'mismatch' };
}

/**
 * Enforce the 60-second resend cooldown.  Returns true (and arms the cooldown)
 * when a resend is permitted, false while one is still in effect.  Keyed by a
 * non-reversible account ref (no email in the keyspace).
 */
export async function canResend(
  store: EphemeralStore,
  accountRef: string,
  now: number = Date.now(),
): Promise<boolean> {
  const existing = await store.get(resendKey(accountRef));
  if (existing) return false;
  await store.set(resendKey(accountRef), String(now), RESEND_COOLDOWN_MS);
  return true;
}
