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
  /** Per-project timeout, in ms.  Declared because `policyProjectTest` sets it
   *  — and, until this file entered a tsconfig, TypeScript never saw that the
   *  interface omitted it (`error TS2353: 'testTimeout' does not exist in type
   *  'ProjectTest'`).  See the root `tsconfig.tools.json`. */
  testTimeout?: number;
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
  // These are WHOLE-TREE scans, not unit tests: several of them hand every
  // tracked source in the repository to the TypeScript compiler and ask it
  // about each one — 1302 files for `check:dead-exports`, 453 for the a11y
  // gate.  Vitest's 5s default is a budget for a unit test, and on a loaded CI
  // runner with coverage instrumentation attached it is the scan's own runtime,
  // so the suite failed on the clock rather than on an assertion.  The gates
  // themselves are timed separately in CI; this bound only has to be far enough
  // above the work that a slow machine is not a failure.
  testTimeout: 120_000,
};
