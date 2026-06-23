// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4c/e — the native courier TS bridge: the §22.5/§33.5 control gating and the
// zod-validated, base64-bridged per-endpoint medium (fail-closed on a malformed native
// event).  The radio behavior itself is device-only; this tests the JS side.

import { describe, expect, it, vi } from 'vitest';
import {
  type CourierRadioControls,
  decideCourierStart,
  type NearbyCourierPlugin,
  NearbyEndpointMedium,
  nativePayloadEventSchema,
} from './courier-native.js';

const ON: CourierRadioControls = { advertisingEnabled: true, discoveryEnabled: true };
const OFF: CourierRadioControls = { advertisingEnabled: false, discoveryEnabled: false };

describe('WS-R.15.4e courier control gating', () => {
  it('is off by default (disabled)', () => {
    expect(decideCourierStart(OFF, 'standard')).toEqual({
      advertise: false,
      discover: false,
      blockedReason: 'disabled',
    });
  });

  it('honors explicit controls in a normal mode', () => {
    expect(decideCourierStart(ON, 'standard')).toEqual({
      advertise: true,
      discover: true,
      blockedReason: '',
    });
    expect(
      decideCourierStart({ advertisingEnabled: true, discoveryEnabled: false }, 'courier'),
    ).toEqual({ advertise: true, discover: false, blockedReason: '' });
  });

  it('FORCES the radios off in Stealth and Emergency regardless of controls (§33.5)', () => {
    for (const mode of ['stealth', 'emergency'] as const) {
      expect(decideCourierStart(ON, mode)).toEqual({
        advertise: false,
        discover: false,
        blockedReason: 'forced_off_in_mode',
      });
    }
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
});
