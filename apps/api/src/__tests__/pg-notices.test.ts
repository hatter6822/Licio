// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Postgres NOTICE → pino level mapping.  The defect this pins is a SILENT
// one: every notice was logged at `debug` while `LOG_LEVEL` defaults to `info`,
// so a Postgres `WARNING` never reached an operator and nothing failed to say so.
import { describe, expect, it } from 'vitest';
import { pgNoticeLogLevel } from '../lib/pg-notices.js';

describe('pgNoticeLogLevel', () => {
  it('keeps a WARNING visible at the default LOG_LEVEL', () => {
    // The whole point: `info` is the production default, so `debug` here means
    // the warning is discarded before anyone can act on it.
    expect(pgNoticeLogLevel('WARNING')).toBe('warn');
  });

  it.each([
    ['NOTICE', 'info'],
    ['INFO', 'info'],
    ['LOG', 'info'],
  ])('logs %s at %s', (severity, level) => {
    expect(pgNoticeLogLevel(severity)).toBe(level);
  });

  it.each(['DEBUG', 'DEBUG1', 'DEBUG5'])('logs %s at debug', (severity) => {
    // These only arrive when `client_min_messages` has been turned down, which
    // is a deliberate act of debugging.
    expect(pgNoticeLogLevel(severity)).toBe('debug');
  });

  it('accepts the severity in any case or padding', () => {
    expect(pgNoticeLogLevel('warning')).toBe('warn');
    expect(pgNoticeLogLevel('  Warning ')).toBe('warn');
  });

  it('logs an UNRECOGNISED severity visibly rather than silently', () => {
    // A diagnostic channel's safe direction for the unknown is visible: a
    // severity this mapping has never seen must not vanish at the default level.
    expect(pgNoticeLogLevel('EXCEPTION')).toBe('info');
    expect(pgNoticeLogLevel('')).toBe('info');
  });
});
