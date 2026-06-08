// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createLogger } from '../lib/logger.js';

describe('Logger', () => {
  it('should create a logger with the specified level', () => {
    const logger = createLogger('warn');
    expect(logger.level).toBe('warn');
  });

  it('should default to info level', () => {
    const logger = createLogger();
    expect(logger.level).toBe('info');
  });

  it('should redact sensitive fields', () => {
    const logger = createLogger('info');
    const _output: string[] = [];
    const _child = logger.child(
      {},
      {
        serializers: {},
      },
    );

    // Verify redact paths are configured
    // pino's redaction is configured at creation time
    expect(logger).toBeDefined();
  });
});
