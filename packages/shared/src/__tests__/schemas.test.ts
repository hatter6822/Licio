// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  accountMayHoldSession,
  accountStateSchema,
  healthResponseSchema,
} from '../schemas/index.js';

describe('healthResponseSchema', () => {
  it('should validate a correct health response', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('should reject an invalid status', () => {
    const result = healthResponseSchema.safeParse({
      status: 'bad',
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('should reject a missing timestamp', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
    });
    expect(result.success).toBe(false);
  });
});

describe('accountMayHoldSession (the one definition of "may hold a session")', () => {
  // The rule lived in five hand-written copies — the auth middleware,
  // `/auth/status`, the dev simulator, and three platform-roles resolvers — and
  // the resolvers were still `=== 'active'` after the middleware learned about
  // `restricted`.  Every call site now consults this, so pinning it here pins the
  // rule everywhere.
  it('admits exactly the session-bearing states', () => {
    expect(accountMayHoldSession('active')).toBe(true);
    expect(accountMayHoldSession('restricted')).toBe(true);
  });

  it('refuses everything else, INCLUDING states outside the wire vocabulary', () => {
    // `deleted` is carried by the identity store and deliberately absent from
    // `accountStateSchema`, so it can reach this predicate while being
    // unrepresentable on the wire — the reason the parameter is widened.
    for (const state of ['suspended', 'deactivated', 'deleted', '', 'ACTIVE', 'unknown']) {
      expect(accountMayHoldSession(state), `${state} must not hold a session`).toBe(false);
    }
    expect(accountMayHoldSession(null)).toBe(false);
    expect(accountMayHoldSession(undefined)).toBe(false);
  });

  it('fails CLOSED for every state the schema knows that it does not name', () => {
    // A state added to the vocabulary later is denied a session until someone
    // decides otherwise, rather than admitted by default.
    const admitted = accountStateSchema.options.filter((s) => accountMayHoldSession(s));
    expect(admitted.sort()).toEqual(['active', 'restricted']);
  });
});
