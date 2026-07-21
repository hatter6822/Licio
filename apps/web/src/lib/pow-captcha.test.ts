// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sign-up proof-of-work client suite (WS-D bot-prevention layer 1): the pure
// WebCrypto solve, the worker-less fallback path (jsdom has no Worker, so the
// main-thread branch runs here), the single-use prime/take cache, and the
// cross-check pinning the worker's dependency-free digest-input format to the
// shared wire contract.
import { powDigestInput } from '@licio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientState } from './api.js';
import {
  primeSignupCaptcha,
  resetSignupCaptcha,
  solvePowNumber,
  solveSignupCaptcha,
  takeSignupCaptcha,
} from './pow-captcha.js';
import { powSolveDigestInput } from './pow-solve.js';

const realFetch = globalThis.fetch;

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function buildChallenge(secret: number, maxNumber = 16): Promise<Record<string, unknown>> {
  const salt = 'a'.repeat(32);
  return {
    algorithm: 'SHA-256',
    challenge_id: 'b'.repeat(32),
    salt,
    target: await sha256Hex(`${salt}.${secret}`),
    max_number: maxNumber,
    signature: 'c'.repeat(64),
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  };
}

function mockChallengeEndpoint(challenge: Record<string, unknown>): { count: () => number } {
  let issued = 0;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/csrf-token')) {
      return new Response(JSON.stringify({ token: 'csrf-token' }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/v1/auth/captcha/challenge')) {
      issued += 1;
      return new Response(JSON.stringify(challenge), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no route' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { count: () => issued };
}

/** The challenge endpoint answers with the disabled sentinel (gate off). */
function mockDisabledEndpoint(): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/csrf-token')) {
      return new Response(JSON.stringify({ token: 'csrf-token' }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ disabled: true }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  resetApiClientState();
  resetSignupCaptcha();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  resetSignupCaptcha();
});

describe('powSolveDigestInput (worker-isolation cross-check)', () => {
  it('matches the shared powDigestInput format exactly — the two can never drift', () => {
    for (const [salt, n] of [
      ['a'.repeat(32), 0],
      ['0123456789abcdef0123456789abcdef', 7],
      ['f'.repeat(32), 39_999],
    ] as const) {
      expect(powSolveDigestInput(salt, n)).toBe(powDigestInput(salt, n));
    }
  });
});

describe('solvePowNumber', () => {
  it('finds the secret by brute force (with cooperative yielding)', async () => {
    const salt = 'f'.repeat(32);
    const target = await sha256Hex(`${salt}.7`);
    await expect(solvePowNumber({ salt, target, max_number: 16 }, { yieldEvery: 4 })).resolves.toBe(
      7,
    );
  });

  it('rejects when no number in range reproduces the target', async () => {
    await expect(
      solvePowNumber({ salt: 'f'.repeat(32), target: '0'.repeat(64), max_number: 8 }),
    ).rejects.toThrow(/no solution/);
  });
});

describe('solveSignupCaptcha (fetch → solve → tuple)', () => {
  it('returns the full solved tuple for a server challenge', async () => {
    mockChallengeEndpoint(await buildChallenge(5));
    const solution = await solveSignupCaptcha();
    expect(solution).not.toBeNull();
    expect(solution?.number).toBe(5);
    expect(solution?.challenge_id).toBe('b'.repeat(32));
    expect(solution?.max_number).toBe(16);
  });

  it('returns null when the gate is DISABLED (the disabled sentinel)', async () => {
    // The operator opt-out (SIGNUP_POW_MAX_NUMBER=0): the endpoint answers with
    // { disabled: true } and the solver resolves to null so the caller sends
    // no captcha — never a 500 or a schema failure.
    mockDisabledEndpoint();
    await expect(solveSignupCaptcha()).resolves.toBeNull();
  });
});

describe('prime/take single-use cache', () => {
  it('primes once, serves the primed solve, then solves fresh on the next take', async () => {
    const endpoint = mockChallengeEndpoint(await buildChallenge(2));
    primeSignupCaptcha();
    primeSignupCaptcha(); // idempotent — still one outstanding solve
    const first = await takeSignupCaptcha();
    expect(first?.number).toBe(2);
    expect(endpoint.count()).toBe(1);

    // The cache emptied on take: the next take fetches a NEW challenge.
    const second = await takeSignupCaptcha();
    expect(second?.number).toBe(2);
    expect(endpoint.count()).toBe(2);
  });

  it('recovers at take time when the primed solve failed (offline at mount)', async () => {
    // First: no route (prime fails); then a working endpoint for the take.
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'http_503', message: 'down' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    primeSignupCaptcha();
    // Allow the primed rejection to settle (it is swallowed internally).
    await new Promise((resolve) => setTimeout(resolve, 0));

    mockChallengeEndpoint(await buildChallenge(4));
    resetApiClientState();
    const solution = await takeSignupCaptcha();
    expect(solution?.number).toBe(4);
  });

  it('take returns null when the gate is disabled', async () => {
    mockDisabledEndpoint();
    await expect(takeSignupCaptcha()).resolves.toBeNull();
  });
});
