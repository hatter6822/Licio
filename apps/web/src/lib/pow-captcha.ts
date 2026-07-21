// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sign-up proof-of-work CAPTCHA client (WS-D bot-prevention layer 1).  Fetches
// a challenge from the BFF, brute-forces the partial preimage with WebCrypto —
// in a Web Worker where available (browsers), on the main thread with
// cooperative yielding otherwise (tests / exotic runtimes) — and hands the
// solved tuple to the sign-up flows.  Nothing about the user is read or sent:
// the solve is pure CPU over server-supplied random bytes.
//
// UX: `primeSignupCaptcha()` starts fetching + solving as soon as the create-
// account panel mounts, so by the time the user has typed a handle the token
// is usually ready and submission adds no perceptible latency.  Tokens are
// SINGLE-USE server-side, so `takeSignupCaptcha()` consumes the cached solve;
// a failed attempt simply solves a fresh one.
//
// When the operator DISABLED the gate (SIGNUP_POW_MAX_NUMBER=0), the challenge
// endpoint returns the disabled sentinel instead of a puzzle; the solver then
// resolves to `null` and the sign-up flows attach no `captcha` (the redeem
// endpoints verify its absence as a no-op).
import { type PowChallenge, type PowSolution, powChallengeResponseSchema } from '@licio/shared';
import { client, parseResponse } from './api.js';
import { solvePowNumber } from './pow-solve.js';

// The pure solve loop lives in the dependency-free pow-solve.ts (the worker's
// ONLY import — keeping the worker chunk tiny); re-export it for callers/tests.
export { solvePowNumber } from './pow-solve.js';

/** Solve in a dedicated Web Worker; falls back to the main thread (with
 *  cooperative yielding) when workers are unavailable or fail to start. */
async function solveOffThread(challenge: PowChallenge): Promise<number> {
  if (typeof Worker !== 'undefined') {
    try {
      const worker = new Worker(new URL('./pow-captcha.worker.ts', import.meta.url), {
        type: 'module',
      });
      try {
        return await new Promise<number>((resolve, reject) => {
          worker.addEventListener(
            'message',
            (event: MessageEvent<{ ok: true; number: number } | { ok: false }>) => {
              if (event.data.ok) resolve(event.data.number);
              else reject(new Error('pow-captcha worker failed'));
            },
          );
          worker.addEventListener('error', () => reject(new Error('pow-captcha worker failed')));
          worker.postMessage({
            salt: challenge.salt,
            target: challenge.target,
            max_number: challenge.max_number,
          });
        });
      } finally {
        worker.terminate();
      }
    } catch {
      // Fall back to the main thread below.
    }
  }
  return solvePowNumber(challenge, { yieldEvery: 256 });
}

/** Fetch a challenge (or the disabled sentinel) from the BFF, zod-validated. */
export async function fetchPowChallenge(): Promise<PowChallenge | { disabled: true }> {
  const res = await client.v1.auth.captcha.challenge.$post();
  return parseResponse(res, powChallengeResponseSchema);
}

/** Fetch + solve one sign-up captcha token, or `null` when the gate is
 *  disabled (the operator opt-out) — the caller then attaches no `captcha`. */
export async function solveSignupCaptcha(): Promise<PowSolution | null> {
  const challenge = await fetchPowChallenge();
  if ('disabled' in challenge) return null;
  const number = await solveOffThread(challenge);
  return {
    challenge_id: challenge.challenge_id,
    salt: challenge.salt,
    target: challenge.target,
    max_number: challenge.max_number,
    signature: challenge.signature,
    expires_at: challenge.expires_at,
    number,
  };
}

// --- Prime-ahead cache (single-use) -----------------------------------------

let primed: Promise<PowSolution | null> | null = null;

/** Start solving in the background (idempotent).  Errors are swallowed here —
 *  `takeSignupCaptcha` retries with a fresh solve at submit time. */
export function primeSignupCaptcha(): void {
  if (primed === null) {
    const pending = solveSignupCaptcha();
    primed = pending;
    // Only clear the cache if THIS primed solve is still the current one — a
    // late rejection must not clobber a newer prime installed after a take.
    pending.catch(() => {
      if (primed === pending) primed = null;
    });
  }
}

/** Consume the primed token (or solve fresh); `null` ⇒ the gate is disabled and
 *  the caller sends no `captcha`.  Server tokens are single-use, so the cache
 *  empties on take and the next call solves anew. */
export async function takeSignupCaptcha(): Promise<PowSolution | null> {
  const pending = primed ?? solveSignupCaptcha();
  primed = null;
  try {
    return await pending;
  } catch {
    // The primed solve failed (offline at mount, transient 5xx): one fresh
    // attempt at submit time, surfacing ITS error to the caller.
    return solveSignupCaptcha();
  }
}

/** Drop any primed token (test-only reset; the retry path self-clears the
 *  cache via `takeSignupCaptcha`). */
export function resetSignupCaptcha(): void {
  primed = null;
}
