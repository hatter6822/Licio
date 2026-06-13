// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Root multi-project config: the unified `pnpm test` run + the cross-workspace
// coverage gate (CI).  Each project's settings come from `vitest.shared.ts` (the
// SSOT) and are anchored to their workspace `root` here; each workspace also has
// a thin local `vitest.config.ts` re-using the same settings so `pnpm --filter
// <ws> test` works standalone.
import { defineConfig } from 'vitest/config';
import { nodeProjectTest, policyProjectTest, webProjectTest } from './vitest.shared';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: [
        'packages/shared/src/**/*.ts',
        'packages/db/src/**/*.ts',
        'packages/invariants/src/**/*.ts',
        'packages/ranking/src/**/*.ts',
        'apps/api/src/**/*.ts',
        'apps/web/src/**/*.ts',
        'apps/web/src/**/*.tsx',
      ],
      exclude: [
        '**/__tests__/**',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/index.ts',
        'apps/web/src/main.tsx',
        'apps/web/src/routes/**',
        'apps/web/src/routeTree.gen.ts',
        'apps/web/src/test/**',
        'packages/db/src/client.ts',
        'packages/db/src/schema/**',
        // Infrastructure adapters bound to live Redis/Postgres: exercised by the
        // gated integration tests (REDIS_URL / DATABASE_URL), not unit tests.
        // Same precedent as `packages/db/src/client.ts`. The logic they bind to
        // is fully covered.
        'apps/api/src/identity/redis-stores.ts',
        'apps/api/src/identity/drizzle-store.ts',
        'apps/api/src/events/redis-event-stores.ts',
        'apps/api/src/events/drizzle-event-stores.ts',
        'apps/api/src/ingestion/drizzle-ingestion-stores.ts',
        'apps/api/src/forum/drizzle-forum-stores.ts',
        'apps/api/src/invariants/drizzle-invariant-stores.ts',
        'apps/api/src/ranking/drizzle-ranking-stores.ts',
        'packages/db/src/similarity.ts',
        // Dev/test-only entrypoint + fixtures (never production): the in-memory
        // E2E server is run by Playwright, not vitest, and the demo seed/data are
        // development fixtures. Their CORRECTNESS is covered (the BFF E2E harness;
        // the forum-coverage demo-seed test), but their branch profile is not
        // product logic — same precedent as `**/index.ts` + the adapters above.
        'apps/api/src/e2e-server.ts',
        'apps/api/src/lib/demo-seed.ts',
        'apps/api/src/lib/demo-data.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
    projects: [
      { test: { ...nodeProjectTest('shared'), root: 'packages/shared' } },
      { test: { ...nodeProjectTest('db'), root: 'packages/db' } },
      { test: { ...nodeProjectTest('invariants'), root: 'packages/invariants' } },
      { test: { ...nodeProjectTest('ranking'), root: 'packages/ranking' } },
      { test: { ...nodeProjectTest('api'), root: 'apps/api' } },
      { test: { ...webProjectTest, root: 'apps/web' } },
      { test: { ...policyProjectTest, root: 'scripts' } },
    ],
  },
});
