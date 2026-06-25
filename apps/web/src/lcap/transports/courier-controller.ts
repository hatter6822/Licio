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
//   4. CLASSIFIES each `payloadReceived` event (a peer's exchange REQUEST vs. our RESPONSE) and
//      routes it: a response feeds the requester's medium inbox; a request goes to the responder
//      seam (or is dropped) so it is NEVER mistaken for our response — fail-closed on malformed;
//   5. enforces the §22.5 who-can-exchange + storage-budget controls per connection;
//   6. stops cleanly (removes every listener, stops every radio, drops the mediums).
//
// The bytes never gain trust from the radio: every frame the exchange receives is
// re-validated downstream against its CIDs/COSE signatures (§18.4, no transport trust).
// No radio/peer identifier ever enters an LCAP schema — the endpoint id is a live-
// connection routing handle only (the check:lcap-schema-egress doctrine).  This file
// imports `@licio/lcap` types/values only (NEVER `@licio/lcap-p2p`), so it stays off the
// code-split P2P chunk (`check:lcap-p2p-split`).

import {
  decodeWithSchema,
  exchangeRequestV2Schema,
  exchangeResponseV2Schema,
  type LcapTransport,
} from '@licio/lcap';
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

/**
 * Classify an inbound courier message: the peer's exchange REQUEST (it is asking US), our
 * exchange RESPONSE (the answer to our request), or unknown.  The strict §16 schemas are
 * MUTUALLY EXCLUSIVE (a request has `interests` and no `status`; a response the reverse), so a
 * peer's request can never be mistaken for our response — which is exactly the bug this guards:
 * with two couriers both sending requests, the first inbound bytes must NOT be reported as a
 * successful exchange.
 */
function classifyExchangeMessage(bytes: Uint8Array): 'request' | 'response' | 'unknown' {
  try {
    decodeWithSchema(exchangeResponseV2Schema, bytes);
    return 'response';
  } catch {
    /* not a response — try a request */
  }
  try {
    decodeWithSchema(exchangeRequestV2Schema, bytes);
    return 'request';
  } catch {
    /* not a request either */
  }
  return 'unknown';
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
export type CourierRequestBuilder = (
  endpointId: string,
) => Uint8Array | null | Promise<Uint8Array | null>;

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
  /**
   * The §16 RESPONDER: build a §16 exchange RESPONSE for a peer's inbound exchange REQUEST,
   * serving the peer's wants from local content (CourierRunner wires `respondToClientExchange`
   * over the `lcap_v2` store).  A fully bidirectional courier sets this so a peer that asks for
   * content it lacks is actually served; when absent, a peer's request is dropped (never mistaken
   * for our own response).  The bytes are re-verified by CID downstream — no transport trust.
   */
  readonly buildResponse?: (
    request: Uint8Array,
    endpointId: string,
  ) => Promise<Uint8Array | null> | Uint8Array | null;
  /** HTTPS anchor config (exchange URL + injectable fetch) for the fallback leg. */
  readonly httpsConfig?: HttpsTransportConfig;
  /** Notified after each per-endpoint exchange outcome (observability / UI). */
  readonly onOutcome?: (outcome: CourierExchangeOutcome) => void;
  /** Notified when the start decision changes ASYNCHRONOUSLY after {@link start} resolved — a
   *  radio whose native start Task rejects late stops the radios and flips the decision to
   *  radio_unavailable, which the caller's `start()` return value cannot reflect.  The UI uses
   *  this to drop a now-dead courier from "running" instead of showing a stale state. */
  readonly onDecisionChange?: (decision: CourierStartDecision) => void;
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
  /** Per-channel listener handles, so ONE channel can be torn down without touching the others. */
  private readonly handlesByChannel = new Map<CourierChannel, ListenerHandle[]>();
  /** Channels whose radios are currently running — a single radio's failure removes only its own
   *  channel; the courier is "running" while ANY channel is active, and only blocks when NONE are. */
  private readonly runningChannels = new Set<CourierChannel>();
  /** The LIVE §22.5 radio controls — mutable so a control change applies to a RUNNING courier
   *  (the who-can-exchange + storage-budget gates read this at exchange time, and
   *  {@link applyControls} re-evaluates the radios), not only at the next Start. */
  private controls: CourierRadioControls;
  /** The LIVE §33 operational mode — mutable so switching INTO Stealth/Emergency on a running
   *  courier stops the radios immediately (the mode is otherwise captured at construction). */
  private mode: CourierMode;
  private sharedBytes = 0;
  private started = false;
  /** True only while a launch (start OR a live restart) is still bringing radios up — an async
   *  startFailed during this window tears down only its own channel and defers the all-failed
   *  verdict to the launch's end. */
  private launching = false;
  /** A control change that arrived DURING a launch (a native start / permission prompt was still
   *  pending) — deferred and applied once the radios settle, so a restriction is never lost. */
  private pendingControls: { controls: CourierRadioControls; power?: CourierPowerState } | null =
    null;
  private decision: CourierStartDecision = {
    advertise: false,
    discover: false,
    blockedReason: 'disabled',
  };

  constructor(private readonly config: CourierControllerConfig) {
    this.controls = config.controls;
    this.mode = config.mode;
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

  /** Whether ANY selected radio is currently running. */
  isRunning(): boolean {
    return this.runningChannels.size > 0;
  }

  /** The channels whose radios are CURRENTLY running (a failed channel is dropped) — what the UI
   *  shows as "Running on", in the order they came up. */
  activeChannels(): readonly CourierChannel[] {
    return this.channels.map((c) => c.channel).filter((c) => this.runningChannels.has(c));
  }

  /**
   * Start the courier: compute the §22.5/§33.5 decision, and — only if it permits —
   * register the event listeners and start advertising/discovery on EVERY selected
   * channel.  A blocked decision (or no resolved channels) is a clean no-op (no listeners,
   * no radios).  Idempotent: a second call while running does nothing.
   */
  async start(): Promise<CourierStartDecision> {
    if (this.started) return this.decision;
    this.decision = decideCourierStart(this.controls, this.mode, this.config.power ?? {});
    if (!this.decision.advertise && !this.decision.discover) return this.decision;
    if (this.channels.length === 0) return this.decision; // nothing to drive

    this.started = true;
    await this.launch(this.decision, this.channels);
    // The courier is unavailable only if NO channel could start (the HTTPS anchor still carries) —
    // unless a control change deferred during the launch already turned it off (handled in launch).
    if (this.started && this.runningChannels.size === 0) {
      this.started = false;
      this.decision = { advertise: false, discover: false, blockedReason: 'radio_unavailable' };
    }
    return this.decision;
  }

  /** The per-radio start options (service id / endpoint name) from config. */
  private radioOptions(): { serviceId?: string; endpointName?: string } {
    return {
      ...(this.config.serviceId !== undefined ? { serviceId: this.config.serviceId } : {}),
      ...(this.config.endpointName !== undefined ? { endpointName: this.config.endpointName } : {}),
    };
  }

  /**
   * Register listeners + start advertising/discovery (per `decision`) on each given channel,
   * INDEPENDENTLY — one radio refusing (sync throw OR an async startFailed mid-await) tears down
   * ONLY that channel.  Holds `launching` for its duration (a late startFailed defers the
   * all-failed verdict), and applies a control change that arrived during the launch once it
   * settles.  Shared by {@link start} and the live restart path.
   */
  private async launch(
    decision: CourierStartDecision,
    channels: readonly CourierChannelPlugin[],
  ): Promise<void> {
    // Set synchronously (before the first await) so a control change that races the launch always
    // observes `launching` and DEFERS, never interleaving with listener registration / radio start.
    this.launching = true;
    // Register listeners on EVERY channel BEFORE starting any radio so no early event is missed.
    for (const { channel, plugin } of channels) {
      await this.registerListeners(channel, plugin);
    }
    const options = this.radioOptions();
    for (const { channel, plugin } of channels) {
      try {
        if (decision.advertise) await plugin.startAdvertising(options);
        // If an async startFailed tore THIS channel down during the advertise await (stopChannel
        // deletes its handles synchronously), do NOT also start discovery on it — that would leave
        // a native radio running with no listeners and no running mark.
        if (!this.handlesByChannel.has(channel)) continue;
        if (decision.discover) await plugin.startDiscovery(options);
        // Only mark active if an async startFailed did NOT already tear this channel down mid-await.
        if (this.handlesByChannel.has(channel)) this.runningChannels.add(channel);
      } catch (error) {
        devWarn(`a courier radio '${channel}' refused to start`, error);
        await this.stopChannel(channel);
      }
    }
    this.launching = false;
    // A control change that arrived DURING the launch (the user disabled a radio / changed policy
    // while a native start or permission prompt was pending) was deferred — apply it now so the
    // restriction takes effect even though it raced the radios coming up.
    if (this.pendingControls) {
      const pending = this.pendingControls;
      this.pendingControls = null;
      await this.reconcileRadios(pending.controls, pending.power);
    }
  }

  /** Stop EVERY channel's radio, remove its listeners, and drop the per-endpoint mediums. */
  async stop(): Promise<void> {
    this.started = false;
    for (const { channel } of this.channels) {
      await this.stopChannel(channel);
    }
    this.mediums.clear();
    this.exchanged.clear();
  }

  /**
   * Apply a §22.5 control change to the ALREADY-RUNNING courier immediately (a privacy control
   * must take effect now, not at the next Stop/Start).  The who-can-exchange + storage-budget
   * gates read the new controls on the next exchange automatically; the RADIOS are reconciled by
   * {@link reconcileRadios} (stop everything when disallowed; RESTART the still-enabled channels
   * when a direction was toggled, since a native radio can only stop wholesale; else drop a
   * deselected channel).  `power` should be a FRESH reading so the §22.5 battery floor is enforced
   * against the current level, not the snapshot captured at Start.  A no-op before {@link start}.
   * Re-enabling a channel takes effect on the next Start (a deselected radio's plugin is not
   * retained) — only RESTRICTIONS are enforced live, never loosened silently.
   */
  async applyControls(
    next: CourierRadioControls,
    opts: { power?: CourierPowerState; mode?: CourierMode } = {},
  ): Promise<void> {
    this.controls = next;
    if (opts.mode !== undefined) this.mode = opts.mode; // a mode switch must reconcile too (§33.5)
    if (!this.started) return; // not running — start() will read the latest controls
    if (this.launching) {
      // A start/restart is mid-flight (a native start or permission prompt is pending); remember
      // this change and apply it once the radios settle, so the restriction is not lost.
      this.pendingControls = {
        controls: next,
        ...(opts.power !== undefined ? { power: opts.power } : {}),
      };
      return;
    }
    await this.reconcileRadios(next, opts.power);
  }

  /** Re-evaluate the radios for a control change on a RUNNING courier — using a FRESH `power`
   *  reading (§22.5 battery floor enforced against the current level).  See {@link applyControls}. */
  private async reconcileRadios(
    next: CourierRadioControls,
    power: CourierPowerState | undefined,
  ): Promise<void> {
    if (!this.started) return;
    const decision = decideCourierStart(next, this.mode, power ?? this.config.power ?? {});
    if (!decision.advertise && !decision.discover) {
      // The new controls/mode/power turn the courier off entirely — stop every radio now.
      await this.stop();
      this.decision = decision;
      this.config.onDecisionChange?.(decision);
      return;
    }
    const enabled = new Set(next.enabledChannels ?? ['nearby']);
    const directionChanged =
      decision.advertise !== this.decision.advertise ||
      decision.discover !== this.decision.discover;
    if (directionChanged) {
      // A direction (advertise/discover) was toggled.  The native plugins expose stop() for the
      // WHOLE radio only, so to actually silence the disabled direction we STOP every channel and
      // RESTART the still-enabled ones with the new advertise/discover set.
      for (const { channel } of this.channels) await this.stopChannel(channel);
      this.decision = decision;
      await this.launch(
        decision,
        this.channels.filter((c) => enabled.has(c.channel)),
      );
    } else {
      // Same directions — just drop any channel the user deselected, so it goes silent at once.
      for (const channel of [...this.runningChannels]) {
        if (!enabled.has(channel)) await this.stopChannel(channel);
      }
    }
    if (this.started && this.runningChannels.size === 0) {
      // Every selected radio is now off — surface it honestly.
      this.started = false;
      this.decision = { advertise: false, discover: false, blockedReason: 'radio_unavailable' };
      this.config.onDecisionChange?.(this.decision);
    }
  }

  /** Tear down ONE channel — remove its listeners, stop its plugin, drop its mediums + exchange
   *  marks, mark it inactive — so a single radio's failure never affects the other channels. */
  private async stopChannel(channel: CourierChannel): Promise<void> {
    // Drop the running mark AND the handle list SYNCHRONOUSLY (before any await), so the start
    // loop's `handlesByChannel.has(channel)` guard reliably observes an in-progress teardown and
    // never counts a torn-down channel as running.
    this.runningChannels.delete(channel);
    const handles = this.handlesByChannel.get(channel) ?? [];
    this.handlesByChannel.delete(channel);
    for (const handle of handles) {
      try {
        await handle.remove();
      } catch {
        /* removing a listener must never throw out of teardown */
      }
    }
    const plugin = this.pluginFor(channel);
    if (plugin) {
      try {
        await plugin.stop();
      } catch {
        /* stopping a radio that never started is fine */
      }
    }
    const prefix = this.channelKeyPrefix(channel);
    for (const k of [...this.mediums.keys()]) if (k.startsWith(prefix)) this.mediums.delete(k);
    for (const k of [...this.exchanged]) if (k.startsWith(prefix)) this.exchanged.delete(k);
  }

  /** Register a channel's four event listeners under its own handle list (so it can be torn down
   *  independently).  Done BEFORE the radio starts, so no early event is missed. */
  private async registerListeners(
    channel: CourierChannel,
    plugin: NearbyCourierPlugin,
  ): Promise<void> {
    const handles: ListenerHandle[] = [];
    const add = async (event: string, listener: (raw: unknown) => void): Promise<void> => {
      handles.push(await plugin.addListener(event, listener));
    };
    await add('connectionResult', (raw) => this.onConnectionResult(channel, raw));
    await add('payloadReceived', (raw) => this.onPayloadReceived(channel, raw));
    await add('disconnected', (raw) => this.onDisconnected(channel, raw));
    // A radio's start is ASYNC: GMS/Wi-Fi Direct may reject it AFTER start* resolves — consume the
    // native startFailed so a late refusal tears down THIS channel (not believed-running).
    await add('startFailed', (raw) => void this.onStartFailed(channel, raw));
    this.handlesByChannel.set(channel, handles);
  }

  /** Whether a channel is still ACTIVE — its listeners are registered and not torn down.  A native
   *  event QUEUED before stop()/stopChannel() removed the listeners can still invoke a handler, so
   *  every inbound handler gates on this to avoid driving/answering an exchange after teardown.
   *  (`handlesByChannel` is deleted SYNCHRONOUSLY by stopChannel, before any await.) */
  private isChannelActive(channel: CourierChannel): boolean {
    return this.handlesByChannel.has(channel);
  }

  /** A `connectionResult`: when an endpoint first connects, drive ONE exchange over it. */
  private onConnectionResult(channel: CourierChannel, raw: unknown): void {
    if (!this.isChannelActive(channel)) return; // a late event after stop/deselect — don't exchange
    const parsed = nativeConnectionEventSchema.safeParse(raw);
    if (!parsed.success) return; // fail-closed on a malformed native event
    const event: NativeConnectionEvent = parsed.data;
    if (!event.connected) return;
    if (this.exchanged.has(this.key(channel, event.endpointId))) return; // one per connection
    void this.driveExchange(channel, event.endpointId);
  }

  /** A `payloadReceived`: CLASSIFY the inbound message and route it (fail-closed).  A peer's
   *  exchange REQUEST goes to the responder (or is dropped) — it is NEVER delivered to our inbox,
   *  so it can't be mistaken for our exchange response; only a valid RESPONSE feeds the inbox the
   *  requester's `CourierTransport.receive()` reads. */
  private onPayloadReceived(channel: CourierChannel, raw: unknown): void {
    if (!this.isChannelActive(channel)) return; // a late event after stop/deselect — don't respond
    const parsed = nativePayloadEventSchema.safeParse(raw);
    if (!parsed.success) return; // malformed — drop, never decode
    const event: NativePayloadEvent = parsed.data;
    // Lazily create the medium if a payload arrives before we observed the connection
    // (a radio may deliver a payload very promptly); the exchange driver reuses it.
    const plugin = this.pluginFor(channel);
    if (!plugin) return;
    const medium = this.mediumFor(channel, plugin, event.endpointId);
    const bytes = medium.nativeEventToBytes(event);
    if (!bytes) return; // malformed base64 / wrong endpoint
    switch (classifyExchangeMessage(bytes)) {
      case 'response':
        // The answer to OUR request — feed the requester's receive().
        medium.deliverInbound(bytes);
        return;
      case 'request':
        // The PEER is asking US.  Respond if a responder is configured; otherwise drop it (do NOT
        // inbox it — that is the bug this fixes: a request must never be reported as our response).
        void this.respondToRequest(channel, event.endpointId, bytes, medium);
        return;
      default:
        // Unparseable as either — drop (no transport trust; fail-closed).
        return;
    }
  }

  /** Serve a peer's inbound exchange REQUEST: build a §16 response (when a responder is
   *  configured) and ferry it back over the medium.  A no-op when no responder is wired. */
  private async respondToRequest(
    channel: CourierChannel,
    endpointId: string,
    request: Uint8Array,
    medium: NativeChannelMedium,
  ): Promise<void> {
    if (!this.config.buildResponse) return; // request-only courier — drop the peer's request
    if (!mayExchangeWithEndpoint(this.controls, endpointId)) return; // the same who-can-exchange gate
    try {
      const response = await this.config.buildResponse(request, endpointId);
      if (!response) return;
      if (!withinStorageBudget(this.controls, this.sharedBytes, response.byteLength)) return;
      medium.enqueueOutbound(response);
      this.sharedBytes += response.byteLength; // count the bytes we ferried back
    } catch (error) {
      devWarn(`failed to build a courier response for '${channel}'`, error);
    }
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
   *  resolved).  Tear down ONLY that channel — a different working radio keeps the courier running —
   *  and report radio_unavailable to the UI only when the LAST working channel is gone. */
  private async onStartFailed(channel: CourierChannel, raw: unknown): Promise<void> {
    devWarn(`courier radio '${channel}' reported a start failure`, raw);
    if (!this.handlesByChannel.has(channel)) return; // already torn down
    await this.stopChannel(channel);
    // Defer the all-failed verdict while start() is still launching (its end-of-loop check owns it);
    // once running, only the LAST channel going down makes the courier unavailable.
    if (!this.launching && this.started && this.runningChannels.size === 0) {
      this.started = false;
      this.decision = { advertise: false, discover: false, blockedReason: 'radio_unavailable' };
      this.config.onDecisionChange?.(this.decision);
    }
  }

  private key(channel: CourierChannel, endpointId: string): string {
    return `${channel}\0${endpointId}`;
  }

  /** The `channel\0` key PREFIX — the SAME delimiter `key()` uses, so a channel teardown matches
   *  its own mediums/exchanged marks.  (A space prefix never matched the NUL-delimited keys, so a
   *  reconnecting endpoint after a restart/deselect stayed in `exchanged` and was skipped.) */
  private channelKeyPrefix(channel: CourierChannel): string {
    return `${channel}\0`;
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

    if (!mayExchangeWithEndpoint(this.controls, endpointId)) {
      this.emit(channel, endpointId, null, null, 'not_allowed_peer');
      return;
    }

    const request = await this.config.buildRequest(endpointId);
    if (!request) {
      this.emit(channel, endpointId, null, null, 'nothing_to_request');
      return;
    }

    if (!withinStorageBudget(this.controls, this.sharedBytes, request.byteLength)) {
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

    let result: { transport: CourierExchangeOutcome['carriedBy']; response: Uint8Array } | null =
      null;
    try {
      // PUBLIC-ONLY: the courier seam (`carriesPrivate:false`) structurally refuses any
      // non-public pack, so the public label here is the only one a courier ever carries.
      result = await offlineExchange(transports, request, undefined, 'public');
    } catch {
      // Swallowed: the bytes already ferried are still charged in the finally below, and the
      // outcome is reported as exchange_failed after.
    } finally {
      // Account the bytes ACTUALLY ferried to the peer against the storage budget — even when the
      // exchange threw or returned nothing.  A peer that received the request but never answered
      // (while the HTTPS anchor was unreachable) STILL consumed those bytes; charging them only on
      // success would let repeated FAILED courier attempts bypass the budget on bytes already sent.
      this.sharedBytes += medium.bytesSent();
    }

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
