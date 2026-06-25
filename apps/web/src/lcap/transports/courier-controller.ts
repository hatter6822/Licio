// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4c/d/e — the courier ORCHESTRATION controller (OFFLINE_SPEC §22.5, §16, §22.6).
//
// Until now the native courier plugins (`NearbyCourierPlugin.java` + the WS-R.15.4d
// `WifiDirectCourierPlugin`/`BluetoothCourierPlugin`/`UsbCourierPlugin`) and their TS
// bridges (`NearbyEndpointMedium`/`NativeChannelMedium`, `decideCourierStart`) existed but
// had NO runtime caller — the plugins were never DRIVEN through the app.  This controller
// closes that gap: it
//
//   1. resolves one or more injected native channel plugins (or no-ops outside the courier
//      shell) — EVERY §22.5 radio (Nearby + Wi-Fi Direct + Bluetooth + USB) rides the SAME
//      orchestration, selected by `channels`; back-compat: a bare `plugin` ⇒ Nearby only;
//   2. applies `decideCourierStart` (off by default; Stealth/Emergency force-off; the
//      §22.5 battery floor + who-can-exchange gates) and starts advertising/discovery on
//      EACH selected channel ONLY where allowed;
//   3. listens to each channel plugin's connection-lifecycle + payload events; on each
//      connected endpoint it constructs that channel's `CourierMedium` (a
//      `NativeChannelMedium` tagged with the channel), wraps it in the seam's
//      `CourierTransport`, and runs ONE §16 LCAP exchange through the registry's
//      `offlineExchange` — PUBLIC-ONLY carriage (the courier seam refuses non-public
//      packs structurally), the always-correct HTTPS anchor appended LAST so correctness
//      never depends on the courier;
//   4. routes each `payloadReceived` event to the right per-(channel,endpoint) medium
//      (`acceptNativeEvent`, fail-closed on a malformed native event);
//   5. enforces the §22.5 who-can-exchange + storage-budget controls per connection;
//   6. stops cleanly (removes every listener, stops every radio, drops the mediums).
//
// The bytes never gain trust from the radio: every frame the exchange receives is
// re-validated downstream against its CIDs/COSE signatures (§18.4, no transport trust).
// No radio/peer identifier ever enters an LCAP schema — the endpoint id is a live-
// connection routing handle only (the check:lcap-schema-egress doctrine).  This file
// imports `@licio/lcap` types/values only (NEVER `@licio/lcap-p2p`), so it stays off the
// code-split P2P chunk (`check:lcap-p2p-split`).

import type { LcapTransport } from '@licio/lcap';
import { devWarn } from '../../lib/dev-log.js';
import type { CourierMedium } from './courier.js';
import { CourierTransport } from './courier.js';
import { type CourierChannel, NativeChannelMedium } from './courier-channels.js';
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
  nativeConnectionEventSchema,
  nativeDisconnectEventSchema,
  nativePayloadEventSchema,
  withinStorageBudget,
} from './courier-native.js';
import type { HttpsTransportConfig } from './https.js';
import { buildServerTransports, offlineExchange } from './registry.js';

/** The max wall-clock a single courier leg may block before the exchange falls through to the
 *  HTTPS anchor.  A connected medium whose peer never sends a response must NOT stall sync
 *  forever — the courier is delay-tolerant, but per-attempt it is bounded so the always-correct
 *  server transports still get to run. */
const COURIER_LEG_TIMEOUT_MS = 20_000;

/**
 * Bound a transport's BLOCKING ops (`open`/`receive`) with a deadline: a hung leg rejects (so
 * `fallbackExchange` moves to the next transport) rather than waiting indefinitely.  `send` is
 * fire-and-forget over the medium; `close` runs in the exchange's `finally`, which unblocks any
 * pending `receive`.  Robust by construction — it does not depend on the inner transport
 * honouring the `AbortSignal`.
 */
function withLegTimeout(inner: LcapTransport, ms: number): LcapTransport {
  const race = <T>(op: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('courier_leg_timeout')), ms);
    });
    return Promise.race([op, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  };
  return {
    capabilities: inner.capabilities,
    open: (signal) => race(inner.open(signal)),
    send: (message) => inner.send(message),
    receive: (signal) => race(inner.receive(signal)),
    close: () => inner.close(),
  };
}

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
  /** Which native radio channel the endpoint connected on (`nearby` by default). */
  readonly channel: CourierChannel;
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

/**
 * One selected native courier RADIO CHANNEL: its `CourierChannel` tag (for observability +
 * the per-channel medium) and its resolved native plugin.  WS-R.15.4d makes every radio
 * (Nearby / Wi-Fi Direct / Bluetooth / USB) drive identically — the controller starts each
 * one's radios and routes each one's events through the SAME orchestration.
 */
export interface CourierChannelPlugin {
  readonly channel: CourierChannel;
  readonly plugin: NearbyCourierPlugin;
}

export interface CourierControllerConfig {
  /**
   * The resolved native plugin for the Nearby channel (back-compat: a bare `plugin` ⇒ the
   * controller drives the `nearby` channel only).  Prefer {@link channels} to drive the
   * WS-R.15.4d Wi-Fi Direct / Bluetooth / USB radios as well.  Exactly one of `plugin` /
   * `channels` must be supplied.
   */
  readonly plugin?: NearbyCourierPlugin;
  /**
   * The selected native channels to drive (each its own resolved plugin).  The controller
   * starts every channel's radios and routes every channel's events identically.
   */
  readonly channels?: readonly CourierChannelPlugin[];
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
  /** The selected channels, each with its resolved plugin (Nearby-only by default). */
  private readonly channels: readonly CourierChannelPlugin[];
  /** A per-endpoint medium keyed by `channel\0endpointId` (channels share no namespace). */
  private readonly mediums = new Map<string, NativeChannelMedium>();
  /** `(channel,endpoint)` keys we have already driven an exchange for (one per connection). */
  private readonly exchanged = new Set<string>();
  private readonly handles: ListenerHandle[] = [];
  private sharedBytes = 0;
  private running = false;
  private decision: CourierStartDecision = {
    advertise: false,
    discover: false,
    blockedReason: 'disabled',
  };

  constructor(private readonly config: CourierControllerConfig) {
    if (config.channels && config.channels.length > 0) {
      this.channels = config.channels;
    } else if (config.plugin) {
      this.channels = [{ channel: 'nearby', plugin: config.plugin }];
    } else {
      this.channels = [];
    }
  }

  /** The decision computed at the most recent {@link start} (for the UI to surface). */
  startDecision(): CourierStartDecision {
    return this.decision;
  }

  /** Whether the radios are currently running. */
  isRunning(): boolean {
    return this.running;
  }

  /** The channels this controller drives (each its own native radio). */
  activeChannels(): readonly CourierChannel[] {
    return this.channels.map((c) => c.channel);
  }

  /**
   * Start the courier: compute the §22.5/§33.5 decision, and — only if it permits —
   * register the event listeners and start advertising/discovery on EVERY selected
   * channel.  A blocked decision (or no resolved channels) is a clean no-op (no listeners,
   * no radios).  Idempotent: a second call while running does nothing.
   */
  async start(): Promise<CourierStartDecision> {
    if (this.running) return this.decision;
    this.decision = decideCourierStart(
      this.config.controls,
      this.config.mode,
      this.config.power ?? {},
    );
    if (!this.decision.advertise && !this.decision.discover) return this.decision;
    if (this.channels.length === 0) return this.decision; // nothing to drive

    // Register listeners on EVERY channel BEFORE starting any radio so no early event is
    // missed.  Each listener carries its channel so an event routes to the right medium.
    for (const { channel, plugin } of this.channels) {
      await this.addListener(plugin, 'connectionResult', (raw) =>
        this.onConnectionResult(channel, raw),
      );
      await this.addListener(plugin, 'payloadReceived', (raw) =>
        this.onPayloadReceived(channel, raw),
      );
      await this.addListener(plugin, 'disconnected', (raw) => this.onDisconnected(channel, raw));
      // A radio's start is ASYNC: GMS/Wi-Fi Direct may reject it AFTER startAdvertising/Discovery
      // resolves (the sync try/catch below can't see that).  Consume the native `startFailed`
      // event so a late refusal is not believed-running but surfaced as radio_unavailable.
      await this.addListener(plugin, 'startFailed', (raw) => void this.onStartFailed(channel, raw));
    }

    const radioOptions = {
      ...(this.config.serviceId !== undefined ? { serviceId: this.config.serviceId } : {}),
      ...(this.config.endpointName !== undefined ? { endpointName: this.config.endpointName } : {}),
    };
    this.running = true;
    try {
      for (const { plugin } of this.channels) {
        if (this.decision.advertise) await plugin.startAdvertising(radioOptions);
        if (this.decision.discover) await plugin.startDiscovery(radioOptions);
      }
    } catch (error) {
      // A radio that refuses to start (permission denied / unavailable) is non-fatal — the seam
      // still has the HTTPS anchor — but `stop()` removed every listener/radio, so we must NOT
      // return the original allow decision (the UI would falsely show a dead courier as running).
      // Report a blocked decision instead so `CourierRunner` surfaces the honest typed reason
      // (and surface the underlying error in dev rather than swallowing it).
      devWarn('a courier radio refused to start', error);
      await this.stop();
      this.decision = { advertise: false, discover: false, blockedReason: 'radio_unavailable' };
    }
    return this.decision;
  }

  /** Stop every radio, remove every listener, and drop the per-endpoint mediums. */
  async stop(): Promise<void> {
    this.running = false;
    for (const handle of this.handles.splice(0)) {
      try {
        await handle.remove();
      } catch {
        /* removing a listener must never throw out of teardown */
      }
    }
    for (const { plugin } of this.channels) {
      try {
        await plugin.stop();
      } catch {
        /* stopping a radio that never started is fine */
      }
    }
    this.mediums.clear();
    this.exchanged.clear();
  }

  private async addListener(
    plugin: NearbyCourierPlugin,
    event: string,
    listener: (raw: unknown) => void,
  ): Promise<void> {
    const handle = await plugin.addListener(event, listener);
    this.handles.push(handle);
  }

  /** A `connectionResult`: when an endpoint first connects, drive ONE exchange over it. */
  private onConnectionResult(channel: CourierChannel, raw: unknown): void {
    const parsed = nativeConnectionEventSchema.safeParse(raw);
    if (!parsed.success) return; // fail-closed on a malformed native event
    const event: NativeConnectionEvent = parsed.data;
    if (!event.connected) return;
    if (this.exchanged.has(this.key(channel, event.endpointId))) return; // one per connection
    void this.driveExchange(channel, event.endpointId);
  }

  /** A `payloadReceived`: route it to the right per-(channel,endpoint) medium (fail-closed). */
  private onPayloadReceived(channel: CourierChannel, raw: unknown): void {
    const parsed = nativePayloadEventSchema.safeParse(raw);
    if (!parsed.success) return; // malformed — drop, never decode
    const event: NativePayloadEvent = parsed.data;
    // Lazily create the medium if a payload arrives before we observed the connection
    // (a radio may deliver a payload very promptly); the exchange driver reuses it.
    const plugin = this.pluginFor(channel);
    if (!plugin) return;
    const medium = this.mediumFor(channel, plugin, event.endpointId);
    medium.acceptNativeEvent(event);
  }

  /** A `disconnected`: drop the endpoint's medium so a later reconnect starts fresh. */
  private onDisconnected(channel: CourierChannel, raw: unknown): void {
    const parsed = nativeDisconnectEventSchema.safeParse(raw);
    if (!parsed.success) return;
    const event: NativeDisconnectEvent = parsed.data;
    const key = this.key(channel, event.endpointId);
    this.mediums.delete(key);
    this.exchanged.delete(key);
  }

  /** A radio reported an ASYNC start failure (e.g. GMS refused advertising after the start Task
   *  resolved).  Surface it in dev, then stop + mark the courier unavailable so the polled
   *  decision the UI reads no longer shows a dead radio as running (mirrors the sync start catch). */
  private async onStartFailed(channel: CourierChannel, raw: unknown): Promise<void> {
    devWarn(`courier radio '${channel}' reported a start failure`, raw);
    if (!this.running) return;
    // Set the blocked decision BEFORE tearing down: stop() flips isRunning() synchronously, so a
    // reader observing the stop must already see the honest radio_unavailable reason, not the
    // stale allow decision.
    this.decision = { advertise: false, discover: false, blockedReason: 'radio_unavailable' };
    await this.stop();
  }

  private key(channel: CourierChannel, endpointId: string): string {
    return `${channel} ${endpointId}`;
  }

  private pluginFor(channel: CourierChannel): NearbyCourierPlugin | undefined {
    return this.channels.find((c) => c.channel === channel)?.plugin;
  }

  private mediumFor(
    channel: CourierChannel,
    plugin: NearbyCourierPlugin,
    endpointId: string,
  ): NativeChannelMedium {
    const key = this.key(channel, endpointId);
    let medium = this.mediums.get(key);
    if (!medium) {
      medium = new NativeChannelMedium(plugin, endpointId, channel);
      this.mediums.set(key, medium);
    }
    return medium;
  }

  /**
   * Construct a per-endpoint `CourierTransport` over the channel's `NativeChannelMedium`,
   * append the always-correct HTTPS anchor LAST, and run ONE §16 PUBLIC exchange through
   * `offlineExchange`.  Applies the §22.5 who-can-exchange + storage-budget gates first.
   */
  private async driveExchange(channel: CourierChannel, endpointId: string): Promise<void> {
    const key = this.key(channel, endpointId);
    if (this.exchanged.has(key)) return;
    this.exchanged.add(key);

    if (!mayExchangeWithEndpoint(this.config.controls, endpointId)) {
      this.emit(channel, endpointId, null, null, 'not_allowed_peer');
      return;
    }

    const request = this.config.buildRequest(endpointId);
    if (!request) {
      this.emit(channel, endpointId, null, null, 'nothing_to_request');
      return;
    }

    if (!withinStorageBudget(this.config.controls, this.sharedBytes, request.byteLength)) {
      this.emit(channel, endpointId, null, null, 'over_storage_budget');
      return;
    }

    const plugin = this.pluginFor(channel);
    if (!plugin) {
      this.emit(channel, endpointId, null, null, 'exchange_failed');
      return;
    }
    const medium = this.mediumFor(channel, plugin, endpointId);
    // The courier transport over THIS endpoint (deadline-bounded so a non-responding peer
    // cannot stall sync forever), then the always-correct HTTPS anchor.
    const transports: LcapTransport[] = [
      withLegTimeout(new CourierTransport(medium as CourierMedium), COURIER_LEG_TIMEOUT_MS),
    ];
    for (const t of buildServerTransports(this.config.httpsConfig ?? {})) transports.push(t);

    let result: { transport: CourierExchangeOutcome['carriedBy']; response: Uint8Array } | null;
    try {
      // PUBLIC-ONLY: the courier seam (`carriesPrivate:false`) structurally refuses any
      // non-public pack, so the public label here is the only one a courier ever carries.
      result = await offlineExchange(transports, request, undefined, 'public');
    } catch {
      this.emit(channel, endpointId, null, null, 'exchange_failed');
      return;
    }

    // Account the bytes actually ferried over the medium against the storage budget.
    this.sharedBytes += medium.bytesSent();

    if (!result) {
      this.emit(channel, endpointId, null, null, 'exchange_failed');
      return;
    }
    this.emit(channel, endpointId, result.transport, result.response, '');
  }

  private emit(
    channel: CourierChannel,
    endpointId: string,
    carriedBy: CourierExchangeOutcome['carriedBy'],
    response: Uint8Array | null,
    skippedReason: CourierExchangeOutcome['skippedReason'],
  ): void {
    this.config.onOutcome?.({ endpointId, channel, carriedBy, response, skippedReason });
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
