// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared sign-up proof-of-work helper for route tests: fetches a REAL challenge
// from the live app and brute-forces it (node:crypto).  Suites run the same
// issue → solve → verify → single-use flow production uses, at the tiny test
// work factor their IdentityConfig pins.
import { type PowSolution, powChallengeSchema } from '@licio/shared';
import { solvePowChallengeSync } from '../identity/pow-captcha.js';

/** Fetch + solve one sign-up captcha against the app under test. */
export async function signupCaptcha(app: {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
}): Promise<PowSolution> {
  const res = await app.request('/v1/auth/captcha/challenge', { method: 'POST' });
  if (res.status !== 200) {
    throw new Error(`signupCaptcha: challenge issuance failed with ${res.status}`);
  }
  const challenge = powChallengeSchema.parse(await res.json());
  return solvePowChallengeSync(challenge);
}
