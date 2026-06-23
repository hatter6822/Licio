// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.2b — anti-rollback persistence: the trusted-sequence floor survives a
// reload, moves monotonically UP, and discards a corrupt value (fail-safe).

import { beforeEach, describe, expect, it } from 'vitest';
import { loadLastTrustedSequence, recordTrustedSequence } from './anti-rollback.js';

const STORAGE_KEY = 'licio:update-anti-rollback';

describe('anti-rollback persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns undefined on first run (no floor)', () => {
    expect(loadLastTrustedSequence()).toBeUndefined();
  });

  it('records a trusted sequence and reads it back (live across reloads)', () => {
    recordTrustedSequence(7);
    expect(loadLastTrustedSequence()).toBe(7);
  });

  it('moves the floor UP only — a lower replayed sequence never lowers it', () => {
    recordTrustedSequence(10);
    recordTrustedSequence(4); // a replayed older-but-valid manifest
    expect(loadLastTrustedSequence()).toBe(10);
    recordTrustedSequence(12);
    expect(loadLastTrustedSequence()).toBe(12);
  });

  it('ignores a negative / non-integer sequence', () => {
    recordTrustedSequence(-1);
    recordTrustedSequence(Number.NaN);
    expect(loadLastTrustedSequence()).toBeUndefined();
  });

  it('discards a corrupt persisted value (fail-safe ⇒ no floor)', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    expect(loadLastTrustedSequence()).toBeUndefined();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, state: { wrong: true } }));
    expect(loadLastTrustedSequence()).toBeUndefined();
  });
});
