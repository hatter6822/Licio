// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit coverage for the governance KYC gate: segmentation is line-anchored
// (handler-body `c.get(...)` never truncates a segment), unguarded routes
// fail, allowlisted routes pass, stale allowlist entries fail, and the LIVE
// tree passes.
import { describe, expect, it } from 'vitest';
import {
  extractMutationRoutes,
  GOVERNANCE_ROUTE_FILES,
  runGovernanceKycGate,
} from './check-governance-kyc.js';

const guarded = `
export function createRoutes() {
  return new Hono()
    .post(
      '/rooms/:roomId/thing/vote',
      authMiddleware(),
      requireGovernanceEligibility(),
      async (c) => {
        const auth = c.get('auth');
        return c.json({ ok: true });
      },
    )
    .get('/rooms/:roomId/thing', async (c) => c.json({}));
}
`;

const handlerGuarded = `
export function createRoutes() {
  return new Hono()
    .post('/rooms/:roomId/other/vote', authMiddleware(), async (c) => {
      const auth = c.get('auth');
      const denial = await checkGovernanceEligibility(auth.userId);
      if (denial) return c.json({ error: denial }, 403);
      return c.json({ ok: true });
    });
}
`;

const unguarded = `
export function createRoutes() {
  return new Hono()
    // requireGovernanceEligibility mentioned ONLY in prose must not satisfy.
    .post('/rooms/:roomId/naked/vote', authMiddleware(), async (c) => {
      const auth = c.get('auth');
      return c.json({ ok: true });
    });
}
`;

const midLinePost = `
export function createRoutes() {
  return new Hono().post('/rooms/:roomId/sneaky/vote', authMiddleware(), (c) => c.json({}));
}
`;

const nonPostMutation = `
export function createRoutes() {
  return new Hono()
    .delete('/rooms/:roomId/thing/:id', authMiddleware(), async (c) => c.json({ ok: true }));
}
`;

const midLineDelete = `
export function createRoutes() {
  return new Hono().delete('/rooms/:roomId/sneaky/:id', authMiddleware(), (c) => c.json({}));
}
`;

describe('extractMutationRoutes', () => {
  it('keeps a segment intact across handler-body c.get(...) calls', () => {
    const routes = extractMutationRoutes('f.ts', guarded);
    expect(routes).toEqual([
      { file: 'f.ts', method: 'post', path: '/rooms/:roomId/thing/vote', guarded: true },
    ]);
  });

  it('accepts a handler-level checkGovernanceEligibility call as the guard', () => {
    expect(extractMutationRoutes('f.ts', handlerGuarded)[0]?.guarded).toBe(true);
  });

  it('flags an unguarded POST — a comment mention never satisfies', () => {
    expect(extractMutationRoutes('f.ts', unguarded)[0]?.guarded).toBe(false);
  });

  it('classifies non-POST mutation methods (PUT/PATCH/DELETE) too', () => {
    const routes = extractMutationRoutes('f.ts', nonPostMutation);
    expect(routes).toEqual([
      { file: 'f.ts', method: 'delete', path: '/rooms/:roomId/thing/:id', guarded: false },
    ]);
  });
});

describe('runGovernanceKycGate', () => {
  it('fails on an unguarded, un-allowlisted governance POST', () => {
    const issues = runGovernanceKycGate((relPath) =>
      relPath === GOVERNANCE_ROUTE_FILES[0] ? unguarded : 'export const nothing = 1;',
    );
    expect(issues.some((issue) => issue.includes('/rooms/:roomId/naked/vote'))).toBe(true);
    // Every real allowlist entry is stale against the synthetic tree.
    expect(issues.some((issue) => issue.includes('stale ALLOWLIST'))).toBe(true);
  });

  it('FAILS CLOSED on a mid-line `.post(` the line-anchored scan cannot see', () => {
    const issues = runGovernanceKycGate((relPath) =>
      relPath === GOVERNANCE_ROUTE_FILES[0] ? midLinePost : 'export const nothing = 1;',
    );
    // The raw-count cross-check catches the unclassifiable occurrence.
    expect(issues.some((issue) => issue.includes('not at line-start'))).toBe(true);
  });

  it('FAILS CLOSED on a mid-line non-POST mutation too (the per-verb cross-check)', () => {
    // Before the cross-check covered every verb, a mid-line `.delete(`/`.patch(`
    // evaded BOTH the line-anchored extraction and the POST-only raw count —
    // shipping ungated with a green gate.
    const issues = runGovernanceKycGate((relPath) =>
      relPath === GOVERNANCE_ROUTE_FILES[0] ? midLineDelete : 'export const nothing = 1;',
    );
    expect(
      issues.some((issue) => issue.includes('not at line-start') && issue.includes('`.delete(')),
    ).toBe(true);
  });

  it('flags an unguarded non-POST governance mutation (DELETE)', () => {
    const issues = runGovernanceKycGate((relPath) =>
      relPath === GOVERNANCE_ROUTE_FILES[0] ? nonPostMutation : 'export const nothing = 1;',
    );
    expect(issues.some((issue) => issue.includes('DELETE /rooms/:roomId/thing/:id'))).toBe(true);
  });

  it('passes the LIVE route tree (every mutation guarded or justified)', () => {
    expect(runGovernanceKycGate()).toEqual([]);
  });
});
