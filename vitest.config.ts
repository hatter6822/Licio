import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sourceAlias = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@licio\/shared\/(.+)$/, replacement: sourceAlias('./packages/shared/src/$1') },
      { find: /^@licio\/db\/(.+)$/, replacement: sourceAlias('./packages/db/src/$1') },
      {
        find: /^@licio\/invariants\/(.+)$/,
        replacement: sourceAlias('./packages/invariants/src/$1'),
      },
      { find: '@licio/shared', replacement: sourceAlias('./packages/shared/src/index.ts') },
      { find: '@licio/db', replacement: sourceAlias('./packages/db/src/index.ts') },
      { find: '@licio/invariants', replacement: sourceAlias('./packages/invariants/src/index.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts', 'scripts/**/*.test.ts'],
    coverage: {
      all: false,
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
      exclude: [
        '**/*.config.ts',
        '**/dist/**',
        '**/coverage/**',
        '**/*.d.ts',
        'apps/web/src/main.tsx',
        'apps/web/vite.config.ts',
        '**/dist-types/**',
        'scripts/**',
        'tests/e2e/**',
      ],
    },
  },
});
