// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { nodeProjectTest, refuseWorkspaceCoverage } from '../../vitest.shared';

refuseWorkspaceCoverage('private-p2p');

export default defineConfig({ test: nodeProjectTest('private-p2p') });
