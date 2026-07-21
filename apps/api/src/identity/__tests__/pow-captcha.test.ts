// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sign-up proof-of-work CAPTCHA unit suite (WS-D bot-prevention layer 1):
// issue → solve → verify round trip, single-use consumption, expiry, HMAC
// tamper resistance, the disabled opt-out, and pressure-scaled difficulty.
import { describe, expect, it } from 'vitest';
import { InMemoryEphemeralStore } from '../ephemeral-store.js';
import {
  DEFAULT_SIGNUP_PRESSURE,
  issuePowChallenge,
  POW_CHALLENGE_TTL_MS,
  SignupPressure,
  solvePowChallengeSync,
  verifyPowSolution,
} from '../pow-captcha.js';

const SECRET = 'test-master-secret-at-least-32-characters-long';
const CONFIG = { maxNumber: 64 };

function fixedClock(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('pow-captcha issue → solve → verify', () => {
  it('round-trips: an issued challenge solves and verifies exactly once', async () => {
    const store = new InMemoryEphemeralStore();
    const challenge = await issuePowChallenge(store, SECRET, CONFIG);
    expect(challenge.algorithm).toBe('SHA-256');
    expect(challenge.max_number).toBe(64);

    const solution = solvePowChallengeSync(challenge);
    expect(solution.number).toBeGreaterThanOrEqual(0);
    expect(solution.number).toBeLessThanOrEqual(64);

    const first = await verifyPowSolution(store, SECRET, CONFIG, solution);
    expect(first).toEqual({ ok: true });

    // Single use: the same valid solution can never be redeemed twice.
    const replay = await verifyPowSolution(store, SECRET, CONFIG, solution);
    expect(replay).toEqual({ ok: false, code: 'captcha_invalid' });
  });

  it('requires a solution when the gate is enabled', async () => {
    const store = new InMemoryEphemeralStore();
    const verdict = await verifyPowSolution(store, SECRET, CONFIG, undefined);
    expect(verdict).toEqual({ ok: false, code: 'captcha_required' });
  });

  it('passes unconditionally when the gate is explicitly disabled (maxNumber 0)', async () => {
    const store = new InMemoryEphemeralStore();
    expect(await verifyPowSolution(store, SECRET, { maxNumber: 0 }, undefined)).toEqual({
      ok: true,
    });
  });

  it('rejects a wrong number without consuming the outstanding challenge', async () => {
    const store = new InMemoryEphemeralStore();
    const challenge = await issuePowChallenge(store, SECRET, CONFIG);
    const solution = solvePowChallengeSync(challenge);
    const wrong = { ...solution, number: (solution.number + 1) % (challenge.max_number + 1) };
    expect(await verifyPowSolution(store, SECRET, CONFIG, wrong)).toEqual({
      ok: false,
      code: 'captcha_invalid',
    });
    // The failed attempt did NOT burn the stored id: the real solve still lands.
    expect(await verifyPowSolution(store, SECRET, CONFIG, solution)).toEqual({ ok: true });
  });

  it('rejects a tampered work factor (HMAC binds every field)', async () => {
    const store = new InMemoryEphemeralStore();
    const challenge = await issuePowChallenge(store, SECRET, CONFIG);
    const solution = solvePowChallengeSync(challenge);
    // An attacker lowering max_number (or shifting expiry) breaks the HMAC.
    expect(await verifyPowSolution(store, SECRET, CONFIG, { ...solution, max_number: 1 })).toEqual({
      ok: false,
      code: 'captcha_invalid',
    });
    expect(
      await verifyPowSolution(store, SECRET, CONFIG, {
        ...solution,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ).toEqual({ ok: false, code: 'captcha_invalid' });
  });

  it('rejects a solution signed under a different master secret', async () => {
    const store = new InMemoryEphemeralStore();
    const challenge = await issuePowChallenge(
      store,
      'other-master-secret-32-characters-min!!',
      CONFIG,
    );
    const solution = solvePowChallengeSync(challenge);
    expect(await verifyPowSolution(store, SECRET, CONFIG, solution)).toEqual({
      ok: false,
      code: 'captcha_invalid',
    });
  });

  it('rejects an expired solution even when the store record survives', async () => {
    const clock = fixedClock(1_700_000_000_000);
    const store = new InMemoryEphemeralStore(clock.now);
    const challenge = await issuePowChallenge(store, SECRET, CONFIG, { now: clock.now });
    const solution = solvePowChallengeSync(challenge);
    clock.advance(POW_CHALLENGE_TTL_MS + 1);
    expect(await verifyPowSolution(store, SECRET, CONFIG, solution, clock.now)).toEqual({
      ok: false,
      code: 'captcha_invalid',
    });
  });

  it('rejects a never-issued (fabricated store id) tuple even with a valid digest', async () => {
    const store = new InMemoryEphemeralStore();
    const challenge = await issuePowChallenge(store, SECRET, CONFIG);
    const solution = solvePowChallengeSync(challenge);
    // Drop the issuance record (simulates expiry-by-TTL in the store).
    await store.delete(`powcap:${challenge.challenge_id}`);
    expect(await verifyPowSolution(store, SECRET, CONFIG, solution)).toEqual({
      ok: false,
      code: 'captcha_invalid',
    });
  });
});

describe('pressure-scaled difficulty (identity-free)', () => {
  it('doubles the work factor at each crossed issuance step and resets per window', async () => {
    const clock = fixedClock(0);
    const pressure = new SignupPressure(DEFAULT_SIGNUP_PRESSURE, clock.now);
    const store = new InMemoryEphemeralStore(clock.now);
    const maxAt = async () =>
      (await issuePowChallenge(store, SECRET, { maxNumber: 100 }, { now: clock.now, pressure }))
        .max_number;

    // Below the first step (30/window): base difficulty.
    expect(await maxAt()).toBe(100);
    for (let i = 0; i < 29; i += 1) pressure.record();
    // Crossing 30 → ×2; crossing 60 → ×4; crossing 120 → ×8.
    expect(await maxAt()).toBe(200);
    for (let i = 0; i < 29; i += 1) pressure.record();
    expect(await maxAt()).toBe(400);
    for (let i = 0; i < 60; i += 1) pressure.record();
    expect(await maxAt()).toBe(800);

    // A new window resets the counter to base difficulty.
    clock.advance(DEFAULT_SIGNUP_PRESSURE.windowMs + 1);
    expect(await maxAt()).toBe(100);
  });

  it('never exceeds the schema ceiling under extreme pressure', async () => {
    const pressure = new SignupPressure();
    for (let i = 0; i < 500; i += 1) pressure.record();
    const store = new InMemoryEphemeralStore();
    const challenge = await issuePowChallenge(
      store,
      SECRET,
      { maxNumber: 9_000_000 },
      { pressure },
    );
    expect(challenge.max_number).toBeLessThanOrEqual(10_000_000);
  });
});
