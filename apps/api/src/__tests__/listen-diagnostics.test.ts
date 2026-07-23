// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The boot's listen-failure diagnosis: the message an operator actually reads
// when the API cannot start. The point of these cases is that each one names
// the PORT and a NEXT ACTION — a raw `node:net` stack (the behaviour this
// replaced) does neither.
import { describe, expect, it } from 'vitest';
import { describeListenFailure, systemErrorCode } from '../lib/listen-diagnostics.js';

describe('systemErrorCode', () => {
  it('reads the code off a Node system error without a cast', () => {
    const error = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    expect(systemErrorCode(error)).toBe('EADDRINUSE');
  });

  it('is undefined for a plain error, a non-string code, and a non-error', () => {
    expect(systemErrorCode(new Error('boom'))).toBeUndefined();
    expect(systemErrorCode(Object.assign(new Error('boom'), { code: 98 }))).toBeUndefined();
    expect(systemErrorCode('EADDRINUSE')).toBeUndefined();
    expect(systemErrorCode(undefined)).toBeUndefined();
  });
});

describe('describeListenFailure', () => {
  it('EADDRINUSE names the port AND the watcher-respawn trap', () => {
    const message = describeListenFailure('EADDRINUSE', 3001);
    expect(message).toContain('3001');
    expect(message).toContain('already in use');
    // The non-obvious part: killing the process on the port is not enough,
    // because `tsx watch` respawns its child. Losing this sentence puts the
    // developer back in the loop this message exists to break.
    expect(message).toContain('tsx watch');
    expect(message).toMatch(/respawns/i);
    // And an escape hatch that needs no killing at all.
    expect(message).toContain('PORT=<n>');
  });

  it('EACCES explains the privileged-port rule rather than just denying', () => {
    const message = describeListenFailure('EACCES', 80);
    expect(message).toContain('80');
    expect(message).toMatch(/privileged/i);
    expect(message).toContain('PORT=<n>');
  });

  it('EADDRNOTAVAIL points at the interface, not the port', () => {
    const message = describeListenFailure('EADDRNOTAVAIL', 3001);
    expect(message).toMatch(/address is not available/i);
    expect(message).toMatch(/interface/i);
  });

  it('an unknown code is still reported with the port and the code itself', () => {
    const message = describeListenFailure('ENOTSOCK', 3001);
    expect(message).toContain('3001');
    expect(message).toContain('ENOTSOCK');
    // Never claims a cause it does not know.
    expect(message).not.toMatch(/already in use/i);
  });

  it('a missing code degrades to a clean sentence (no "undefined" in the text)', () => {
    const message = describeListenFailure(undefined, 3001);
    expect(message).toContain('3001');
    expect(message).not.toContain('undefined');
  });

  it('every case states the port and ends as one sentence-run, never a stack', () => {
    for (const code of ['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL', 'ENOTSOCK', undefined]) {
      const message = describeListenFailure(code, 4321);
      expect(message).toContain('4321');
      expect(message).not.toContain('\n');
      expect(message.length).toBeGreaterThan(40);
    }
  });
});
