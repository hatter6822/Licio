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
}

/** A Node-environment workspace project (the packages + the API server). */
export function nodeProjectTest(name: string): ProjectTest {
  return { name, include: ['src/**/*.test.ts'], environment: 'node' };
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
