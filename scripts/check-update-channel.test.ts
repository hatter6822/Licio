// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.2b — the `check:update-channel` gate, proven to BITE.  The real
// source tree passes; an injected reader that drops a required marker (or
// smuggles `eval` into the worker) fails with the right violation.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REQUIRED_FILES, runUpdateChannelGate } from './check-update-channel.js';

const ROOT = resolve(import.meta.dirname, '..');
const realRead = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8');

describe('check:update-channel', () => {
  it('passes over the real source tree (the wiring is present)', () => {
    expect(runUpdateChannelGate(realRead)).toEqual([]);
  });

  it('BITES when a required verify-before-activate marker is removed', () => {
    const target = 'packages/shared/src/update/verify.ts';
    const tamperedRead = (rel: string): string => {
      const src = realRead(rel);
      if (rel === target) return src.replace(/verifyInclusion/g, 'XXX');
      return src;
    };
    const violations = runUpdateChannelGate(tamperedRead);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.file === target && v.detail.includes('verifyInclusion'))).toBe(
      true,
    );
  });

  it('BITES when the client gate loses the §20.6 lock copy', () => {
    const target = 'apps/web/src/update/gate.ts';
    const tamperedRead = (rel: string): string => {
      const src = realRead(rel);
      if (rel === target) return src.replace(/PRIVATE_BUNDLE_LOCK_MESSAGE/g, 'SILENT_PASS');
      return src;
    };
    const violations = runUpdateChannelGate(tamperedRead);
    expect(
      violations.some((v) => v.file === target && v.detail.includes('PRIVATE_BUNDLE_LOCK_MESSAGE')),
    ).toBe(true);
  });

  it('BITES when the service worker smuggles eval()', () => {
    const target = 'apps/web/public/sw-push.js';
    const tamperedRead = (rel: string): string => {
      const src = realRead(rel);
      if (rel === target) return `${src}\neval(self.location.search);\n`;
      return src;
    };
    const violations = runUpdateChannelGate(tamperedRead);
    expect(violations.some((v) => v.file === target && v.detail === 'sw eval()')).toBe(true);
  });

  it('BITES when a required file is missing entirely', () => {
    const target = REQUIRED_FILES[0]?.file;
    const tamperedRead = (rel: string): string => {
      if (rel === target) throw new Error('ENOENT');
      return realRead(rel);
    };
    const violations = runUpdateChannelGate(tamperedRead);
    expect(violations.some((v) => v.file === target && v.detail.includes('not found'))).toBe(true);
  });
});
