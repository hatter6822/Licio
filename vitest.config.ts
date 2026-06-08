import { defineConfig } from 'vitest/config';

export default defineConfig({
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
