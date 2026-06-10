// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: [
        'packages/shared/src/**/*.ts',
        'packages/db/src/**/*.ts',
        'packages/invariants/src/**/*.ts',
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
        // Infrastructure adapters bound to live Redis: exercised by the gated
        // integration test (REDIS_URL), not unit tests. Same precedent as
        // `packages/db/src/client.ts`. The logic they bind to is fully covered.
        'apps/api/src/identity/redis-stores.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
    projects: [
      {
        test: {
          name: 'shared',
          root: 'packages/shared',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'db',
          root: 'packages/db',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'invariants',
          root: 'packages/invariants',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'api',
          root: 'apps/api',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'web',
          root: 'apps/web',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
        },
      },
      {
        test: {
          name: 'policy',
          root: 'scripts',
          include: ['**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
