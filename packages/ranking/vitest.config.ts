import { defineConfig } from 'vitest/config';
import { nodeProjectTest } from '../../vitest.shared';

export default defineConfig({ test: nodeProjectTest('ranking') });
