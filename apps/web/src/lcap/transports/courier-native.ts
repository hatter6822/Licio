// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4c/e — the TS side of the native Nearby Connections courier (OFFLINE_SPEC
// §22.5).  This lives in apps/web (NOT apps/courier) so it is part of the byte-identical
// web build the courier WebView loads (the no-fork gate); it reaches the native plugin
// through the Capacitor bridge INJECTED ONTO `globalThis.Capacitor` in the WebView —
// there is NO `@capacitor/core` npm import, so the web <15-dep budget + the initial-
// bundle gate are untouched, and in a normal browser (no shell) the courier is simply
// unavailable.
//
// Doctrine (WS-R.15.4e):
//   * The radios are OFF by default; `decideCourierStart` gates advertise/discover and
//     FORCES both off in Stealth/Emergency (§33.5) — proven by unit tests.
//   * The courier is PUBLIC-ONLY (`carriesPrivate:false`); private-content exclusion is
//     structural at the seam (`transportMayCarry`), so this medium never carries a
//     non-public pack — the §22.5 control here is about WHETHER the radios run at all.
//   * The JS↔native boundary is zod-validated + base64-bridged: a malformed native
//     payload FAILS CLOSED (dropped, never decoded to bytes) and never crashes the shell.
//   * No radio/peer identifier (endpoint id) is ever written to an LCAP schema — it is a
//     live-connection routing handle only (the check:lcap-schema-egress doctrine).

import { z } from 'zod';
import type { CourierMedium } from './courier.js';

// --- §22.5 / §33.5 control gating (pure) -------------------------------------------

export interface CourierRadioControls {
  /** Advertise this device as a courier (off by default). */
  readonly advertisingEnabled: boolean;
  /** Discover + connect to nearby couriers (off by default). */
  readonly discoveryEnabled: boolean;
}

export const DEFAULT_COURIER_CONTROLS: CourierRadioControls = {
  advertisingEnabled: false,
  discoveryEnabled: false,
};

export type CourierMode = 'minimal' | 'standard' | 'courier' | 'relay' | 'stealth' | 'emergency';

export interface CourierStartDecision {
  readonly advertise: boolean;
  readonly discover: boolean;
  readonly blockedReason: '' | 'forced_off_in_mode' | 'disabled';
}

/**
 * Decide whether the courier radios may advertise/discover.  Stealth and Emergency FORCE
 * both off regardless of the controls (no proximity radio reveals the device, §33.5);
 * otherwise the conservative defaults + the user's explicit controls decide.
 */
export function decideCourierStart(
  controls: CourierRadioControls,
  mode: CourierMode,
): CourierStartDecision {
  if (mode === 'stealth' || mode === 'emergency') {
    return { advertise: false, discover: false, blockedReason: 'forced_off_in_mode' };
  }
  const advertise = controls.advertisingEnabled;
  const discover = controls.discoveryEnabled;
  if (!advertise && !discover)
    return { advertise: false, discover: false, blockedReason: 'disabled' };
  return { advertise, discover, blockedReason: '' };
}

// --- the injected Capacitor bridge (no npm import) ---------------------------------

interface CapacitorPluginListenerHandle {
  remove(): Promise<void> | void;
}

/** The strict typed surface of the native `NearbyCourier` plugin (Java side). */
export interface NearbyCourierPlugin {
  startAdvertising(options?: { serviceId?: string; endpointName?: string }): Promise<void>;
  startDiscovery(options?: { serviceId?: string; endpointName?: string }): Promise<void>;
  stop(): Promise<void>;
  send(options: { endpointId: string; message: string }): Promise<void>;
  addListener(
    eventName: string,
    listener: (event: unknown) => void,
  ): Promise<CapacitorPluginListenerHandle> | CapacitorPluginListenerHandle;
}

interface CapacitorGlobal {
  isNativePlatform?(): boolean;
  registerPlugin?<T>(name: string): T;
}

function capacitor(): CapacitorGlobal | undefined {
  return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/** True only inside the native courier WebView with the bridge injected. */
export function nearbyCourierAvailable(): boolean {
  const c = capacitor();
  return Boolean(c?.registerPlugin && (c.isNativePlatform?.() ?? false));
}

/** Resolve the typed native plugin proxy, or `null` outside the native shell. */
export function resolveNearbyCourierPlugin(): NearbyCourierPlugin | null {
  const c = capacitor();
  if (!c?.registerPlugin || !(c.isNativePlatform?.() ?? false)) return null;
  return c.registerPlugin<NearbyCourierPlugin>('NearbyCourier');
}

// --- the zod-validated native payload boundary -------------------------------------

/** A `payloadReceived` event from the native side: an endpoint id + base64 bytes. */
export const nativePayloadEventSchema = z
  .object({
    endpointId: z.string().min(1).max(256),
    message: z.string().max(96 * 1024 * 1024), // base64 of a bounded pack
  })
  .strict();
export type NativePayloadEvent = z.infer<typeof nativePayloadEventSchema>;

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
 * A `CourierMedium` bound to ONE connected Nearby endpoint.  Outbound bytes are
 * base64-bridged to the native `send`; inbound `payloadReceived` events for THIS endpoint
 * are zod-validated, base64-decoded back to exact bytes (so CID/AEAD verification holds
 * downstream), and delivered to a pending `receive`.  A malformed native event is dropped
 * (fail-closed) — never decoded, never crashes the shell.
 */
export class NearbyEndpointMedium implements CourierMedium {
  private readonly inbox: Uint8Array[] = [];
  private listeners: Array<() => void> = [];

  constructor(
    private readonly plugin: NearbyCourierPlugin,
    private readonly endpointId: string,
  ) {}

  enqueueOutbound(message: Uint8Array): void {
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
    if (!parsed.success || parsed.data.endpointId !== this.endpointId) return; // not for us / malformed
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(parsed.data.message);
    } catch {
      return; // not valid base64 — drop
    }
    this.inbox.push(bytes);
    const listeners = this.listeners;
    this.listeners = [];
    for (const listener of listeners) listener();
  }
}
