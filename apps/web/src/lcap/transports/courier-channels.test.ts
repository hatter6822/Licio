// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4d — the additional native courier channel bridges (Wi-Fi Direct / Bluetooth /
// USB).  Each shares the SAME base64 boundary + the SAME fail-closed event handling as
// Nearby; the channel info table records which channels are emulator-verifiable vs.
// physical-OTG-only (USB).

import { describe, expect, it, vi } from 'vitest';
import {
  COURIER_CHANNEL_INFO,
  COURIER_CHANNEL_PLUGINS,
  COURIER_CHANNELS,
  type CourierChannel,
  isCourierChannel,
  NativeChannelMedium,
  resolveCourierChannel,
  resolveCourierChannels,
} from './courier-channels.js';
import type { NearbyCourierPlugin } from './courier-native.js';

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

describe('NativeChannelMedium (WS-R.15.4d)', () => {
  it('round-trips bytes exactly across the base64 boundary, tagged with its channel', async () => {
    const plugin = fakePlugin();
    const medium = new NativeChannelMedium(plugin, 'ep-1', 'wifiDirect');
    expect(medium.channel).toBe('wifiDirect');
    const payload = new Uint8Array([0, 200, 255, 1, 127]);
    medium.enqueueOutbound(payload);
    await Promise.resolve();
    const decoded = Uint8Array.from(atob(plugin.sent[0]?.message ?? ''), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual(Array.from(payload));
    expect(medium.bytesSent()).toBe(payload.byteLength);
  });

  it('delivers a valid inbound event and FAILS CLOSED on a malformed one', () => {
    const medium = new NativeChannelMedium(fakePlugin(), 'ep-1', 'bluetooth');
    const woke = vi.fn();
    medium.onInbound(woke);
    medium.acceptNativeEvent({ endpointId: 'ep-1', message: btoa('\x01\x02') });
    expect(woke).toHaveBeenCalledOnce();
    expect(Array.from(medium.takeInbound() ?? [])).toEqual([1, 2]);
    // Malformed / wrong-endpoint / bad-base64 are all dropped, never thrown.
    expect(() => medium.acceptNativeEvent({ endpointId: 'ep-1' })).not.toThrow();
    expect(() =>
      medium.acceptNativeEvent({ endpointId: 'other', message: btoa('x') }),
    ).not.toThrow();
    expect(() =>
      medium.acceptNativeEvent({ endpointId: 'ep-1', message: '!!notbase64' }),
    ).not.toThrow();
    expect(medium.takeInbound()).toBeNull();
  });
});

describe('courier channel registry (WS-R.15.4d)', () => {
  it('maps every channel to a distinct registered plugin name', () => {
    const names = Object.values(COURIER_CHANNEL_PLUGINS);
    expect(new Set(names).size).toBe(names.length);
    expect(COURIER_CHANNEL_PLUGINS.wifiDirect).toBe('WifiDirectCourier');
    expect(COURIER_CHANNEL_PLUGINS.bluetooth).toBe('BluetoothCourier');
    expect(COURIER_CHANNEL_PLUGINS.usb).toBe('UsbCourier');
  });

  it('records USB as physical-only and the radios as emulator-verifiable', () => {
    expect(COURIER_CHANNEL_INFO.usb.verification).toBe('physical_only');
    for (const ch of ['nearby', 'wifiDirect', 'bluetooth'] as const) {
      expect(COURIER_CHANNEL_INFO[ch].verification).toBe('emulator');
    }
  });

  it('resolves to null outside the native shell (no injected Capacitor)', () => {
    // jsdom has no `globalThis.Capacitor`, so every channel resolves to null.
    for (const ch of Object.keys(COURIER_CHANNEL_PLUGINS) as CourierChannel[]) {
      expect(resolveCourierChannel(ch)).toBeNull();
    }
  });

  it('every channel has a non-empty reveal-summary for the disclosure copy', () => {
    for (const info of Object.values(COURIER_CHANNEL_INFO)) {
      expect(info.revealsSummary.length).toBeGreaterThan(10);
    }
  });

  it('lists every channel and validates a channel name', () => {
    expect([...COURIER_CHANNELS].sort()).toEqual(['bluetooth', 'nearby', 'usb', 'wifiDirect']);
    expect(isCourierChannel('wifiDirect')).toBe(true);
    expect(isCourierChannel('not-a-channel')).toBe(false);
  });

  it('resolveCourierChannels yields the available plugins, fabricating none', () => {
    // jsdom has no injected Capacitor, so NO native channel resolves — selecting a channel
    // never fabricates availability.
    expect(resolveCourierChannels(['nearby', 'wifiDirect'])).toEqual([]);
    expect(resolveCourierChannels([])).toEqual([]); // empty ⇒ Nearby, still unresolvable here
    expect(resolveCourierChannels(['not-a-channel', 'usb'])).toEqual([]);
  });
});
