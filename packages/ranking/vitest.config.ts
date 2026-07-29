import { defineConfig } from 'vitest/config';
import { nodeProjectTest, refuseWorkspaceCoverage } from '../../vitest.shared';

refuseWorkspaceCoverage('ranking');

export default defineConfig({ test: nodeProjectTest('ranking') });
