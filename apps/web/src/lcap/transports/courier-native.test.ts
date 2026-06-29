// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4c/e — the native courier TS bridge: the §22.5/§33.5 control gating and the
// zod-validated, base64-bridged per-endpoint medium (fail-closed on a malformed native
// event).  The radio behavior itself is device-only; this tests the JS side.

import { describe, expect, it, vi } from 'vitest';
import {
  type CourierRadioControls,
  decideCourierStart,
  mayExchangeWithEndpoint,
  type NearbyCourierPlugin,
  NearbyEndpointMedium,
  nativeConnectionEventSchema,
  nativePayloadEventSchema,
  withinStorageBudget,
} from './courier-native.js';

const ON: CourierRadioControls = { advertisingEnabled: true, discoveryEnabled: true };
const OFF: CourierRadioControls = { advertisingEnabled: false, discoveryEnabled: false };

// The §22.5 radio-metadata disclosure is acknowledged for most cases (it is a precondition to
// running the radios at all); the dedicated gate test below drives the unacknowledged path.
const ACKED = true;

describe('WS-R.15.4e courier control gating', () => {
  it('is off by default (disabled)', () => {
    expect(decideCourierStart(OFF, 'standard', {}, ACKED)).toEqual({
      advertise: false,
      discover: false,
      blockedReason: 'disabled',
    });
  });

  it('refuses to start until the radio-metadata disclosure is acknowledged', () => {
    // Toggles ON but disclosure NOT acknowledged ⇒ blocked structurally (not only in the UI).
    expect(decideCourierStart(ON, 'standard', {}, false)).toEqual({
      advertise: false,
      discover: false,
      blockedReason: 'disclosure_unacknowledged',
    });
    // 'disabled' still takes precedence when nothing is enabled (no disclosure needed).
    expect(decideCourierStart(OFF, 'standard', {}, false).blockedReason).toBe('disabled');
  });

  it('honors explicit controls in a normal mode', () => {
    expect(decideCourierStart(ON, 'standard', {}, ACKED)).toEqual({
      advertise: true,
      discover: true,
      blockedReason: '',
    });
    expect(
      decideCourierStart(
        { advertisingEnabled: true, discoveryEnabled: false },
        'courier',
        {},
        ACKED,
      ),
    ).toEqual({ advertise: true, discover: false, blockedReason: '' });
  });

  it('FORCES the radios off in Stealth and Emergency regardless of controls (§33.5)', () => {
    for (const mode of ['stealth', 'emergency'] as const) {
      expect(decideCourierStart(ON, mode, {}, ACKED)).toEqual({
        advertise: false,
        discover: false,
        blockedReason: 'forced_off_in_mode',
      });
    }
  });

  it('refuses to advertise below the battery floor when unplugged (§22.5 battery budget)', () => {
    const controls: CourierRadioControls = { ...ON, batteryFloor: 0.3 };
    expect(decideCourierStart(controls, 'courier', { level: 0.2, charging: false }, ACKED)).toEqual(
      {
        advertise: false,
        discover: false,
        blockedReason: 'below_battery_floor',
      },
    );
    // Above the floor → allowed.
    expect(
      decideCourierStart(controls, 'courier', { level: 0.5, charging: false }, ACKED).advertise,
    ).toBe(true);
    // On charge → the floor is bypassed (the radio cost is acceptable while plugged in).
    expect(
      decideCourierStart(controls, 'courier', { level: 0.1, charging: true }, ACKED).advertise,
    ).toBe(true);
    // Unknown level → the floor cannot fire (it requires a known level).
    expect(decideCourierStart(controls, 'courier', {}, ACKED).advertise).toBe(true);
  });

  it('blocks when the user has opted to exchange with no one (§22.5 who-can-exchange)', () => {
    expect(decideCourierStart({ ...ON, exchangePeers: 'none' }, 'courier', {}, ACKED)).toEqual({
      advertise: false,
      discover: false,
      blockedReason: 'no_peers',
    });
  });
});

describe('WS-R.15.4e who-can-exchange (per-endpoint)', () => {
  it('anyone accepts every endpoint; none refuses every endpoint', () => {
    expect(mayExchangeWithEndpoint({ ...ON, exchangePeers: 'anyone' }, 'ep-1')).toBe(true);
    expect(mayExchangeWithEndpoint({ ...ON, exchangePeers: 'none' }, 'ep-1')).toBe(false);
    // Default (unset) is `anyone` for public content.
    expect(mayExchangeWithEndpoint(ON, 'ep-1')).toBe(true);
  });

  it('known_only accepts only an allowlisted endpoint id', () => {
    const controls: CourierRadioControls = {
      ...ON,
      exchangePeers: 'known_only',
      allowedEndpointIds: ['ep-allowed'],
    };
    expect(mayExchangeWithEndpoint(controls, 'ep-allowed')).toBe(true);
    expect(mayExchangeWithEndpoint(controls, 'ep-other')).toBe(false);
  });
});

describe('WS-R.15.4e storage budget', () => {
  it('a zero budget is unbounded', () => {
    expect(withinStorageBudget({ ...ON, storageBudgetBytes: 0 }, 1e9, 1e9)).toBe(true);
  });

  it('caps the total ferried bytes at the budget', () => {
    const controls: CourierRadioControls = { ...ON, storageBudgetBytes: 1000 };
    expect(withinStorageBudget(controls, 0, 1000)).toBe(true);
    expect(withinStorageBudget(controls, 600, 400)).toBe(true);
    expect(withinStorageBudget(controls, 600, 401)).toBe(false);
    expect(withinStorageBudget(controls, 1000, 1)).toBe(false);
  });
});

describe('WS-R.15.4c native connection-event schema', () => {
  it('parses a strict connectionResult event', () => {
    expect(
      nativeConnectionEventSchema.safeParse({ endpointId: 'ep-1', connected: true }).success,
    ).toBe(true);
    expect(
      nativeConnectionEventSchema.safeParse({ endpointId: 'ep-1', connected: true, extra: 1 })
        .success,
    ).toBe(false);
  });
});

function fakePlugin(): NearbyCourierPlugin & {
  sent: Array<{ endpointId: string; message: string }>;
} {
  const sent: Array<{ endpointId: string; message: string }> = [];
  return {
    sent,
    startAdvertising: async () => {},
    startDiscovery: async () => {},
    stop: async () => {},
    send: async (o) => {
      sent.push(o);
    },
    addListener: () => ({ remove: () => {} }),
  };
}

describe('WS-R.15.4c NearbyEndpointMedium (base64 bridge)', () => {
  it('round-trips bytes exactly across the base64 boundary', async () => {
    const plugin = fakePlugin();
    const medium = new NearbyEndpointMedium(plugin, 'ep-1');
    const payload = new Uint8Array([0, 1, 2, 254, 255, 128, 64]);
    medium.enqueueOutbound(payload);
    await Promise.resolve();
    expect(plugin.sent).toHaveLength(1);
    // Decode what was sent: it must equal the original bytes.
    const sentBytes = Uint8Array.from(atob(plugin.sent[0]?.message ?? ''), (c) => c.charCodeAt(0));
    expect(Array.from(sentBytes)).toEqual(Array.from(payload));
    expect(plugin.sent[0]?.endpointId).toBe('ep-1');
  });

  it('delivers a valid inbound native event to a pending receive', () => {
    const medium = new NearbyEndpointMedium(fakePlugin(), 'ep-1');
    const woke = vi.fn();
    medium.onInbound(woke);
    medium.acceptNativeEvent({ endpointId: 'ep-1', message: btoa('\x01\x02\x03') });
    expect(woke).toHaveBeenCalledOnce();
    expect(Array.from(medium.takeInbound() ?? [])).toEqual([1, 2, 3]);
  });

  it('ignores an event for a DIFFERENT endpoint', () => {
    const medium = new NearbyEndpointMedium(fakePlugin(), 'ep-1');
    medium.acceptNativeEvent({ endpointId: 'ep-OTHER', message: btoa('xx') });
    expect(medium.takeInbound()).toBeNull();
  });

  it('FAILS CLOSED on a malformed native event (never decodes, never throws)', () => {
    const medium = new NearbyEndpointMedium(fakePlugin(), 'ep-1');
    expect(() => medium.acceptNativeEvent({ endpointId: 'ep-1' })).not.toThrow(); // missing message
    expect(() => medium.acceptNativeEvent('garbage')).not.toThrow();
    expect(() =>
      medium.acceptNativeEvent({ endpointId: 'ep-1', message: '!!!not base64!!!' }),
    ).not.toThrow();
    expect(medium.takeInbound()).toBeNull(); // nothing was accepted
  });

  it('the native payload schema is strict (rejects extra keys)', () => {
    expect(
      nativePayloadEventSchema.safeParse({ endpointId: 'a', message: 'b', extra: 1 }).success,
    ).toBe(false);
  });

  it('tracks the total outbound bytes ferried (storage-budget accounting)', () => {
    const medium = new NearbyEndpointMedium(fakePlugin(), 'ep-1');
    expect(medium.bytesSent()).toBe(0);
    medium.enqueueOutbound(new Uint8Array([1, 2, 3]));
    medium.enqueueOutbound(new Uint8Array([4, 5]));
    expect(medium.bytesSent()).toBe(5);
  });
});
