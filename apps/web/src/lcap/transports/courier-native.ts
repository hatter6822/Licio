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

/**
 * Which peers this device is willing to exchange with (the §22.5 "who can exchange"
 * control).  `anyone` accepts any discovered courier; `known_only` accepts only an
 * endpoint whose opaque endpoint id is in the user's allowlist (`allowedEndpointIds`);
 * `none` refuses every endpoint (advertise/discover may run, but no exchange is driven).
 */
export type CourierExchangePeers = 'anyone' | 'known_only' | 'none';

/**
 * The §22.5 sharing selection: WHICH rooms/priorities this device offers to peers.  The
 * courier is public-only at the seam, so this never widens beyond public content; it only
 * NARROWS what a willing device shares.  `roomHashAllowlist` is empty ⇒ all public rooms;
 * a non-empty allowlist shares only the listed opaque room hashes.  `maxPriorityClass`
 * caps the §15.1.1 priority offered (P0 = most essential; default 4 = all lanes).
 */
export interface CourierSharingSelection {
  /** Opaque room rendezvous hashes (hex) this device shares; empty ⇒ all public rooms. */
  readonly roomHashAllowlist: readonly string[];
  /** Highest (numerically largest) priority class offered (P0 most essential; 0..4). */
  readonly maxPriorityClass: 0 | 1 | 2 | 3 | 4;
}

export const DEFAULT_SHARING_SELECTION: CourierSharingSelection = {
  roomHashAllowlist: [],
  maxPriorityClass: 4,
};

export interface CourierRadioControls {
  /** Advertise this device as a courier (off by default). */
  readonly advertisingEnabled: boolean;
  /** Discover + connect to nearby couriers (off by default). */
  readonly discoveryEnabled: boolean;
  /**
   * WS-R.15.4d — which native radio channels (`nearby` / `wifiDirect` / `bluetooth` /
   * `usb`) the courier may drive.  An empty / absent list ⇒ Nearby only (the conservative
   * default that has the proven verification).  A channel that is not resolvable in the
   * current runtime is simply skipped; selecting one never claims it is available.  Stored
   * as plain channel-name strings so this module declares no cross-import to the channels
   * bridge (the strings are validated against the channel set at the controller seam).
   */
  readonly enabledChannels?: readonly string[];
  /** §22.5 who-can-exchange (default `anyone` for public content). */
  readonly exchangePeers?: CourierExchangePeers;
  /** §22.5 allowlist of opaque endpoint ids when `exchangePeers === 'known_only'`. */
  readonly allowedEndpointIds?: readonly string[];
  /** §22.5 sharing selection (rooms/priorities offered). */
  readonly sharing?: CourierSharingSelection;
  /**
   * §22.5 storage budget: a hard ceiling on the TOTAL bytes this device will ferry to
   * peers across the session.  `0` ⇒ unbounded (not recommended).  The controller refuses
   * to drive an exchange once the running total would exceed this.
   */
  readonly storageBudgetBytes?: number;
  /**
   * §22.5 battery budget: refuse to advertise/discover when the device battery is below
   * this floor (0..1).  `0` ⇒ no floor.  A device on charge bypasses the floor (the radio
   * cost is acceptable while plugged in).
   */
  readonly batteryFloor?: number;
}

export const DEFAULT_COURIER_CONTROLS: CourierRadioControls = {
  advertisingEnabled: false,
  discoveryEnabled: false,
  enabledChannels: ['nearby'],
  exchangePeers: 'anyone',
  allowedEndpointIds: [],
  sharing: DEFAULT_SHARING_SELECTION,
  storageBudgetBytes: 0,
  batteryFloor: 0,
};

export type CourierMode = 'minimal' | 'standard' | 'courier' | 'relay' | 'stealth' | 'emergency';

export type CourierBlockedReason =
  | ''
  | 'forced_off_in_mode'
  | 'disabled'
  | 'disclosure_unacknowledged'
  | 'below_battery_floor'
  | 'no_peers'
  // A selected native radio rejected startAdvertising/startDiscovery (permission denied or the
  // radio is unavailable); the controller tore the listeners/radios down, so this is reported in
  // place of a false "running" decision.
  | 'radio_unavailable';

export interface CourierStartDecision {
  readonly advertise: boolean;
  readonly discover: boolean;
  readonly blockedReason: CourierBlockedReason;
}

/** The live device-power reading the §22.5 battery budget gates on (all fields optional). */
export interface CourierPowerState {
  /** Battery level, 0..1 (the Battery Status API `level`); omit if unknown. */
  readonly level?: number;
  /** Whether the device is charging (omit if unknown — treated as not charging). */
  readonly charging?: boolean;
}

/**
 * Decide whether the courier radios may advertise/discover.  The order of gates is:
 *
 *   1. Stealth/Emergency FORCE both off regardless of the controls (§33.5) — no proximity
 *      radio ever reveals the device in a high-risk mode;
 *   2. neither advertise nor discover is enabled ⇒ `disabled` (the conservative default);
 *   3. the §22.5 radio-metadata disclosure has NOT been acknowledged ⇒
 *      `disclosure_unacknowledged` — a proximity radio must never start before the user has
 *      seen + accepted what it reveals.  This is enforced HERE (not only in the controls UI)
 *      so a non-UI caller cannot start the radios by constructing controls with the toggles on;
 *   4. `exchangePeers === 'none'` ⇒ `no_peers` (the user has explicitly opted to exchange
 *      with nobody, so running the radios would reveal the device for no benefit);
 *   5. the device battery is below the user's floor AND not charging ⇒ `below_battery_floor`
 *      (the §22.5 battery budget — running radios on a low, unplugged battery is refused).
 *
 * Pure + total: given the same controls/mode/power/ack it always returns the same decision.
 */
export function decideCourierStart(
  controls: CourierRadioControls,
  mode: CourierMode,
  power: CourierPowerState,
  disclosureAcknowledged: boolean,
): CourierStartDecision {
  if (mode === 'stealth' || mode === 'emergency') {
    return { advertise: false, discover: false, blockedReason: 'forced_off_in_mode' };
  }
  const advertise = controls.advertisingEnabled;
  const discover = controls.discoveryEnabled;
  if (!advertise && !discover)
    return { advertise: false, discover: false, blockedReason: 'disabled' };
  if (!disclosureAcknowledged)
    return { advertise: false, discover: false, blockedReason: 'disclosure_unacknowledged' };
  if ((controls.exchangePeers ?? 'anyone') === 'none')
    return { advertise: false, discover: false, blockedReason: 'no_peers' };
  const floor = controls.batteryFloor ?? 0;
  if (floor > 0 && !(power.charging ?? false) && typeof power.level === 'number') {
    if (power.level < floor)
      return { advertise: false, discover: false, blockedReason: 'below_battery_floor' };
  }
  return { advertise, discover, blockedReason: '' };
}

/**
 * Whether the controls permit driving an exchange with a specific discovered endpoint
 * (the §22.5 who-can-exchange gate, applied per connection).  `anyone` ⇒ always; `none`
 * ⇒ never; `known_only` ⇒ only when the endpoint id is in the allowlist.
 */
export function mayExchangeWithEndpoint(
  controls: CourierRadioControls,
  endpointId: string,
): boolean {
  switch (controls.exchangePeers ?? 'anyone') {
    case 'anyone':
      return true;
    case 'none':
      return false;
    case 'known_only':
      return (controls.allowedEndpointIds ?? []).includes(endpointId);
  }
}

/**
 * The §22.5 storage budget gate: whether ferrying `nextBytes` more would stay within the
 * session storage budget given `alreadySharedBytes` already ferried.  `0` budget ⇒
 * unbounded (always true).  The controller calls this before each exchange + accumulates.
 */
export function withinStorageBudget(
  controls: CourierRadioControls,
  alreadySharedBytes: number,
  nextBytes: number,
): boolean {
  const budget = controls.storageBudgetBytes ?? 0;
  if (budget <= 0) return true;
  return alreadySharedBytes + nextBytes <= budget;
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

/**
 * A `connectionResult` event: an endpoint id + whether the link is now open.  The
 * controller drives ONE exchange when `connected` first becomes true.  No radio/peer
 * identifier other than the live-connection endpoint id is read (it is a routing handle,
 * never stored to an LCAP schema — the check:lcap-schema-egress doctrine).
 */
export const nativeConnectionEventSchema = z
  .object({
    endpointId: z.string().min(1).max(256),
    connected: z.boolean(),
  })
  .strict();
export type NativeConnectionEvent = z.infer<typeof nativeConnectionEventSchema>;

/** A `disconnected` event: an endpoint id whose link has dropped. */
export const nativeDisconnectEventSchema = z
  .object({ endpointId: z.string().min(1).max(256) })
  .strict();
export type NativeDisconnectEvent = z.infer<typeof nativeDisconnectEventSchema>;

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
  private sentBytes = 0;

  constructor(
    private readonly plugin: NearbyCourierPlugin,
    private readonly endpointId: string,
  ) {}

  /** Total outbound bytes handed to the native ferry over this medium (storage budget). */
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
