// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4e — the persisted §22.5 courier controls + the radio-metadata disclosure
// acknowledgment.  Off by default; an invalid persisted slice falls back to the
// conservative default; the disclosure acknowledgment round-trips.

import { afterEach, describe, expect, it } from 'vitest';
import {
  getCourierControls,
  getRadioDisclosureAcknowledged,
  setCourierControls,
  setRadioDisclosureAcknowledged,
} from './courier-controls-state.js';

describe('courier-controls-state (WS-R.15.4e)', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('defaults to everything off (radios + a no-floor budget)', () => {
    const controls = getCourierControls();
    expect(controls.advertisingEnabled).toBe(false);
    expect(controls.discoveryEnabled).toBe(false);
    expect(controls.exchangePeers).toBe('anyone');
    expect(controls.storageBudgetBytes).toBe(0);
    expect(controls.batteryFloor).toBe(0);
  });

  it('persists and reloads the full control set', () => {
    setCourierControls({
      advertisingEnabled: true,
      discoveryEnabled: true,
      exchangePeers: 'known_only',
      allowedEndpointIds: ['ep-a'],
      sharing: { roomHashAllowlist: ['abcd'], maxPriorityClass: 2 },
      storageBudgetBytes: 4096,
      batteryFloor: 0.25,
    });
    const reloaded = getCourierControls();
    expect(reloaded.advertisingEnabled).toBe(true);
    expect(reloaded.exchangePeers).toBe('known_only');
    expect(reloaded.allowedEndpointIds).toEqual(['ep-a']);
    expect(reloaded.sharing?.maxPriorityClass).toBe(2);
    expect(reloaded.storageBudgetBytes).toBe(4096);
    expect(reloaded.batteryFloor).toBe(0.25);
  });

  it('the radio-metadata disclosure acknowledgment round-trips (default false)', () => {
    expect(getRadioDisclosureAcknowledged()).toBe(false);
    setRadioDisclosureAcknowledged(true);
    expect(getRadioDisclosureAcknowledged()).toBe(true);
    setRadioDisclosureAcknowledged(false);
    expect(getRadioDisclosureAcknowledged()).toBe(false);
  });
});
