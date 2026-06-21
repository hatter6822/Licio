// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { nodeProjectTest } from '../../vitest.shared';

export default defineConfig({ test: nodeProjectTest('lcap-p2p') });
