// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import { hashOneTimeCode } from '../codes.js';
import {
  canResend,
  EMAIL_OTP_TTL_MS,
  MAX_OTP_ATTEMPTS,
  RESEND_COOLDOWN_MS,
  startEmailLogin,
  startEmailVerification,
  verifyEmailFactor,
  verifyEmailLogin,
} from '../email-otp.js';
import { InMemoryEphemeralStore } from '../ephemeral-store.js';

const USER = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = 'attempt-xyz';

describe('email OTP login', () => {
  let now: number;
  let store: InMemoryEphemeralStore;

  beforeEach(() => {
    now = 1_700_000_000_000;
    store = new InMemoryEphemeralStore(() => now);
  });

  it('verifies a correct code once, then the code is single-use', async () => {
    const { code } = await startEmailLogin(store, ATTEMPT, USER, now);
    expect(await verifyEmailLogin(store, ATTEMPT, code, now)).toEqual({ ok: true, userId: USER });
    // Single-use: a second presentation finds no code.
    expect(await verifyEmailLogin(store, ATTEMPT, code, now)).toEqual({
      ok: false,
      reason: 'no_code',
    });
  });

  it('rejects a wrong code and invalidates after MAX_OTP_ATTEMPTS', async () => {
    await startEmailLogin(store, ATTEMPT, USER, now);
    for (let i = 0; i < MAX_OTP_ATTEMPTS - 1; i += 1) {
      expect((await verifyEmailLogin(store, ATTEMPT, 'WRONGAAA', now)).ok).toBe(false);
    }
    // The 5th failed attempt invalidates the code.
    expect(await verifyEmailLogin(store, ATTEMPT, 'WRONGAAA', now)).toEqual({
      ok: false,
      reason: 'too_many_attempts',
    });
    // Even a further attempt finds no code (it was invalidated).
    const afterInvalidation = await verifyEmailLogin(store, ATTEMPT, 'WRONGAAA', now);
    expect(afterInvalidation.ok).toBe(false);
    if (!afterInvalidation.ok) expect(afterInvalidation.reason).toBe('no_code');
  });

  it('rejects the code once the TTL has elapsed', async () => {
    const { code } = await startEmailLogin(store, ATTEMPT, USER, now);
    now += EMAIL_OTP_TTL_MS + 1;
    const result = await verifyEmailLogin(store, ATTEMPT, code, now);
    // Rejected: the store evicts at the TTL ('no_code'); the record-level guard
    // would report 'expired' for a store configured with a longer TTL.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(['expired', 'no_code']).toContain(result.reason);
  });

  it('does NOT extend the expiry when wrong guesses are made', async () => {
    await startEmailLogin(store, ATTEMPT, USER, now);
    // Three wrong guesses spread across the window each re-store the record…
    for (let i = 0; i < 3; i += 1) {
      now += 60_000;
      await verifyEmailLogin(store, ATTEMPT, 'NOPENOPE', now);
    }
    // …yet jumping just past the ORIGINAL 10-minute expiry still rejects: the
    // re-stores preserved the original lifetime rather than resetting it.
    now = 1_700_000_000_000 + EMAIL_OTP_TTL_MS + 1;
    const result = await verifyEmailLogin(store, ATTEMPT, 'NOPENOPE', now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(['expired', 'no_code']).toContain(result.reason);
  });

  it('rejects when no login was started for the attempt', async () => {
    expect(await verifyEmailLogin(store, 'never-started', 'ABCD2345', now)).toEqual({
      ok: false,
      reason: 'no_code',
    });
  });
});

describe('email factor verification (enroll)', () => {
  it('uses a per-user key and verifies the enrollment code', async () => {
    const now = 1_700_000_000_000;
    const store = new InMemoryEphemeralStore(() => now);
    const { code } = await startEmailVerification(store, USER, now);
    expect(await verifyEmailFactor(store, USER, code, now)).toEqual({ ok: true, userId: USER });
  });
});

describe('startEmailLogin stores only the hash', () => {
  it('never stores the plaintext code', async () => {
    const now = 1_700_000_000_000;
    const store = new InMemoryEphemeralStore(() => now);
    const { code } = await startEmailLogin(store, ATTEMPT, USER, now);
    const raw = (await store.get(`emaillogin:${ATTEMPT}`)) as string;
    expect(raw).toContain(hashOneTimeCode(code));
    expect(raw).not.toContain(code);
  });
});

describe('resend cooldown', () => {
  it('permits the first send, blocks within the cooldown, allows after it', async () => {
    let now = 1_700_000_000_000;
    const store = new InMemoryEphemeralStore(() => now);
    expect(await canResend(store, 'acctref', now)).toBe(true);
    expect(await canResend(store, 'acctref', now)).toBe(false);
    now += RESEND_COOLDOWN_MS + 1;
    expect(await canResend(store, 'acctref', now)).toBe(true);
  });
});
