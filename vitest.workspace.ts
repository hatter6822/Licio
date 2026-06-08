// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
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
    },
  },
]);
