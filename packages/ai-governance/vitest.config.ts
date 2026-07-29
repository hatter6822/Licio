// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-workspace Vitest config so `pnpm --filter @licio/ai-governance test` runs
// THIS workspace's suite directly.  The root `vitest.config.ts` composes every
// workspace into the unified run + coverage gate; both source the same project
// settings from `vitest.shared.ts`.
import { defineConfig } from 'vitest/config';
import { nodeProjectTest, refuseWorkspaceCoverage } from '../../vitest.shared';

refuseWorkspaceCoverage('ai-governance');

export default defineConfig({ test: nodeProjectTest('ai-governance') });
