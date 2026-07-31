// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-workspace Vitest config so `pnpm --filter web test` runs THIS workspace's
// suite directly (jsdom + DOM/test setup).  The root `vitest.config.ts` composes
// every workspace into the unified multi-project run + coverage gate; both source
// the same project settings from `vitest.shared.ts`.  Note: `vite.config.ts` is
// the production BUILD config (Vite/Rolldown); this file owns the TEST config.
import { defineConfig } from 'vitest/config';
import { refuseWorkspaceCoverage, webProjectTest } from '../../vitest.shared';

refuseWorkspaceCoverage('web');

export default defineConfig({ test: webProjectTest });
