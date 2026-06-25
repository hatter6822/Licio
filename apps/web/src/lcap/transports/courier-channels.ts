// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4d — the additional native courier RADIO CHANNELS (OFFLINE_SPEC §22.5).  The
// §22.5 profile lists five media: Nearby Connections (shipped, `courier-native.ts`),
// Wi-Fi Direct, Bluetooth (RFCOMM/BLE), local hotspot, and USB import/export.  This file
// adds the TS `CourierMedium` bridges for the three remaining native radios, each over
// its OWN typed Capacitor plugin reached through the INJECTED `globalThis.Capacitor`
// bridge (NO `@capacitor/core` npm import, so the web < 15-dep budget + initial-bundle gate
// hold; in a normal browser they are simply unavailable).
//
// Every channel shares the SAME contract as Nearby:
//   * a DUMB byte pipe — no content validation here; every frame is re-validated against
//     its CIDs/COSE signatures downstream (§18.4, no transport trust);
//   * PUBLIC-ONLY at the seam (`CourierTransport.capabilities.carriesPrivate === false`);
//   * the JS↔native boundary is base64 + zod-validated, fail-closed on a malformed event;
//   * no radio/peer identifier ever enters an LCAP schema (endpoint id = a live routing
//     handle only — the check:lcap-schema-egress doctrine);
//   * off by default, gated by the same §22.5 controls + `decideCourierStart`.
//
// Verification reach: Wi-Fi Direct + Bluetooth are exercisable on the netsim emulated
// radios (the same bus the Nearby radio E2E uses, WS-R.15.4f).  USB is OTG-physical-only
// — there is no emulated USB-accessory bus — so its plugin is documented as physical-OTG-
// verified-only; the TS bridge here is identical in shape and fail-closed regardless.

import type { z } from 'zod';
import { devWarn } from '../../lib/dev-log.js';
import type { CourierMedium } from './courier.js';
import { type NearbyCourierPlugin, nativePayloadEventSchema } from './courier-native.js';

// --- the injected Capacitor bridge (no npm import) ---------------------------------

interface CapacitorGlobal {
  isNativePlatform?(): boolean;
  registerPlugin?<T>(name: string): T;
}

function capacitor(): CapacitorGlobal | undefined {
  return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/**
 * Resolve a typed native courier plugin by its registered Capacitor name, or `null`
 * outside the native shell.  Every native courier channel exposes the SAME method/event
 * surface (`NearbyCourierPlugin`), so one resolver serves all of them.
 */
export function resolveNativeChannelPlugin(name: string): NearbyCourierPlugin | null {
  const c = capacitor();
  if (!c?.registerPlugin || !(c.isNativePlatform?.() ?? false)) return null;
  return c.registerPlugin<NearbyCourierPlugin>(name);
}

/** The registered Capacitor plugin name for each native courier radio channel. */
export const COURIER_CHANNEL_PLUGINS = {
  /** WS-R.15.4c — Google Nearby Connections (emulator-verified via netsim). */
  nearby: 'NearbyCourier',
  /** WS-R.15.4d — Wi-Fi Direct (WifiP2pManager; emulator-verifiable via virtio-wifi). */
  wifiDirect: 'WifiDirectCourier',
  /** WS-R.15.4d — Bluetooth RFCOMM + BLE GATT fallback (emulator-verifiable via netsim). */
  bluetooth: 'BluetoothCourier',
  /** WS-R.15.4d — USB accessory/host bulk transfer (PHYSICAL OTG only — no emulated bus). */
  usb: 'UsbCourier',
} as const;

export type CourierChannel = keyof typeof COURIER_CHANNEL_PLUGINS;

/** Every known courier channel (the selection-completeness pin + the controls list). */
export const COURIER_CHANNELS = Object.keys(COURIER_CHANNEL_PLUGINS) as readonly CourierChannel[];

/** Whether a string is a known courier channel (validates a persisted controls slice). */
export function isCourierChannel(value: string): value is CourierChannel {
  return Object.hasOwn(COURIER_CHANNEL_PLUGINS, value);
}

/** Whether a given channel's plugin is resolvable in the current runtime. */
export function resolveCourierChannel(channel: CourierChannel): NearbyCourierPlugin | null {
  return resolveNativeChannelPlugin(COURIER_CHANNEL_PLUGINS[channel]);
}

/** A resolved courier channel: its tag + the native plugin that drives it. */
export interface ResolvedCourierChannel {
  readonly channel: CourierChannel;
  readonly plugin: NearbyCourierPlugin;
}

/**
 * Resolve the requested channels to the ones actually available in this runtime.  An
 * unknown channel name is ignored; a channel whose native plugin is not resolvable (e.g.
 * in a normal browser, or a radio the device lacks) is simply absent from the result —
 * selecting a channel never fabricates availability.  An empty / absent request falls back
 * to the `nearby` channel (the proven default).  Order is preserved + de-duplicated.
 */
export function resolveCourierChannels(requested?: readonly string[]): ResolvedCourierChannel[] {
  const names = requested && requested.length > 0 ? requested : ['nearby'];
  const seen = new Set<CourierChannel>();
  const out: ResolvedCourierChannel[] = [];
  for (const name of names) {
    if (!isCourierChannel(name) || seen.has(name)) continue;
    seen.add(name);
    const plugin = resolveCourierChannel(name);
    if (plugin) out.push({ channel: name, plugin });
  }
  return out;
}

// --- the shared base64 boundary ----------------------------------------------------

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary);
}

/**
 * A `CourierMedium` over ONE connected endpoint on ANY native courier channel (Wi-Fi
 * Direct / Bluetooth / USB).  Identical in shape to `NearbyEndpointMedium` but channel-
 * tagged for observability.  Outbound bytes are base64-bridged to the channel plugin's
 * `send`; inbound `payloadReceived` events for THIS endpoint are zod-validated,
 * base64-decoded back to exact bytes, and delivered to a pending `receive`.  Fail-closed
 * on a malformed native event (dropped, never decoded, never crashes the shell).
 */
export class NativeChannelMedium implements CourierMedium {
  private readonly inbox: Uint8Array[] = [];
  private listeners: Array<() => void> = [];
  private sentBytes = 0;

  constructor(
    private readonly plugin: NearbyCourierPlugin,
    private readonly endpointId: string,
    readonly channel: CourierChannel,
  ) {}

  bytesSent(): number {
    return this.sentBytes;
  }

  enqueueOutbound(message: Uint8Array): void {
    this.sentBytes += message.byteLength;
    void this.plugin
      .send({ endpointId: this.endpointId, message: encodeBase64(message) })
      .catch(() => {
        /* a failed ferry send is non-fatal; the seam falls back to another transport */
      });
  }

  takeInbound(): Uint8Array | null {
    return this.inbox.shift() ?? null;
  }

  onInbound(listener: () => void): void {
    this.listeners.push(listener);
  }

  /** Feed a raw native `payloadReceived` event; fail-closed on anything malformed. */
  acceptNativeEvent(raw: unknown): void {
    const parsed = nativePayloadEventSchema.safeParse(raw);
    if (!parsed.success || parsed.data.endpointId !== this.endpointId) return;
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(parsed.data.message);
    } catch (error) {
      // The native bridge base64-encodes every payload, so a decode failure is a real bug, not
      // expected input — surface it in dev rather than dropping the frame silently.
      devWarn('dropped a courier payload with malformed base64', error);
      return;
    }
    this.inbox.push(bytes);
    const listeners = this.listeners;
    this.listeners = [];
    for (const listener of listeners) listener();
  }
}

/** Metadata describing one native channel — for the controls UI + the disclosure copy. */
export interface CourierChannelInfo {
  readonly channel: CourierChannel;
  readonly pluginName: string;
  /** Emulator-verifiable (netsim/virtio) vs. physical-hardware-only (USB OTG). */
  readonly verification: 'emulator' | 'physical_only';
  /** What a peer/observer can see while this radio runs (the disclosure copy seed). */
  readonly revealsSummary: string;
}

export const COURIER_CHANNEL_INFO: Readonly<Record<CourierChannel, CourierChannelInfo>> = {
  nearby: {
    channel: 'nearby',
    pluginName: COURIER_CHANNEL_PLUGINS.nearby,
    verification: 'emulator',
    revealsSummary:
      'A nearby device can see this device advertising as a courier and your chosen device name.',
  },
  wifiDirect: {
    channel: 'wifiDirect',
    pluginName: COURIER_CHANNEL_PLUGINS.wifiDirect,
    verification: 'emulator',
    revealsSummary:
      'Wi-Fi Direct broadcasts a discoverable device name and MAC-derived address to nearby devices.',
  },
  bluetooth: {
    channel: 'bluetooth',
    pluginName: COURIER_CHANNEL_PLUGINS.bluetooth,
    verification: 'emulator',
    revealsSummary:
      'Bluetooth advertising exposes a device name and address to anything scanning nearby.',
  },
  usb: {
    channel: 'usb',
    pluginName: COURIER_CHANNEL_PLUGINS.usb,
    verification: 'physical_only',
    revealsSummary:
      'USB transfer requires a physical cable to a device you connect — nothing is broadcast over the air.',
  },
};

/** The schema-validated channel event the plugins emit (reused payload boundary). */
export const nativeChannelPayloadEventSchema = nativePayloadEventSchema;
export type NativeChannelPayloadEvent = z.infer<typeof nativeChannelPayloadEventSchema>;
