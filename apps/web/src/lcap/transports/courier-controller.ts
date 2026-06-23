// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4c/e — the courier ORCHESTRATION controller (OFFLINE_SPEC §22.5, §16, §22.6).
//
// Until now the native Nearby Connections plugin (`NearbyCourierPlugin.java`) and its TS
// bridge (`NearbyEndpointMedium`, `decideCourierStart`) existed but had NO runtime caller
// — the plugin was never DRIVEN through the app.  This controller closes that gap: it
//
//   1. resolves the injected native plugin (or no-ops outside the courier shell);
//   2. applies `decideCourierStart` (off by default; Stealth/Emergency force-off; the
//      §22.5 battery floor + who-can-exchange gates) and starts advertising/discovery
//      ONLY where allowed;
//   3. listens to the plugin's connection-lifecycle + payload events; on each connected
//      endpoint it constructs a `NearbyEndpointMedium`, wraps it in the seam's
//      `CourierTransport`, and runs ONE §16 LCAP exchange through the registry's
//      `offlineExchange` — PUBLIC-ONLY carriage (the courier seam refuses non-public
//      packs structurally), the always-correct HTTPS anchor appended LAST so correctness
//      never depends on the courier;
//   4. routes each `payloadReceived` event to the right per-endpoint medium
//      (`acceptNativeEvent`, fail-closed on a malformed native event);
//   5. enforces the §22.5 who-can-exchange + storage-budget controls per connection;
//   6. stops cleanly (removes every listener, stops the radios, drops the mediums).
//
// The bytes never gain trust from the radio: every frame the exchange receives is
// re-validated downstream against its CIDs/COSE signatures (§18.4, no transport trust).
// No radio/peer identifier ever enters an LCAP schema — the endpoint id is a live-
// connection routing handle only (the check:lcap-schema-egress doctrine).  This file
// imports `@licio/lcap` types/values only (NEVER `@licio/lcap-p2p`), so it stays off the
// code-split P2P chunk (`check:lcap-p2p-split`).

import type { LcapTransport } from '@licio/lcap';
import { CourierTransport } from './courier.js';
import {
  type CourierMode,
  type CourierPowerState,
  type CourierRadioControls,
  type CourierStartDecision,
  decideCourierStart,
  mayExchangeWithEndpoint,
  type NativeConnectionEvent,
  type NativeDisconnectEvent,
  type NativePayloadEvent,
  type NearbyCourierPlugin,
  NearbyEndpointMedium,
  nativeConnectionEventSchema,
  nativeDisconnectEventSchema,
  nativePayloadEventSchema,
  withinStorageBudget,
} from './courier-native.js';
import type { HttpsTransportConfig } from './https.js';
import { buildServerTransports, offlineExchange } from './registry.js';

/** A Capacitor listener handle (returned by `addListener`). */
interface ListenerHandle {
  remove(): Promise<void> | void;
}

/**
 * Build the §16 exchange REQUEST body for a freshly connected courier peer.  The app
 * supplies this (it knows the room frontier the device wants to reconcile); the
 * controller is transport-only and never assembles content itself.  Returns `null` to
 * skip driving an exchange with this endpoint (e.g. nothing to reconcile).
 */
export type CourierRequestBuilder = (endpointId: string) => Uint8Array | null;

/** Notified when a courier exchange over an endpoint completes (or fails / is skipped). */
export interface CourierExchangeOutcome {
  readonly endpointId: string;
  /** The seam transport that carried it (`'courier'` when the peer answered; `'https'`
   *  when the courier peer produced nothing and the anchor answered), or `null`. */
  readonly carriedBy: 'courier' | 'https' | 'webtransport' | 'webrtc' | 'ipfs_bridge' | 'qr' | null;
  /** The peer's §16 exchange response body, when one was returned. */
  readonly response: Uint8Array | null;
  /** Why no exchange was driven, when `carriedBy` is null. */
  readonly skippedReason:
    | ''
    | 'not_allowed_peer'
    | 'over_storage_budget'
    | 'nothing_to_request'
    | 'exchange_failed';
}

export interface CourierControllerConfig {
  /** The resolved native plugin (caller passes `resolveNearbyCourierPlugin()`). */
  readonly plugin: NearbyCourierPlugin;
  /** The §22.5 radio controls (off by default). */
  readonly controls: CourierRadioControls;
  /** The current §33 operational mode (Stealth/Emergency force the radios off). */
  readonly mode: CourierMode;
  /** The live device power reading the battery floor gates on. */
  readonly power?: CourierPowerState;
  /** Build the §16 exchange request for a connected peer. */
  readonly buildRequest: CourierRequestBuilder;
  /** HTTPS anchor config (exchange URL + injectable fetch) for the fallback leg. */
  readonly httpsConfig?: HttpsTransportConfig;
  /** Notified after each per-endpoint exchange outcome (observability / UI). */
  readonly onOutcome?: (outcome: CourierExchangeOutcome) => void;
  /** Optional service id / endpoint name passed to the radios. */
  readonly serviceId?: string;
  readonly endpointName?: string;
}

/**
 * Drive the native Nearby courier through one or more live §16 exchanges.  Construct,
 * call {@link start} (idempotent — a no-op if the controls/mode disallow the radios), and
 * {@link stop} to tear everything down.  The controller is single-session: it tracks a
 * medium per live endpoint and a running ferried-byte total against the storage budget.
 */
export class CourierController {
  private readonly mediums = new Map<string, NearbyEndpointMedium>();
  /** Endpoints we have already driven an exchange for (one per connection). */
  private readonly exchanged = new Set<string>();
  private readonly handles: ListenerHandle[] = [];
  private sharedBytes = 0;
  private running = false;
  private decision: CourierStartDecision = {
    advertise: false,
    discover: false,
    blockedReason: 'disabled',
  };

  constructor(private readonly config: CourierControllerConfig) {}

  /** The decision computed at the most recent {@link start} (for the UI to surface). */
  startDecision(): CourierStartDecision {
    return this.decision;
  }

  /** Whether the radios are currently running. */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Start the courier: compute the §22.5/§33.5 decision, and — only if it permits —
   * register the event listeners and start advertising/discovery.  A blocked decision is
   * a clean no-op (no listeners, no radios).  Idempotent: a second call while running
   * does nothing.
   */
  async start(): Promise<CourierStartDecision> {
    if (this.running) return this.decision;
    this.decision = decideCourierStart(
      this.config.controls,
      this.config.mode,
      this.config.power ?? {},
    );
    if (!this.decision.advertise && !this.decision.discover) return this.decision;

    // Register listeners BEFORE starting the radios so no early event is missed.
    await this.addListener('connectionResult', (raw) => this.onConnectionResult(raw));
    await this.addListener('payloadReceived', (raw) => this.onPayloadReceived(raw));
    await this.addListener('disconnected', (raw) => this.onDisconnected(raw));

    const radioOptions = {
      ...(this.config.serviceId !== undefined ? { serviceId: this.config.serviceId } : {}),
      ...(this.config.endpointName !== undefined ? { endpointName: this.config.endpointName } : {}),
    };
    this.running = true;
    try {
      if (this.decision.advertise) await this.config.plugin.startAdvertising(radioOptions);
      if (this.decision.discover) await this.config.plugin.startDiscovery(radioOptions);
    } catch {
      // A radio that refuses to start is non-fatal — the seam still has the HTTPS anchor.
      await this.stop();
    }
    return this.decision;
  }

  /** Stop the radios, remove every listener, and drop the per-endpoint mediums. */
  async stop(): Promise<void> {
    this.running = false;
    for (const handle of this.handles.splice(0)) {
      try {
        await handle.remove();
      } catch {
        /* removing a listener must never throw out of teardown */
      }
    }
    try {
      await this.config.plugin.stop();
    } catch {
      /* stopping a radio that never started is fine */
    }
    this.mediums.clear();
    this.exchanged.clear();
  }

  private async addListener(event: string, listener: (raw: unknown) => void): Promise<void> {
    const handle = await this.config.plugin.addListener(event, listener);
    this.handles.push(handle);
  }

  /** A `connectionResult`: when an endpoint first connects, drive ONE exchange over it. */
  private onConnectionResult(raw: unknown): void {
    const parsed = nativeConnectionEventSchema.safeParse(raw);
    if (!parsed.success) return; // fail-closed on a malformed native event
    const event: NativeConnectionEvent = parsed.data;
    if (!event.connected) return;
    if (this.exchanged.has(event.endpointId)) return; // one exchange per connection
    void this.driveExchange(event.endpointId);
  }

  /** A `payloadReceived`: route it to the right per-endpoint medium (fail-closed). */
  private onPayloadReceived(raw: unknown): void {
    const parsed = nativePayloadEventSchema.safeParse(raw);
    if (!parsed.success) return; // malformed — drop, never decode
    const event: NativePayloadEvent = parsed.data;
    // Lazily create the medium if a payload arrives before we observed the connection
    // (Nearby may deliver a payload very promptly); the exchange driver reuses it.
    const medium = this.mediumFor(event.endpointId);
    medium.acceptNativeEvent(event);
  }

  /** A `disconnected`: drop the endpoint's medium so a later reconnect starts fresh. */
  private onDisconnected(raw: unknown): void {
    const parsed = nativeDisconnectEventSchema.safeParse(raw);
    if (!parsed.success) return;
    const event: NativeDisconnectEvent = parsed.data;
    this.mediums.delete(event.endpointId);
    this.exchanged.delete(event.endpointId);
  }

  private mediumFor(endpointId: string): NearbyEndpointMedium {
    let medium = this.mediums.get(endpointId);
    if (!medium) {
      medium = new NearbyEndpointMedium(this.config.plugin, endpointId);
      this.mediums.set(endpointId, medium);
    }
    return medium;
  }

  /**
   * Construct a per-endpoint `CourierTransport` over the `NearbyEndpointMedium`, append
   * the always-correct HTTPS anchor LAST, and run ONE §16 PUBLIC exchange through
   * `offlineExchange`.  Applies the §22.5 who-can-exchange + storage-budget gates first.
   */
  private async driveExchange(endpointId: string): Promise<void> {
    if (this.exchanged.has(endpointId)) return;
    this.exchanged.add(endpointId);

    if (!mayExchangeWithEndpoint(this.config.controls, endpointId)) {
      this.emit(endpointId, null, null, 'not_allowed_peer');
      return;
    }

    const request = this.config.buildRequest(endpointId);
    if (!request) {
      this.emit(endpointId, null, null, 'nothing_to_request');
      return;
    }

    if (!withinStorageBudget(this.config.controls, this.sharedBytes, request.byteLength)) {
      this.emit(endpointId, null, null, 'over_storage_budget');
      return;
    }

    const medium = this.mediumFor(endpointId);
    // The courier transport over THIS endpoint, then the always-correct HTTPS anchor.
    const transports: LcapTransport[] = [new CourierTransport(medium)];
    for (const t of buildServerTransports(this.config.httpsConfig ?? {})) transports.push(t);

    let result: { transport: CourierExchangeOutcome['carriedBy']; response: Uint8Array } | null;
    try {
      // PUBLIC-ONLY: the courier seam (`carriesPrivate:false`) structurally refuses any
      // non-public pack, so the public label here is the only one a courier ever carries.
      result = await offlineExchange(transports, request, undefined, 'public');
    } catch {
      this.emit(endpointId, null, null, 'exchange_failed');
      return;
    }

    // Account the bytes actually ferried over the medium against the storage budget.
    this.sharedBytes += medium.bytesSent();

    if (!result) {
      this.emit(endpointId, null, null, 'exchange_failed');
      return;
    }
    this.emit(endpointId, result.transport, result.response, '');
  }

  private emit(
    endpointId: string,
    carriedBy: CourierExchangeOutcome['carriedBy'],
    response: Uint8Array | null,
    skippedReason: CourierExchangeOutcome['skippedReason'],
  ): void {
    this.config.onOutcome?.({ endpointId, carriedBy, response, skippedReason });
  }
}

/**
 * Read the device battery as a {@link CourierPowerState}, using the Battery Status API
 * when present.  Returns an empty reading (no level / not charging) when the API is
 * unavailable, so the battery-floor gate simply does not fire (it requires a known level).
 */
export async function readCourierPower(): Promise<CourierPowerState> {
  const nav = (globalThis as { navigator?: { getBattery?: () => Promise<unknown> } }).navigator;
  if (!nav?.getBattery) return {};
  try {
    const battery = (await nav.getBattery()) as { level?: unknown; charging?: unknown };
    const out: CourierPowerState = {
      ...(typeof battery.level === 'number' ? { level: battery.level } : {}),
      ...(typeof battery.charging === 'boolean' ? { charging: battery.charging } : {}),
    };
    return out;
  } catch {
    return {};
  }
}
