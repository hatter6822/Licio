import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sourceAlias = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@licio/shared/env/server': sourceAlias('./packages/shared/src/env/server.ts'),
      '@licio/shared/env/client': sourceAlias('./packages/shared/src/env/client.ts'),
      '@licio/shared/env': sourceAlias('./packages/shared/src/env/index.ts'),
      '@licio/shared/logging': sourceAlias('./packages/shared/src/logging/index.ts'),
      '@licio/shared': sourceAlias('./packages/shared/src/index.ts'),
      '@licio/db': sourceAlias('./packages/db/src/index.ts'),
      '@licio/invariants': sourceAlias('./packages/invariants/src/index.ts'),
    },
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
