// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sign-up proof-of-work CAPTCHA (WS-D bot-prevention layer 1).  The server side
// of the self-hosted, privacy-preserving challenge defined in
// @licio/shared/schemas/captcha: issuance mints a random-secret partial-preimage
// puzzle and remembers its id in the single-use ephemeral store (the WebAuthn
// challenge pattern); verification is two hashes, one constant-time HMAC
// compare, and one atomic `take`.
//
// PRIVACY (SPEC §19.1): nothing about the requester is read or stored — no
// network identity, no cookie, no fingerprint.  The only state is the opaque
// challenge id.  Difficulty adapts to PROCESS-WIDE sign-up pressure (the same
// identity-free posture as lib/rate-limit.ts): under a registration flood every
// prospective account costs more CPU, while the quiet-hours cost stays low.
//
// SCOPE: the WS-D sign-up surface only.  The LCAP relay plane's §27.4 "no
// proof-of-work" doctrine governs LCAP posting and is deliberately untouched.
import { randomBytes, randomInt } from 'node:crypto';
import {
  POW_CAPTCHA_MAX_NUMBER_CEILING,
  type PowChallenge,
  type PowSolution,
  powChallengeSchema,
  powChallengeSigningInput,
  powDigestInput,
} from '@licio/shared';
import { constantTimeEqual, deriveKey, hmacHex, KEY_DOMAINS, sha256Hex } from './crypto.js';
import type { EphemeralStore } from './ephemeral-store.js';

/** Challenge lifetime: long enough to fill a sign-up form + solve on a slow
 *  device, short enough that a stockpile of pre-solved challenges (minted at a
 *  low difficulty during a quiet window) goes stale quickly — the stockpile an
 *  attacker can hold is bounded by (mint rate-limit × this TTL). */
export const POW_CHALLENGE_TTL_MS = 5 * 60_000;

/** Default work factor (expected solve = max/2 SHA-256 digests).  Calibrated
 *  for WebCrypto's per-call overhead: sub-second on desktop, a few seconds on
 *  low-end mobile — a one-time cost per account creation. */
export const DEFAULT_SIGNUP_POW_MAX_NUMBER = 40_000;

/** Work factor under NODE_ENV=test: the real flow (issue → solve → verify →
 *  single-use) runs in every suite at negligible cost. */
export const TEST_SIGNUP_POW_MAX_NUMBER = 64;

export interface PowCaptchaConfig {
  /** Base inclusive upper bound of the secret number.  0 DISABLES the gate —
   *  an explicit, documented operator opt-out (mirrors ALLOW_INSECURE_NULL_MAILER),
   *  never a silent default. */
  maxNumber: number;
}

export function isPowCaptchaEnabled(config: PowCaptchaConfig): boolean {
  return config.maxNumber > 0;
}

// ---------------------------------------------------------------------------
// Adaptive difficulty under sign-up pressure (identity-free, process-local).
// ---------------------------------------------------------------------------

export interface SignupPressureConfig {
  windowMs: number;
  /** Issuances per window at which the multiplier doubles, doubles again, … */
  steps: readonly number[];
}

/** One doubling per crossed step: ≤30/min ×1, >30 ×2, >60 ×4, >120 ×8. */
export const DEFAULT_SIGNUP_PRESSURE: SignupPressureConfig = {
  windowMs: 60_000,
  steps: [30, 60, 120],
};

/**
 * A fixed-window issuance counter that scales the work factor under load.
 * Deliberately process-local and identity-free — it measures aggregate demand
 * on this instance, never who is asking (the lib/rate-limit.ts posture).
 */
export class SignupPressure {
  #count = 0;
  #resetAt = 0;
  readonly #config: SignupPressureConfig;
  readonly #now: () => number;

  constructor(
    config: SignupPressureConfig = DEFAULT_SIGNUP_PRESSURE,
    now: () => number = Date.now,
  ) {
    this.#config = config;
    this.#now = now;
  }

  /** Record one issuance and return the multiplier that applies to it. */
  record(): number {
    const now = this.#now();
    if (now >= this.#resetAt) {
      this.#count = 0;
      this.#resetAt = now + this.#config.windowMs;
    }
    this.#count += 1;
    let multiplier = 1;
    for (const step of this.#config.steps) {
      if (this.#count > step) multiplier *= 2;
    }
    return multiplier;
  }
}

// ---------------------------------------------------------------------------
// Issuance + verification.
// ---------------------------------------------------------------------------

const storeKey = (challengeId: string) => `powcap:${challengeId}`;

function signChallenge(
  masterSecret: string,
  fields: Parameters<typeof powChallengeSigningInput>[0],
): string {
  const key = deriveKey(masterSecret, KEY_DOMAINS.powCaptcha);
  return hmacHex(key, powChallengeSigningInput(fields));
}

/**
 * Mint a challenge: draw the secret, publish its digest, sign the tuple, and
 * remember the id for single-use redemption.  The secret number itself is
 * DISCARDED — verification only ever recomputes the published digest.
 */
export async function issuePowChallenge(
  store: EphemeralStore,
  masterSecret: string,
  config: PowCaptchaConfig,
  options: { now?: () => number; pressure?: SignupPressure } = {},
): Promise<PowChallenge> {
  const now = options.now ?? Date.now;
  const multiplier = options.pressure?.record() ?? 1;
  const maxNumber = Math.min(POW_CAPTCHA_MAX_NUMBER_CEILING, config.maxNumber * multiplier);
  const challengeId = randomBytes(16).toString('hex');
  const salt = randomBytes(16).toString('hex');
  // Unbiased uniform draw over [0, maxNumber] (randomInt's exclusive bound is
  // capped at 2^48; maxNumber is far below it), so E[solve] = maxNumber / 2.
  const secret = randomInt(0, maxNumber + 1);
  const target = sha256Hex(powDigestInput(salt, secret));
  const expiresAt = new Date(now() + POW_CHALLENGE_TTL_MS).toISOString();
  const fields = {
    challenge_id: challengeId,
    salt,
    target,
    max_number: maxNumber,
    expires_at: expiresAt,
  };
  const challenge: PowChallenge = powChallengeSchema.parse({
    algorithm: 'SHA-256',
    ...fields,
    signature: signChallenge(masterSecret, fields),
  });
  await store.set(storeKey(challengeId), '1', POW_CHALLENGE_TTL_MS);
  return challenge;
}

export type PowVerdict = { ok: true } | { ok: false; code: 'captcha_required' | 'captcha_invalid' };

/**
 * Verify a solved challenge.  Cheap checks first (HMAC authenticity, expiry,
 * bounds, digest); the single-use `take` runs LAST so a malformed or forged
 * attempt can never burn a victim's outstanding challenge, and a fully-valid
 * solution is consumed exactly once even under concurrent redemption.
 */
export async function verifyPowSolution(
  store: EphemeralStore,
  masterSecret: string,
  config: PowCaptchaConfig,
  solution: PowSolution | undefined,
  now: () => number = Date.now,
): Promise<PowVerdict> {
  if (!isPowCaptchaEnabled(config)) return { ok: true };
  if (!solution) return { ok: false, code: 'captcha_required' };
  const expected = signChallenge(masterSecret, {
    challenge_id: solution.challenge_id,
    salt: solution.salt,
    target: solution.target,
    max_number: solution.max_number,
    expires_at: solution.expires_at,
  });
  if (!constantTimeEqual(expected, solution.signature)) {
    return { ok: false, code: 'captcha_invalid' };
  }
  const expiresAtMs = Date.parse(solution.expires_at);
  if (!Number.isFinite(expiresAtMs) || now() > expiresAtMs) {
    return { ok: false, code: 'captcha_invalid' };
  }
  if (solution.number > solution.max_number) {
    return { ok: false, code: 'captcha_invalid' };
  }
  const digest = sha256Hex(powDigestInput(solution.salt, solution.number));
  if (!constantTimeEqual(digest, solution.target)) {
    return { ok: false, code: 'captcha_invalid' };
  }
  // Single use: only a solution that passed every cheap check consumes the
  // stored id.  A missing id means expired, never issued, or already redeemed.
  const issued = await store.take(storeKey(solution.challenge_id));
  if (issued === null) return { ok: false, code: 'captcha_invalid' };
  return { ok: true };
}

/**
 * Brute-force a challenge in-process (node:crypto).  Test + tooling helper —
 * the browser solves in a Web Worker via WebCrypto (apps/web).
 */
export function solvePowChallengeSync(challenge: PowChallenge): PowSolution {
  for (let n = 0; n <= challenge.max_number; n += 1) {
    if (sha256Hex(powDigestInput(challenge.salt, n)) === challenge.target) {
      return {
        challenge_id: challenge.challenge_id,
        salt: challenge.salt,
        target: challenge.target,
        max_number: challenge.max_number,
        signature: challenge.signature,
        expires_at: challenge.expires_at,
        number: n,
      };
    }
  }
  throw new Error('pow-captcha: no solution within max_number (corrupted challenge)');
}
