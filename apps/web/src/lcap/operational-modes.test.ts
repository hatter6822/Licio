// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.17.2 — the §33 operational modes: each mode applies its budget / priority /
// media / discovery policy; Emergency disables all media and limits to P0/P1; Stealth
// disables discovery/advertising/background sync and uses generic filenames; a
// user-initiated action is always permitted.

import { describe, expect, it } from 'vitest';
import {
  admitsPriority,
  modeAllowsChannel,
  OPERATIONAL_MODE_KEYS,
  operationalMode,
  storageConfigForMode,
} from './operational-modes.js';

describe('operational modes — coverage + storage binding', () => {
  it('defines exactly the six §33 modes', () => {
    expect([...OPERATIONAL_MODE_KEYS].sort()).toEqual([
      'courier',
      'emergency',
      'minimal',
      'relay',
      'standard',
      'stealth',
    ]);
  });

  it('binds each mode to its §21.3 storage policy', () => {
    expect(storageConfigForMode('courier').mode).toBe('courier');
    expect(storageConfigForMode('stealth').mode).toBe('stealth');
    // Emergency rides the smallest text-only cache.
    expect(storageConfigForMode('emergency').mode).toBe('minimal');
  });
});

describe('Emergency mode (§33)', () => {
  it('disables all media and admits only P0/P1', () => {
    const e = operationalMode('emergency');
    expect(e.mediaAllowed).toBe(false);
    expect(e.maxPriority).toBe(1);
    expect(admitsPriority(e, 0)).toBe(true); // P0 control
    expect(admitsPriority(e, 1)).toBe(true); // P1 text
    expect(admitsPriority(e, 2)).toBe(false); // P2 evidence — off
    expect(admitsPriority(e, 3)).toBe(false); // P3 media — off
    expect(e.emergencyOneTapExport).toBe(true);
    expect(e.minimalBudget).toBe(true);
    expect(e.showTrustWarning).toBe(true);
  });
});

describe('Stealth mode (§33 / §26.3)', () => {
  it('disables every automatic reveal channel and uses generic filenames', () => {
    const s = operationalMode('stealth');
    expect(s.autoDiscovery).toBe(false);
    expect(s.courierAdvertising).toBe(false);
    expect(s.backgroundSync).toBe(false);
    expect(s.genericFilenames).toBe(true);
    expect(s.confirmBeforeExport).toBe(true);
    expect(s.mediaAllowed).toBe(false);
    expect(s.showTrustWarning).toBe(true);
  });

  it('still permits a user-initiated action', () => {
    const s = operationalMode('stealth');
    expect(modeAllowsChannel(s, 'discovery')).toBe(false);
    expect(modeAllowsChannel(s, 'advertise')).toBe(false);
    expect(modeAllowsChannel(s, 'background_sync')).toBe(false);
    expect(modeAllowsChannel(s, 'user_initiated')).toBe(true);
  });
});

describe('Courier / Standard / Minimal policy', () => {
  it('Courier opts into media + advertising; Standard/Minimal do not', () => {
    expect(operationalMode('courier').mediaAllowed).toBe(true);
    expect(operationalMode('courier').courierAdvertising).toBe(true);
    expect(admitsPriority(operationalMode('courier'), 4)).toBe(true);

    expect(operationalMode('standard').courierAdvertising).toBe(false);
    expect(admitsPriority(operationalMode('standard'), 2)).toBe(true);
    expect(admitsPriority(operationalMode('standard'), 3)).toBe(false);

    expect(operationalMode('minimal').mediaAllowed).toBe(false);
    expect(operationalMode('minimal').maxPriority).toBe(1);
    expect(operationalMode('minimal').minimalBudget).toBe(true);
  });

  it('non-high-risk modes do not force a trust warning', () => {
    expect(operationalMode('minimal').showTrustWarning).toBe(false);
    expect(operationalMode('standard').showTrustWarning).toBe(false);
  });
});
