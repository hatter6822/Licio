// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Single source of truth for each workspace's Vitest project settings.  The root
// `vitest.config.ts` composes these into the unified multi-project run (with the
// cross-workspace coverage gate) used by `pnpm test` and CI; each workspace's
// local `vitest.config.ts` re-uses its own entry so `pnpm --filter <ws> test`
// runs that suite directly without walking up to (and mis-resolving) the root
// multi-project config.

/** Structural subset of Vitest's per-project `test` config that we configure. */
export interface ProjectTest {
  name: string;
  include: string[];
  environment: 'node' | 'jsdom';
  setupFiles?: string[];
  env?: Record<string, string>;
}

/**
 * `LOG_LEVEL=silent` keeps the suite output clean: the pino loggers
 * (`middleware/csrf.ts`, `middleware/logger.ts`, `routes/csp-report.ts`) read
 * `process.env.LOG_LEVEL` at module load, and the security tests deliberately
 * trigger rejections (CSRF `token_mismatch`/`origin_mismatch`, request logs)
 * whose audit `warn`/`info` lines would otherwise flood stdout.  No test asserts
 * on log output, so silencing changes nothing but the noise; Vitest applies
 * `test.env` to `process.env` before the modules load.
 */
const SILENT_LOG_ENV = { LOG_LEVEL: 'silent' } as const;

/** A Node-environment workspace project (the packages + the API server). */
export function nodeProjectTest(name: string): ProjectTest {
  return { name, include: ['src/**/*.test.ts'], environment: 'node', env: { ...SILENT_LOG_ENV } };
}

/** The web PWA project: jsdom + the DOM/test setup file. */
export const webProjectTest: ProjectTest = {
  name: 'web',
  include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  environment: 'jsdom',
  setupFiles: ['./src/test/setup.ts'],
};

/** The build-scripts/policy project (`scripts/` is not a workspace package). */
export const policyProjectTest: ProjectTest = {
  name: 'policy',
  include: ['**/*.test.ts'],
  environment: 'node',
};
