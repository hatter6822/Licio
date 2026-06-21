// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.11.4 / WS-R.17.2 — the persisted operational-mode source the §23.3 sync gate
// reads: default `standard`, a set mode round-trips through localStorage, Stealth maps to
// the `stealth` storage mode (which `shouldAutoSync` suppresses) and disables background
// sync, and an invalid persisted slice fails closed to `standard`.

import { afterEach, describe, expect, it } from 'vitest';
import {
  backgroundSyncAllowed,
  getOperationalMode,
  setOperationalMode,
  syncStorageMode,
} from './mode-state.js';

afterEach(() => {
  globalThis.localStorage?.clear();
});

describe('mode-state (operational mode)', () => {
  it('defaults to standard with no persisted mode (auto-sync permitted)', () => {
    expect(getOperationalMode()).toBe('standard');
    expect(syncStorageMode()).toBe('standard');
    expect(backgroundSyncAllowed()).toBe(true);
  });

  it('persists a set mode and reflects it in the §23.3 storage mode + the bg-sync flag', () => {
    setOperationalMode('stealth');
    // The slice is persisted under the prefixed key in the standard envelope.
    expect(globalThis.localStorage.getItem('licio:lcap-mode')).toBe(
      JSON.stringify({ version: 1, state: { mode: 'stealth' } }),
    );
    expect(getOperationalMode()).toBe('stealth');
    expect(syncStorageMode()).toBe('stealth'); // shouldAutoSync suppresses on `stealth`
    expect(backgroundSyncAllowed()).toBe(false); // Stealth disables background sync (§33)
  });

  it('round-trips a non-suppressing mode (courier still permits sync)', () => {
    setOperationalMode('courier');
    expect(getOperationalMode()).toBe('courier');
    expect(syncStorageMode()).toBe('courier');
    expect(backgroundSyncAllowed()).toBe(true);
  });

  it('falls back to standard on an invalid persisted slice (fail-closed)', () => {
    globalThis.localStorage.setItem(
      'licio:lcap-mode',
      JSON.stringify({ version: 1, state: { mode: 'not-a-mode' } }),
    );
    expect(getOperationalMode()).toBe('standard');
  });
});
