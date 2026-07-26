// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit coverage for the governance KYC gate.  Routes come from the PARSE, so a
// registration is found wherever it sits, the guard is attributed by
// CONTAINMENT rather than by text proximity, and the only fail-closed case left
// is a route path the gate genuinely cannot read.
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

const viaOn = `
export function createRoutes() {
  return new Hono().on('POST', '/rooms/:roomId/on/vote', authMiddleware(), (c) => c.json({}));
}
`;

const dynamicPath = `
export function createRoutes() {
  return new Hono().post(buildPath('vote'), authMiddleware(), (c) => c.json({}));
}
`;

const notARoute = `
export function createRoutes() {
  return new Hono()
    .post('/rooms/:roomId/thing/vote', requireGovernanceEligibility(), async (c) => {
      await db.delete(rows);
      cache.delete('key');
      return c.json({ ok: true });
    });
}
`;

/** A guard on the FIRST route must not vouch for the second. */
const guardLeak = `
export function createRoutes() {
  return new Hono()
    .post('/rooms/:roomId/a/vote', requireGovernanceEligibility(), (c) => c.json({}))
    .post('/rooms/:roomId/b/vote', authMiddleware(), (c) => c.json({}));
}
`;

/** A chain longer than any bounded receiver walk would follow. */
const longChain = `
export function createRoutes() {
  return new Hono()
${Array.from({ length: 40 }, (_, i) => `    .get('/read/${i}', (c) => c.json({}))`).join('\n')}
    .post('/rooms/:roomId/last/vote', authMiddleware(), (c) => c.json({}));
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

  it.each([
    ['a mid-line POST', midLinePost, 'POST /rooms/:roomId/sneaky/vote'],
    ['a mid-line DELETE', midLineDelete, 'DELETE /rooms/:roomId/sneaky/:id'],
    ['an `.on(METHOD, …)` registration', viaOn, 'POST /rooms/:roomId/on/vote'],
  ])('classifies %s rather than rejecting how it is written', (_label, source, expected) => {
    // These used to be reported as "not at line-start" — a formatting complaint
    // standing in for the real finding, because the scan could not see the
    // route at all.  `.on('POST', …)` was invisible to BOTH the extraction and
    // the raw-count cross-check, so it could ship ungated with a green gate.
    const issues = runGovernanceKycGate((relPath) =>
      relPath === GOVERNANCE_ROUTE_FILES[0] ? source : 'export const nothing = 1;',
    );
    expect(issues.some((issue) => issue.includes(expected))).toBe(true);
    expect(issues.some((issue) => issue.includes('line-start'))).toBe(false);
  });

  it('FAILS CLOSED on a route path it cannot read', () => {
    // The one place the discipline is still needed: a mutation registered on a
    // router with a computed path cannot be matched to a guard or an allowlist.
    const issues = runGovernanceKycGate((relPath) =>
      relPath === GOVERNANCE_ROUTE_FILES[0] ? dynamicPath : 'export const nothing = 1;',
    );
    expect(issues.some((issue) => issue.includes('not a static'))).toBe(true);
  });

  it('does not take a non-router `.delete(` for a route', () => {
    // `db.delete(rows)` and `cache.delete('key')` are ordinary calls; only a
    // receiver chain rooting at `new Hono()` registers a route.
    const issues = runGovernanceKycGate((relPath) =>
      relPath === GOVERNANCE_ROUTE_FILES[0] ? notARoute : 'export const nothing = 1;',
    );
    expect(issues.some((issue) => issue.startsWith(GOVERNANCE_ROUTE_FILES[0]))).toBe(false);
  });

  it("does not let one route's guard vouch for the next", () => {
    const issues = runGovernanceKycGate((relPath) =>
      relPath === GOVERNANCE_ROUTE_FILES[0] ? guardLeak : 'export const nothing = 1;',
    );
    expect(issues.some((issue) => issue.includes('POST /rooms/:roomId/b/vote'))).toBe(true);
    expect(issues.some((issue) => issue.includes('POST /rooms/:roomId/a/vote'))).toBe(false);
  });

  it('sees a route at the END of a long chain', () => {
    // A Hono chain nests each link inside the one before it, so the receiver of
    // the forty-first registration is forty calls deep.  Bounding that walk
    // silently stopped recognising routes past the limit — the live tree
    // reported 11 of treasury-governance.ts's 19, and only the allowlist's
    // stale-entry discipline exposed it.
    const issues = runGovernanceKycGate((relPath) =>
      relPath === GOVERNANCE_ROUTE_FILES[0] ? longChain : 'export const nothing = 1;',
    );
    expect(issues.some((issue) => issue.includes('POST /rooms/:roomId/last/vote'))).toBe(true);
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
