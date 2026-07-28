// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit coverage for the governance KYC gate.  Routes come from the PARSE, so a
// registration is found wherever it sits, the guard is attributed by
// CONTAINMENT rather than by text proximity, and the only fail-closed case left
// is a route path the gate genuinely cannot read.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractMutationRoutes,
  GOVERNANCE_ROUTE_FILES,
  isTypeScriptSource,
  NON_GOVERNANCE_ROUTES,
  runGovernanceKycGate,
  trackedApiSources,
} from './check-governance-kyc.js';

const ROOT = resolve(import.meta.dirname, '..');

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

describe('the POLARITY of the eligibility verdict', () => {
  // `checkGovernanceEligibility` resolves to `null` for an ELIGIBLE member and
  // a denial for an ineligible one, so "some branch returns" is not the
  // property — the branch that returns has to be the DENIAL'S.  Reading the
  // shape without the polarity accepted a route that refused everybody who was
  // allowed and let everybody who was not straight through.
  const route = (guard: string): string => `
const app = new Hono();
app.post('/rooms/:roomId/governance/vote', async (c) => {
  const denial = await checkGovernanceEligibility(c.get('userId'));
  ${guard}
  return c.json(await castVote());
});`;

  it.each([
    ['if (denial) return', 'if (denial) return c.json(denial, 403);'],
    ['if (denial !== null) return', 'if (denial !== null) return c.json(denial, 403);'],
    ['if (denial != null) throw', 'if (denial != null) throw new HTTPException(403);'],
    ['a ternary on the verdict', 'if (denial ? true : false) return c.json(denial, 403);'],
    ['returning the verdict itself', 'if (true) return denial ?? c.json(await castVote());'],
  ])('accepts %s — the DENIED are refused', (_label, guard) => {
    expect(extractMutationRoutes('f.ts', route(guard))[0]?.guarded).toBe(true);
  });

  it.each([
    ['if (!denial) return', 'if (!denial) return c.json({}, 403);'],
    ['if (denial === null) return', 'if (denial === null) return c.json({}, 403);'],
    ['if (denial == null) return', 'if (denial == null) return c.json({}, 403);'],
    [
      'refusing in the ELSE of a truthy test',
      'if (denial) { log(denial); } else { return c.json({}, 403); }',
    ],
  ])('rejects %s — it refuses the ELIGIBLE', (_label, guard) => {
    expect(extractMutationRoutes('f.ts', route(guard))[0]?.guarded).toBe(false);
  });

  it.each([
    ['a swapped returned ternary', 'return denial ? c.json(await castVote()) : c.json({}, 403);'],
    ['a negated swapped ternary', 'return !denial ? c.json({}, 403) : c.json(await castVote());'],
  ])('rejects %s — the verdict only SELECTED between two other values', (_label, guard) => {
    // The polarity rule reaches an `if`, but a returned ternary hands back one
    // of two expressions and which of them refuses is not something a
    // structural gate can read.  Letting the "returning the verdict refuses"
    // rule vouch for it accepted a route that admitted exactly the members it
    // should have turned away — the original defect, one position along.  So an
    // ambiguous spelling is rejected and the clear `if (denial) return …` form
    // is what passes.
    expect(extractMutationRoutes('f.ts', route(guard))[0]?.guarded).toBe(false);
  });

  it.each([
    ['&& with another condition', 'if (denial && shouldEnforce) return c.json(denial, 403);'],
  ])('rejects %s — a truthy denial need not reach the refusal', (_label, guard) => {
    // With `shouldEnforce` false an ineligible member walks past a branch that
    // looks exactly like a guard.  `||` and `??` DO carry the implication —
    // both are truthy whenever the denial is — so only `&&` refuses here.
    expect(extractMutationRoutes('f.ts', route(guard))[0]?.guarded).toBe(false);
  });

  it.each([
    ['|| with another condition', 'if (denial || alsoBlocked) return c.json(denial, 403);'],
    ['&& with a literal true', 'if (denial && true) return c.json(denial, 403);'],
  ])('accepts %s', (_label, guard) => {
    expect(extractMutationRoutes('f.ts', route(guard))[0]?.guarded).toBe(true);
  });

  it('rejects a branch that exits only on SOME paths', () => {
    // `if (denial) { if (shouldEnforce) return … }` refuses only when the inner
    // condition holds, so the presence of a return in the branch proves
    // nothing — the refusal has to dominate.
    const guard = 'if (denial) { if (shouldEnforce) return c.json(denial, 403); }';
    expect(extractMutationRoutes('f.ts', route(guard))[0]?.guarded).toBe(false);
  });

  it('accepts a branch where BOTH paths exit', () => {
    const guard =
      'if (denial) { if (x) return c.json(denial, 403); else throw new HTTPException(403); }';
    expect(extractMutationRoutes('f.ts', route(guard))[0]?.guarded).toBe(true);
  });

  it('rejects a branch whose only return is inside a nested callback', () => {
    // `if (denial) { const f = () => { return 1; }; }` declares a callback and
    // exits nothing, so a flat walk read a branch that falls straight through
    // as a refusal.
    const guard = 'if (denial) { const f = () => { return 1; }; log(f); }';
    expect(extractMutationRoutes('f.ts', route(guard))[0]?.guarded).toBe(false);
  });

  it('rejects a verdict that is bound and never consulted', () => {
    const src = `
const app = new Hono();
app.post('/rooms/:roomId/governance/vote', async (c) => {
  const ignored = await checkGovernanceEligibility(c.get('userId'));
  return c.json(await castVote());
});`;
    expect(extractMutationRoutes('f.ts', src)[0]?.guarded).toBe(false);
  });
});

describe('WHERE the refusal sits', () => {
  it('rejects a refusal that comes after the mutation', () => {
    // The verdict is checked, with the right polarity, in the right branch —
    // and the vote is already persisted when the ineligible member is turned
    // away.  A guard that refuses nothing that has not already happened is not
    // a guard, so existence was never the whole property.
    const src = `
const app = new Hono();
app.post('/rooms/:roomId/governance/vote', async (c) => {
  const denial = await checkGovernanceEligibility(c.get('userId'));
  await castVote();
  if (denial) return c.json(denial, 403);
  return c.json({ ok: true });
});`;
    expect(extractMutationRoutes('f.ts', src)[0]?.guarded).toBe(false);
  });

  it('accepts synchronous reads before the refusal', () => {
    // The decidable form of "the refusal dominates the mutations" is that
    // nothing else is AWAITED in between.  Real handlers read the auth context
    // and the validated params first, and none of that is asynchronous.
    const src = `
const app = new Hono();
app.post('/rooms/:roomId/governance/vote', async (c) => {
  const auth = requireAuth(c);
  const roomId = c.req.valid('param').roomId;
  const denial = await checkGovernanceEligibility(auth.userId);
  if (denial) return c.json(denial, 403);
  return c.json(await castVote(roomId));
});`;
    expect(extractMutationRoutes('f.ts', src)[0]?.guarded).toBe(true);
  });
});

describe('the guard is resolved, not matched by name', () => {
  it('rejects a LOCAL function that merely shares the name', () => {
    // A fail-closed gate satisfied by any function called
    // `checkGovernanceEligibility` is satisfied by one that returns nothing.
    const src = `
const app = new Hono();
function checkGovernanceEligibility(id) { return null; }
app.post('/rooms/:roomId/governance/vote', async (c) => {
  const denial = await checkGovernanceEligibility(c.get('userId'));
  if (denial) return c.json(denial, 403);
  return c.json(await castVote());
});`;
    expect(extractMutationRoutes('f.ts', src)[0]?.guarded).toBe(false);
  });

  it('rejects a same-named guard imported from ANOTHER module', () => {
    // Accepting any import meant `from './fake.js'` certified a route as
    // guarded.  The import's SOURCE is what makes it the guard.
    const src = `
import { checkGovernanceEligibility } from './fake.js';
const app = new Hono();
app.post('/rooms/:roomId/governance/vote', async (c) => {
  const denial = await checkGovernanceEligibility(c.get('userId'));
  if (denial) return c.json(denial, 403);
  return c.json(await castVote());
});`;
    expect(extractMutationRoutes('f.ts', src)[0]?.guarded).toBe(false);
  });

  it('accepts the IMPORTED guard, which is how every real route uses it', () => {
    // An import specifier is a declaration in the file too, so the test is
    // what KIND it is — not merely whether one exists.
    const src = `
import { checkGovernanceEligibility } from '../governance/eligibility.js';
const app = new Hono();
app.post('/rooms/:roomId/governance/vote', async (c) => {
  const denial = await checkGovernanceEligibility(c.get('userId'));
  if (denial) return c.json(denial, 403);
  return c.json(await castVote());
});`;
    expect(extractMutationRoutes('f.ts', src)[0]?.guarded).toBe(true);
  });
});

describe('a handler passed BY NAME', () => {
  it('reads the function the identifier denotes', () => {
    // Walking only the identifier saw an empty body, so a correctly guarded
    // route was reported unguarded — a gate blocking valid code.
    const src = `
const app = new Hono();
async function handler(c) {
  const denial = await checkGovernanceEligibility(c.get('userId'));
  if (denial) return c.json(denial, 403);
  return c.json(await castVote());
}
app.post('/rooms/:roomId/governance/vote', handler);`;
    expect(extractMutationRoutes('f.ts', src)[0]?.guarded).toBe(true);
  });

  it('still reports a named handler with NO guard', () => {
    const src = `
const app = new Hono();
async function handler(c) { return c.json(await castVote()); }
app.post('/rooms/:roomId/governance/vote', handler);`;
    expect(extractMutationRoutes('f.ts', src)[0]?.guarded).toBe(false);
  });
});

describe('every route-registering file is CLASSIFIED', () => {
  const readRepo = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf-8');

  /** The repository, with some files swapped for or added as fixtures. */
  const withFiles =
    (files: Readonly<Record<string, string>>) =>
    (rel: string): string =>
      files[rel] ?? readRepo(rel);

  const live = trackedApiSources();

  // The corpus is no longer a WALK, so none of these mount shapes has to be
  // modelled: a file that registers a route is in it however its router is
  // reached, or never reached at all.  Each of these once needed its own rule.
  it.each([
    ['a NAMED import', "import { make } from './x.js';\nexport const r = make();"],
    ['a DEFAULT import', "import make from './x.js';\nexport const r = make();"],
    ['a NAMESPACE import', "import * as x from './x.js';\nexport const r = x.make();"],
    ['a local wrapper', "import { make } from './x.js';\nfunction wrap() { return make(); }"],
    ['an imported wrapper', "import { wrap } from './w.js';\nexport const r = wrap();"],
    ['no mount at all', '// nothing mounts this file'],
  ])('bites on a file registering a mutation, reached through %s', (_label, preamble) => {
    const fixture = `${preamble}
const app = new Hono();
app.post('/rooms/:roomId/governance/vote', async (c) => c.json(await castVote()));`;
    const issues = runGovernanceKycGate(withFiles({ 'apps/api/src/brand-new.ts': fixture }), [
      ...live,
      'apps/api/src/brand-new.ts',
    ]);
    expect(issues).toContainEqual(expect.stringContaining('brand-new.ts REGISTERS a mutation'));
  });

  it('does NOT ask a read-only file to be classified', () => {
    // A surface with no mutation cannot carry participation, so requiring an
    // entry for it would be a list that grows without adding a guarantee.
    const fixture = `
const app = new Hono();
app.get('/rooms/:roomId/governance', async (c) => c.json(await read()));`;
    const issues = runGovernanceKycGate(withFiles({ 'apps/api/src/read-only.ts': fixture }), [
      ...live,
      'apps/api/src/read-only.ts',
    ]);
    expect(issues).toEqual([]);
  });

  it('reports a stale entry for a file that registers no mutation', () => {
    const [stale] = Object.keys(NON_GOVERNANCE_ROUTES);
    const issues = runGovernanceKycGate(
      withFiles({ [String(stale)]: '// every route removed\nexport const nothing = 1;' }),
      live,
    );
    expect(issues).toContainEqual(
      expect.stringContaining(`stale NON_GOVERNANCE_ROUTES entry '${stale}'`),
    );
  });

  it('classifies every route-registering file in the repository', () => {
    const issues = runGovernanceKycGate();
    expect(issues).toEqual([]);
  });

  it.each([
    // Three files NOTHING reached before: the walk started at the production
    // composition root, and these are mounted by the development boot and by
    // `e2e-server.ts`.
    ['the DEV-only simulator surface', 'apps/api/src/simulator/routes.ts'],
    ['the E2E-only session minter', 'apps/api/src/routes/test-auth.ts'],
    ['the E2E-only wallet signer', 'apps/api/src/routes/test-wallet.ts'],
    // …and the ones the walk did reach, which must not regress.
    ['a router outside routes/', 'apps/api/src/lcap/routes.ts'],
    ['a sub-router of a mounted module', 'apps/api/src/routes/auth-mfa.ts'],
    ['a sub-router two mounts deep', 'apps/api/src/routes/events-admin.ts'],
  ])('covers %s', (_label, file) => {
    expect(trackedApiSources()).toContain(file);
    expect(
      GOVERNANCE_ROUTE_FILES.includes(file as (typeof GOVERNANCE_ROUTE_FILES)[number]) ||
        NON_GOVERNANCE_ROUTES[file] !== undefined,
    ).toBe(true);
  });

  it.each(['apps/api/src/app.ts', 'apps/api/src/index.ts', 'apps/api/src/e2e-server.ts'])(
    'enumerates the top-level composition file %s',
    (file) => {
      // `apps/api/src/**` + `/*.ts` required at least one INTERMEDIATE directory
      // in a git pathspec, so these three sat silently outside the corpus — the
      // exact failure the enumeration replaced a mount walk to prevent, in the
      // enumeration itself.
      expect(live).toContain(file);
    },
  );

  it.each([
    ['a .tsx route module', 'apps/api/src/routes/new-governance.tsx'],
    ['a plain .ts module', 'apps/api/src/routes/new-governance.ts'],
  ])('judges %s once it is in the corpus', (_label, path) => {
    // A route module written as `.tsx` registers a Hono POST exactly as its
    // `.ts` sibling does.
    const issues = runGovernanceKycGate(
      (rel) =>
        rel === path
          ? `
const app = new Hono();
app.post('/rooms/:roomId/governance/vote', async (c) => c.json(await castVote()));`
          : readRepo(rel),
      [...live, path],
    );
    expect(issues).toContainEqual(expect.stringContaining(`${path} REGISTERS`));
  });

  it.each([
    ['a `.test.ts` sibling', './secret.test.js', 'apps/api/src/routes/secret.test.ts'],
    ['a `__tests__/` module', './__tests__/secret.js', 'apps/api/src/routes/__tests__/secret.ts'],
  ])('reports a production import of %s', (_label, specifier, target) => {
    // Excluding tests from the corpus is right — they declare routers of their
    // own and serve nothing — but only while nothing production-reachable
    // imports one.  Since the corpus stopped tracking mount reachability, such
    // a module would be neither scanned nor declared, silently.
    const v1 = readRepo('apps/api/src/routes/v1.ts')
      .replace(
        'import { createAuthRoutes }',
        `import { createSecretRoutes } from '${specifier}';\nimport { createAuthRoutes }`,
      )
      .replace(
        ".route('/auth', createAuthRoutes())",
        ".route('/secret', createSecretRoutes())\n      .route('/auth', createAuthRoutes())",
      );
    const issues = runGovernanceKycGate(
      withFiles({
        'apps/api/src/routes/v1.ts': v1,
        [target]: 'export const createSecretRoutes = () => new Hono();',
      }),
      live,
    );
    expect(issues).toContainEqual(expect.stringContaining('a TEST path the gate deliberately'));
  });

  it.each([
    ['a dynamic import', "(await import('./secret.test.js')).createSecretRoutes()"],
    ['a bare dynamic import', "await import('./secret.test.js')"],
    ['require', "require('./secret.test.js')"],
    // Every EMIT extension, since the gate accepts `.mts`/`.cts` sources.
    ['an .mjs specifier', "(await import('./secret.test.mjs')).createSecretRoutes()"],
    ['a .cjs specifier', "require('./secret.test.cjs')"],
  ])('reports %s of a test path', (_label, expression) => {
    // Read from the PARSE: a regex over `from '…'` saw none of these, so a
    // route module mounted that way stayed unjudged.
    const v1 = readRepo('apps/api/src/routes/v1.ts').replace(
      ".route('/auth', createAuthRoutes())",
      `.route('/secret', ${expression})\n      .route('/auth', createAuthRoutes())`,
    );
    const issues = runGovernanceKycGate(
      withFiles({
        'apps/api/src/routes/v1.ts': v1,
        'apps/api/src/routes/secret.test.ts': 'export const createSecretRoutes = () => new Hono();',
        'apps/api/src/routes/secret.test.mts':
          'export const createSecretRoutes = () => new Hono();',
        'apps/api/src/routes/secret.test.cts':
          'export const createSecretRoutes = () => new Hono();',
      }),
      live,
    );
    expect(issues).toContainEqual(expect.stringContaining('a TEST path the gate deliberately'));
  });

  it('reports a BOUND CommonJS loader of a test path', () => {
    // `require.bind(null)` is the native loader with a `this` nobody reads.
    const v1 = readRepo('apps/api/src/routes/v1.ts').replace(
      'import { createAuthRoutes }',
      "const load = require.bind(null);\nconst m = load('./secret.test.cjs');\nimport { createAuthRoutes }",
    );
    const issues = runGovernanceKycGate(
      withFiles({
        'apps/api/src/routes/v1.ts': v1,
        'apps/api/src/routes/secret.test.cts':
          'export const createSecretRoutes = () => new Hono();',
      }),
      live,
    );
    expect(issues).toContainEqual(expect.stringContaining('a TEST path the gate deliberately'));
  });

  it('reports a dynamic import whose SPECIFIER is an immutable alias', () => {
    const v1 = readRepo('apps/api/src/routes/v1.ts').replace(
      'import { createAuthRoutes }',
      "const target = './secret.test.js';\nconst m = import(target);\nimport { createAuthRoutes }",
    );
    const issues = runGovernanceKycGate(
      withFiles({
        'apps/api/src/routes/v1.ts': v1,
        'apps/api/src/routes/secret.test.ts': 'export const createSecretRoutes = () => new Hono();',
      }),
      live,
    );
    expect(issues).toContainEqual(expect.stringContaining('a TEST path the gate deliberately'));
  });

  it('does NOT report a SHADOWED `require`, which loads nothing', () => {
    // A local helper named `require` loads no module; reporting it would be a
    // security gate blocking valid code.
    const v1 = readRepo('apps/api/src/routes/v1.ts').replace(
      'import { createAuthRoutes }',
      "function require(p) { return registry[p]; }\nconst m = require('./secret.test.js');\nimport { createAuthRoutes }",
    );
    const issues = runGovernanceKycGate(
      withFiles({
        'apps/api/src/routes/v1.ts': v1,
        'apps/api/src/routes/secret.test.ts': 'export const createSecretRoutes = () => new Hono();',
      }),
      live,
    );
    expect(issues).not.toContainEqual(expect.stringContaining('a TEST path the gate deliberately'));
  });

  it('reports an ALIASED require of a test path', () => {
    // Read from what the callee BINDS TO, not from how it is spelled.
    const v1 = readRepo('apps/api/src/routes/v1.ts').replace(
      'import { createAuthRoutes }',
      "const load = require;\nconst secret = load('./secret.test.cjs');\nimport { createAuthRoutes }",
    );
    const issues = runGovernanceKycGate(
      withFiles({
        'apps/api/src/routes/v1.ts': v1,
        'apps/api/src/routes/secret.test.cts':
          'export const createSecretRoutes = () => new Hono();',
      }),
      live,
    );
    expect(issues).toContainEqual(expect.stringContaining('a TEST path the gate deliberately'));
  });

  it.each([
    ['a type-only declaration', "import type { Fixture } from './secret.test.js';"],
    ['per-specifier type-only', "import { type Fixture } from './secret.test.js';"],
    ['a type-only re-export', "export type { Fixture } from './secret.test.js';"],
  ])('does NOT report %s — it is erased and mounts nothing', (_label, statement) => {
    // Blocking CI over a module the build never loads is the failure direction
    // that gets a gate switched off.
    const v1 = readRepo('apps/api/src/routes/v1.ts').replace(
      'import { createAuthRoutes }',
      `${statement}\nimport { createAuthRoutes }`,
    );
    const issues = runGovernanceKycGate(
      withFiles({
        'apps/api/src/routes/v1.ts': v1,
        'apps/api/src/routes/secret.test.ts': 'export type Fixture = { a: 1 };',
      }),
      live,
    );
    expect(issues).not.toContainEqual(expect.stringContaining('a TEST path the gate deliberately'));
  });

  it('still reports a VALUE import beside a type-only one', () => {
    const v1 = readRepo('apps/api/src/routes/v1.ts').replace(
      'import { createAuthRoutes }',
      "import make, { type Fixture } from './secret.test.js';\nimport { createAuthRoutes }",
    );
    const issues = runGovernanceKycGate(
      withFiles({
        'apps/api/src/routes/v1.ts': v1,
        'apps/api/src/routes/secret.test.ts': 'export default () => new Hono();',
      }),
      live,
    );
    expect(issues).toContainEqual(expect.stringContaining('a TEST path the gate deliberately'));
  });

  it("reports TypeScript's `import x = require(…)` of a test path", () => {
    // The specifier hides in an `ExternalModuleReference`, so it belongs to
    // neither the declaration nor the call shape.
    const v1 = readRepo('apps/api/src/routes/v1.ts').replace(
      'import { createAuthRoutes }',
      "import secret = require('./__tests__/secret.cjs');\nimport { createAuthRoutes }",
    );
    const issues = runGovernanceKycGate(
      withFiles({
        'apps/api/src/routes/v1.ts': v1,
        'apps/api/src/routes/__tests__/secret.cts': 'export const x = 1;',
      }),
      live,
    );
    expect(issues).toContainEqual(expect.stringContaining('a TEST path the gate deliberately'));
  });

  it('does not report an ordinary relative import', () => {
    expect(runGovernanceKycGate()).toEqual([]);
  });

  it.each([
    ['types.d.ts', false],
    ['types.d.mts', false],
    ['types.d.cts', false],
    ['routes.ts', true],
    ['routes.tsx', true],
    ['routes.mts', true],
  ])('takes %s as a source: %s — a declaration file is erased whole', (name, wanted) => {
    // Scanning a declaration file as runtime code reported a rename the build
    // never needs; `.d.mts` and `.d.cts` are as erased as `.d.ts`.
    expect(isTypeScriptSource(`apps/api/src/${name}`)).toBe(wanted);
  });

  it('enumerates EVERY TypeScript source extension, not just `.ts`', () => {
    // Accepting only names ending in `.ts` dropped a `.tsx` route module — the
    // same completeness hole as the pathspec, one filter along.  Asserted on
    // the enumeration itself, since that is where the filter lives.
    const walkDir = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
        const at = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') out.push(...walkDir(at));
        } else out.push(at);
      }
      return out;
    };
    const onDisk = walkDir('apps/api/src');
    const sources = (each: string): boolean =>
      /\.[cm]?tsx?$/.test(each) &&
      !each.endsWith('.d.ts') &&
      !/\.test\.[cm]?tsx?$/.test(each) &&
      !each.includes('/__tests__/');
    expect([...live].sort()).toEqual(onDisk.filter(sources).sort());
    // …and the exclusions are exactly declarations and tests, nothing else.
    expect(live.filter((each) => each.endsWith('.d.ts'))).toEqual([]);
    expect(live.filter((each) => /\.test\.[cm]?tsx?$/.test(each))).toEqual([]);
  });

  it('enumerates the API tree, so nothing above passes vacuously', () => {
    expect(live.length).toBeGreaterThan(200);
    expect(live.every((each) => each.startsWith('apps/api/src/'))).toBe(true);
    // Tests declare routers of their own and serve nothing.
    expect(
      live.filter((each) => each.endsWith('.test.ts') || each.includes('/__tests__/')),
    ).toEqual([]);
    // …and the exclusion is not so broad that it drops real sources.  The
    // comparison walks the FILESYSTEM rather than asking git with the same
    // pathspec: a corpus checked against its own enumeration cannot notice the
    // enumeration being wrong, which is how three composition files went
    // missing without a single assertion failing.
    const tracked: string[] = [];
    const walkDir = (dir: string): void => {
      for (const entry of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
        const at = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walkDir(at);
        } else if (entry.name.endsWith('.ts')) {
          tracked.push(at);
        }
      }
    };
    walkDir('apps/api/src');
    const excluded = tracked.filter((each) => !live.includes(each));
    expect(
      excluded.filter((each) => !each.endsWith('.test.ts') && !each.includes('/__tests__/')),
    ).toEqual([]);
    expect(excluded.length).toBeGreaterThan(0);
  });
});

describe('a router named something other than Hono', () => {
  // Read from what the constructor BINDS TO, not from how it is spelled.
  // `startsWith('Hono')` made an aliased import classify as "definitely not a
  // router", which dropped every route in the file — and, once the corpus
  // became "files that register a route", dropped the file from classification
  // altogether.
  it.each([
    ['an aliased import', "import { Hono as Router } from 'hono';"],
    ['a default import from hono', "import Router from 'hono';"],
    ['a deep import', "import { Hono as Router } from 'hono/tiny';"],
  ])('finds routes on a router constructed through %s', (_label, importLine) => {
    const src = `${importLine}
const app = new Router();
app.post('/rooms/:roomId/governance/vote', authMiddleware(), (c) => c.json({}));`;
    expect(extractMutationRoutes('f.ts', src)).toEqual([
      { file: 'f.ts', method: 'post', path: '/rooms/:roomId/governance/vote', guarded: false },
    ]);
  });

  it('still ignores an ordinary collection that shares a method name', () => {
    // The qualification is what keeps `new Map().delete(k)` out, so failing
    // closed on an unrecognised constructor costs nothing.
    const src = `
const cache = new Map();
cache.delete('key');
const rows = new Set();
rows.delete(id);`;
    expect(extractMutationRoutes('f.ts', src)).toEqual([]);
  });
});

describe('a route method the gate cannot READ', () => {
  it('reports it rather than folding a parameter default', () => {
    // The sink analyzer asks what a key MAY be, so a default is worth folding
    // there.  This asks WHICH METHOD is registered: `h(method = 'get')` called
    // with `'post'` registers a POST, and folding the default called it a GET
    // and dropped the mutation.  Unreadable fails CLOSED instead.
    const src = `
const app = new Hono();
function h(method = 'get') { app[method]('/rooms/:roomId/governance/vote', handler); }
h('post');`;
    const routes = extractMutationRoutes('f.ts', src);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.method).toBe('<unreadable method>');
  });

  it('still reads a method held in a `const`, which IS certain', () => {
    const src = `
const app = new Hono();
const method = 'post';
app[method]('/rooms/:roomId/governance/vote', handler);`;
    expect(extractMutationRoutes('f.ts', src)[0]?.method).toBe('post');
  });
});

describe('a registration method taken OFF the router', () => {
  // Hono installs its verb methods as instance arrow functions bound to the
  // router (`this[method] = (…) => …`), so a destructured `post` registers a
  // route exactly as `app.post` does — but the callee is a plain identifier, so
  // it was not read as a registration and the file left the corpus entirely.
  it.each([
    ['a destructured method', 'const { post } = app;\npost'],
    ['a renamed destructured method', 'const { post: register } = app;\nregister'],
    ['a COMPUTED destructured method key', "const { ['post']: register } = app;\nregister"],
    // The same method taken by a property access rather than by a pattern.
    ['a method held in a const', 'const register = app.post;\nregister'],
    ['a computed method held in a const', "const register = app['post'];\nregister"],
    ['a method key held in a const', "const method = 'post';\napp[method]"],
    [
      'a method key from a const DESTRUCTURE',
      "const { method } = { method: 'post' };\napp[method]",
    ],
    [
      'a destructured key held in a const',
      "const key = 'post';\nconst { [key]: register } = app;\nregister",
    ],
    ['an alias of a method alias', 'const first = app.post;\nconst register = first;\nregister'],
  ])('finds a route registered through %s', (_label, prelude) => {
    // Every line but the LAST declares; the last names the call.
    const lines = prelude.split('\n');
    const call = lines[lines.length - 1];
    const src = `
const app = new Hono();
${lines.slice(0, -1).join('\n')}
${call}('/rooms/:roomId/governance/vote', authMiddleware(), (c) => c.json({}));`;
    expect(extractMutationRoutes('f.ts', src)).toEqual([
      { file: 'f.ts', method: 'post', path: '/rooms/:roomId/governance/vote', guarded: false },
    ]);
  });

  it('reads the GUARD inside a destructured registration too', () => {
    const src = `
const app = new Hono();
const { post } = app;
post('/rooms/:roomId/governance/vote', requireGovernanceEligibility(), (c) => c.json({}));`;
    expect(extractMutationRoutes('f.ts', src)[0]?.guarded).toBe(true);
  });

  it('does not treat a destructure from a NON-router as a registration', () => {
    const src = `
const store = new Map();
const { delete: drop } = store;
drop('key');`;
    expect(extractMutationRoutes('f.ts', src)).toEqual([]);
  });
});

describe('a NAMED route handler', () => {
  // Accepting only an INLINE function meant a registration with an unreadable
  // receiver AND an unreadable path qualified as no registration at all and
  // vanished — taking the file out of the corpus with it.
  it.each([
    ['a function declaration', 'function handler(c) { return castVote(); }'],
    ['a const arrow', 'const handler = (c) => castVote();'],
    ['a const function expression', 'const handler = function (c) { return castVote(); };'],
    // A handler this file cannot see the body of is still a handler: with the
    // router and the path both unresolvable too, rejecting it discarded the
    // registration and took the whole file out of the corpus.
    ['an IMPORTED handler', "import { handler } from './handler.js';"],
  ])('qualifies a registration on an unknown receiver: %s', (_label, declaration) => {
    const src = `
import { app } from './router.js';
const path = '/rooms/:roomId/governance/vote';
${declaration}
app.post(path, handler);`;
    const routes = extractMutationRoutes('f.ts', src);
    expect(routes).toHaveLength(1);
    // The path is not readable, so it fails CLOSED rather than being guessed.
    expect(routes[0]?.method).toBe('post');
  });

  it('does not turn an ordinary two-argument call into a route', () => {
    const src = `
function onDone(x) { return x; }
cache.delete('key', onDone);
db.delete(rows);`;
    // `delete('key', …)` has no rooted path; the handler shape alone must not
    // manufacture a route out of a collection call.
    expect(extractMutationRoutes('f.ts', src).map((each) => each.path)).not.toContain(
      '/rooms/:roomId/governance/vote',
    );
  });
});

describe('a receiver the gate cannot classify', () => {
  // Skipping an unrecognised receiver DROPPED the registration, and a dropped
  // route is worse than an unguarded one: the gate reported success over an
  // endpoint it never looked at.
  it('follows a router built by a local factory', () => {
    const src = `
function makeRouter() { return new Hono(); }
const app = makeRouter();
app.post('/rooms/:roomId/governance/vote', async (c) => c.json(await castVote()));`;
    expect(extractMutationRoutes('f.ts', src)).toEqual([
      { file: 'f.ts', method: 'post', path: '/rooms/:roomId/governance/vote', guarded: false },
    ]);
  });

  it('reports a route on an IMPORTED receiver rather than dropping it', () => {
    const src = `
import { app } from './router.js';
app.post('/rooms/:roomId/governance/vote', async (c) => c.json(await castVote()));`;
    expect(extractMutationRoutes('f.ts', src)[0]?.guarded).toBe(false);
  });

  it('reports a COMPUTED path on an imported router rather than dropping it', () => {
    // Neither the receiver nor the path is readable, which is exactly when
    // dropping is worst: the same computed path on a local Hono router already
    // failed closed, so this form was the one way to disappear entirely.  A
    // registration that hands over a HANDLER is one whatever its path says.
    const src = `
import { app } from './router.js';
const path = buildPath();
app.post(path, async (c) => c.json(await castVote()));`;
    expect(extractMutationRoutes('f.ts', src).length).toBeGreaterThan(0);
  });

  it('still skips an ambient global — `Promise.all` is not a route', () => {
    // Asked of the checker, not of a list of global names: every declaration of
    // `Promise` is in a `lib.*.d.ts`, and nothing declared there is a router.
    const src = `
const app = new Hono();
app.get('/x', async (c) => c.json(await Promise.all([one(), two()])));`;
    expect(extractMutationRoutes('f.ts', src)).toEqual([]);
  });
});

describe('the ways Hono registers a route', () => {
  // All three reach the same handler, so all three are governance mutations.
  // `.all` answers every method and was skipped entirely, which let an
  // unguarded participation endpoint pass a fail-closed gate.
  it.each([
    [
      '.all covers every mutation method',
      `export const r = new Hono().all('/rooms/:id/vote', authMiddleware(), (c) => c.json({}));`,
      ['all:/rooms/:id/vote:open'],
    ],
    [
      '.all is guarded like any other',
      `export const r = new Hono().all('/rooms/:id/vote', requireGovernanceEligibility(), (c) => c.json({}));`,
      ['all:/rooms/:id/vote:guarded'],
    ],
    [
      '.on takes an ARRAY of methods',
      `export const r = new Hono().on(['POST','PUT'], '/rooms/:id/vote', (c) => c.json({}));`,
      ['post:/rooms/:id/vote:open', 'put:/rooms/:id/vote:open'],
    ],
    [
      '.on takes an ARRAY of paths',
      `export const r = new Hono().on('POST', ['/a/vote','/b/vote'], (c) => c.json({}));`,
      ['post:/a/vote:open', 'post:/b/vote:open'],
    ],
    [
      '.get is a read, not a mutation',
      `export const r = new Hono().get('/x', (c) => c.json({}));`,
      [],
    ],
    ['.use is middleware, not a route', `export const r = new Hono().use('/x', mw());`, []],
  ])('%s', (_label, source, expected) => {
    expect(
      extractMutationRoutes('f.ts', source).map(
        (route) => `${route.method}:${route.path}:${route.guarded ? 'guarded' : 'open'}`,
      ),
    ).toEqual(expected);
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

  it.each([
    [
      'a discarded result',
      'async (c) => { void checkGovernanceEligibility(c.get("auth").userId); return c.json({}); }',
    ],
    [
      'a bare awaited statement',
      'async (c) => { await checkGovernanceEligibility(c.get("auth").userId); return c.json({}); }',
    ],
  ])('does not accept a guard whose verdict is ignored (%s)', (_label, handler) => {
    // Calling the guard is not enforcing it: an ineligible account is refused
    // by nothing here, yet the name-only test certified the route.
    const source = `export const r = new Hono().post('/rooms/:id/vote', ${handler});`;
    expect(extractMutationRoutes('f.ts', source)[0]?.guarded).toBe(false);
  });

  it.each([
    ['middleware', 'requireGovernanceEligibility(), (c) => c.json({})'],
    [
      'a consumed handler-level result',
      'async (c) => { const d = await checkGovernanceEligibility(c.get("auth").userId); if (d) return c.json({}, 403); return c.json({}); }',
    ],
  ])('accepts a guard that is heeded (%s)', (_label, handler) => {
    const source = `export const r = new Hono().post('/rooms/:id/vote', ${handler});`;
    expect(extractMutationRoutes('f.ts', source)[0]?.guarded).toBe(true);
  });

  it('FAILS CLOSED on a method list it cannot fully read', () => {
    // `.on(['GET', mutation], …)` yielded only `GET`, so the registration
    // classified as a read and was skipped — letting an unguarded POST through
    // a gate whose whole point is failing closed.
    const partial = [
      "const mutation = 'POST' as const;",
      "export const r = new Hono().on(['GET', mutation], '/rooms/:id/governance/vote', (c) => c.json({}));",
    ].join('\n');
    const issues = runGovernanceKycGate((relPath) =>
      relPath === GOVERNANCE_ROUTE_FILES[0] ? partial : 'export const nothing = 1;',
    );
    expect(issues.some((issue) => issue.includes('could not be read'))).toBe(true);
  });

  it('still skips a registration that is only READS', () => {
    const reads = `export const r = new Hono().on(['GET','HEAD'], '/rooms/:id/read', (c) => c.json({}));`;
    const issues = runGovernanceKycGate((relPath) =>
      relPath === GOVERNANCE_ROUTE_FILES[0] ? reads : 'export const nothing = 1;',
    );
    expect(issues.some((issue) => issue.startsWith(GOVERNANCE_ROUTE_FILES[0]))).toBe(false);
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
