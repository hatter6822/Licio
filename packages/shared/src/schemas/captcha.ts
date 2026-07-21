// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sign-up proof-of-work CAPTCHA wire contracts (WS-D bot-prevention layer 1,
// SPEC §19.1-adjacent).  The platform's CSP (`script-src 'self'`,
// `connect-src 'self'`) and privacy doctrine (no third-party scripts, no
// client fingerprinting, no network-identity reads) rule out every hosted
// CAPTCHA product, so the "most privacy-preserving CAPTCHA available" is a
// SELF-HOSTED proof-of-work challenge: the server publishes a partial-preimage
// puzzle, the browser burns a bounded amount of CPU to solve it, and the
// server verifies the solution with two hashes and one single-use store take.
//
//   • No user interaction, no visual/audio puzzle → fully accessible (WCAG),
//     language-independent, screen-reader-invisible.
//   • No cookies, no fingerprinting, no third parties → nothing about the
//     requester is read, stored, or leaked (the §19.1 posture).
//   • Cost asymmetry: one legitimate sign-up pays a sub-second solve once;
//     bulk account creation pays it linearly per account, and the server can
//     raise the work factor under abuse pressure without touching identity.
//
// Scheme (ALTCHA-style): the server draws a secret number N ∈ [0, max_number],
// publishes `target = SHA-256(salt || "." || N)` plus an HMAC binding every
// challenge field, and remembers the challenge id in the single-use ephemeral
// store.  The client brute-forces N and echoes the full tuple + N; the server
// re-computes one SHA-256, checks the HMAC (constant-time), checks expiry, and
// consumes the challenge id exactly once.  NOTE: this is deliberately scoped
// to the WS-D sign-up surface — the LCAP relay plane's §27.4 "no proof-of-work"
// doctrine governs LCAP posting and is untouched by this gate.
import { z } from 'zod';
import { isoTimestampSchema } from './common.js';

/** Hex-encoded SHA-256 digest. */
const hex64Schema = z.string().regex(/^[0-9a-f]{64}$/, { message: 'expected 64 hex chars' });
/** Hex-encoded random identifiers (challenge id, salt). */
const hex32Schema = z.string().regex(/^[0-9a-f]{32}$/, { message: 'expected 32 hex chars' });

/** The only supported digest. WebCrypto + node:crypto both provide it natively. */
export const POW_CAPTCHA_ALGORITHM = 'SHA-256' as const;

/** Hard ceiling on the search space — bounds worst-case client work even if a
 *  misconfigured server publishes an absurd difficulty. */
export const POW_CAPTCHA_MAX_NUMBER_CEILING = 10_000_000;

/** A proof-of-work challenge as issued by `POST /v1/auth/captcha/challenge`. */
export const powChallengeSchema = z
  .object({
    algorithm: z.literal(POW_CAPTCHA_ALGORITHM),
    /** Opaque single-use challenge id (hex; also the replay-prevention key). */
    challenge_id: hex32Schema,
    /** Random salt prepended by the solver: digest input is `${salt}.${n}`. */
    salt: hex32Schema,
    /** The target digest the solver must reproduce. */
    target: hex64Schema,
    /** Inclusive upper bound of the secret number (the work factor). */
    max_number: z.number().int().positive().max(POW_CAPTCHA_MAX_NUMBER_CEILING),
    /** Server HMAC binding (challenge_id, salt, target, max_number, expires_at). */
    signature: hex64Schema,
    /** Issuance expiry — a stale solution is rejected even if unredeemed. */
    expires_at: isoTimestampSchema,
  })
  .strict();
export type PowChallenge = z.infer<typeof powChallengeSchema>;

/** The `/v1/auth/captcha/challenge` response when the gate is DISABLED
 *  (`SIGNUP_POW_MAX_NUMBER=0`, the operator opt-out): no puzzle is issued and
 *  the client attaches no `captcha` (the redeem endpoints accept its absence
 *  because verification is a no-op when disabled). */
export const powCaptchaDisabledSchema = z.object({ disabled: z.literal(true) }).strict();
export type PowCaptchaDisabled = z.infer<typeof powCaptchaDisabledSchema>;

/** The challenge endpoint returns EITHER a puzzle (gate on) or the disabled
 *  sentinel (gate off).  A challenge has no `disabled` key and the sentinel has
 *  no puzzle fields, so the two are unambiguous. */
export const powChallengeResponseSchema = z.union([powChallengeSchema, powCaptchaDisabledSchema]);
export type PowChallengeResponse = z.infer<typeof powChallengeResponseSchema>;

/** A solved challenge, attached to sign-up requests as `captcha`. */
export const powSolutionSchema = z
  .object({
    challenge_id: hex32Schema,
    salt: hex32Schema,
    target: hex64Schema,
    max_number: z.number().int().positive().max(POW_CAPTCHA_MAX_NUMBER_CEILING),
    signature: hex64Schema,
    expires_at: isoTimestampSchema,
    /** The number the solver found with SHA-256(`${salt}.${number}`) === target. */
    number: z.number().int().nonnegative().max(POW_CAPTCHA_MAX_NUMBER_CEILING),
  })
  .strict();
export type PowSolution = z.infer<typeof powSolutionSchema>;

/** The canonical HMAC preimage for a challenge tuple.  Shared by issuance and
 *  verification so the two can never drift; the solver never computes it. */
export function powChallengeSigningInput(fields: {
  challenge_id: string;
  salt: string;
  target: string;
  max_number: number;
  expires_at: string;
}): string {
  return [
    'licio-pow-captcha-v1',
    fields.challenge_id,
    fields.salt,
    fields.target,
    String(fields.max_number),
    fields.expires_at,
  ].join('|');
}

/** The digest preimage a solver iterates: `${salt}.${n}`. */
export function powDigestInput(salt: string, n: number): string {
  return `${salt}.${n}`;
}
