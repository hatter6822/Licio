// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-workspace Vitest config so `pnpm --filter api test` runs THIS workspace's
// suite directly.  The root `vitest.config.ts` composes every workspace into the
// unified multi-project run + cross-workspace coverage gate used by `pnpm test`
// and CI; both source the same project settings from `vitest.shared.ts`.
import { defineConfig } from 'vitest/config';
import { nodeProjectTest } from '../../vitest.shared';

export default defineConfig({
  test: {
    ...nodeProjectTest('api'),
    // Migrate the gated integration DB ONCE before the parallel workers (avoids
    // the concurrent-migrate DDL race on a fresh database) — mirrors the api
    // project entry in the root multi-project config.
    globalSetup: ['./src/__tests__/global-db-setup.ts'],
  },
});
