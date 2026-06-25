// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4c/e — the courier ORCHESTRATION controller.  Proves the previously caller-less
// native Nearby plugin is finally DRIVEN end-to-end: a fake plugin connects an endpoint,
// the controller constructs a `NearbyEndpointMedium`, and runs ONE §16 exchange over it
// (a loopback fake delivers the response as a `payloadReceived`); the §22.5/§33.5 controls
// gate WHETHER the radios run, the who-can-exchange + storage-budget controls gate WHICH
// exchanges are driven, and a malformed native event is dropped fail-closed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CourierChannelPlugin, CourierController } from './courier-controller.js';
import type { CourierRadioControls } from './courier-native.js';

const ON: CourierRadioControls = { advertisingEnabled: true, discoveryEnabled: true };

interface FakeListener {
  event: string;
  fn: (raw: unknown) => void;
}

/**
 * A fake native plugin that records radio calls and LOOPS a sent payload straight back as
 * an inbound `payloadReceived` (a same-process echo), so the courier `receive` resolves and
 * the exchange completes over the medium.
 */
function fakePlugin() {
  const listeners: FakeListener[] = [];
  const calls: string[] = [];
  const sent: Array<{ endpointId: string; message: string }> = [];
  const emit = (event: string, raw: unknown): void => {
    for (const l of listeners) if (l.event === event) l.fn(raw);
  };
  const plugin = {
    startAdvertising: vi.fn(async () => {
      calls.push('advertise');
    }),
    startDiscovery: vi.fn(async () => {
      calls.push('discover');
    }),
    stop: vi.fn(async () => {
      calls.push('stop');
    }),
    send: vi.fn(async (o: { endpointId: string; message: string }) => {
      sent.push(o);
      // Echo the bytes back as an inbound payload for this endpoint (loopback peer).
      emit('payloadReceived', { endpointId: o.endpointId, message: o.message });
    }),
    addListener: (event: string, fn: (raw: unknown) => void) => {
      const handle = { remove: vi.fn() };
      listeners.push({ event, fn });
      return handle;
    },
  };
  return { plugin, listeners, calls, sent, emit };
}

// An HTTPS fetch that always rejects, so the anchor leg never hits a real network in tests.
const REJECTING_FETCH: typeof fetch = () => Promise.reject(new Error('no network in test'));

describe('CourierController (WS-R.15.4c orchestration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('is a clean no-op when the controls disable the radios (off by default)', async () => {
    const f = fakePlugin();
    const controller = new CourierController({
      plugin: f.plugin,
      controls: { advertisingEnabled: false, discoveryEnabled: false },
      mode: 'standard',
      buildRequest: () => new Uint8Array([1]),
    });
    const decision = await controller.start();
    expect(decision.blockedReason).toBe('disabled');
    expect(controller.isRunning()).toBe(false);
    expect(f.calls).toEqual([]); // no radios, no listeners
  });

  it('FORCES off in Stealth/Emergency regardless of the controls (§33.5)', async () => {
    for (const mode of ['stealth', 'emergency'] as const) {
      const f = fakePlugin();
      const controller = new CourierController({
        plugin: f.plugin,
        controls: ON,
        mode,
        buildRequest: () => new Uint8Array([1]),
      });
      const decision = await controller.start();
      expect(decision.blockedReason).toBe('forced_off_in_mode');
      expect(f.calls).toEqual([]);
    }
  });

  it('reports radio_unavailable (NOT running) when a radio fails to start', async () => {
    const f = fakePlugin();
    // The radio rejects startAdvertising (permission denied / unavailable).
    f.plugin.startAdvertising = vi.fn(async () => {
      throw new Error('permission denied');
    });
    const controller = new CourierController({
      plugin: f.plugin,
      controls: ON,
      mode: 'courier',
      buildRequest: () => new Uint8Array([1]),
    });
    const decision = await controller.start();
    // NOT a false "running": the decision is blocked with the honest typed reason, and the
    // controller tore everything down.
    expect(decision).toMatchObject({
      advertise: false,
      discover: false,
      blockedReason: 'radio_unavailable',
    });
    expect(controller.isRunning()).toBe(false);
    expect(f.calls).toContain('stop'); // radios/listeners torn down
  });

  it('consumes a LATE async startFailed event → stops + reports radio_unavailable', async () => {
    // The radios start cleanly (the sync start resolves), so the controller is running...
    const f = fakePlugin();
    const decisionChanges: Array<{ blockedReason?: string }> = [];
    const controller = new CourierController({
      plugin: f.plugin,
      controls: ON,
      mode: 'courier',
      buildRequest: () => new Uint8Array([1]),
      onDecisionChange: (d) => decisionChanges.push(d),
    });
    await controller.start();
    expect(controller.isRunning()).toBe(true);

    // ...but GMS/Wi-Fi Direct rejects the start Task ASYNCHRONOUSLY afterwards (a `startFailed`
    // event the sync try/catch can't see).  The controller must consume it, not stay "running".
    f.emit('startFailed', { operation: 'advertise', error: 'nearby_disabled' });
    await vi.waitFor(() => expect(f.calls).toContain('stop')); // teardown ran to completion
    expect(controller.isRunning()).toBe(false);
    expect(controller.startDecision()).toMatchObject({
      advertise: false,
      discover: false,
      blockedReason: 'radio_unavailable',
    });
    // The UI is notified of the async decision change (start() already returned, so a private
    // mutation alone would leave the runner showing a dead courier as running).
    expect(decisionChanges).toContainEqual(
      expect.objectContaining({ blockedReason: 'radio_unavailable' }),
    );
  });

  it('does NOT start discovery on a channel whose advertise already tore it down (race)', async () => {
    // startAdvertising fires an async `startFailed` that tears THIS channel down mid-await (its
    // listeners are removed synchronously).  start() must re-check the channel is still registered
    // BEFORE starting discovery — else it would (re)start a native radio with no listeners and no
    // running mark, so the UI shows blocked/unavailable while the radio is left live.
    const f = fakePlugin();
    f.plugin.startAdvertising = vi.fn(async () => {
      f.calls.push('advertise');
      f.emit('startFailed', { operation: 'advertise', error: 'nearby_disabled' });
    });
    const controller = new CourierController({
      plugin: f.plugin,
      controls: ON,
      mode: 'courier',
      buildRequest: () => new Uint8Array([1]),
    });
    const decision = await controller.start();
    // Discovery was NOT started on the torn-down channel.
    expect(f.calls).not.toContain('discover');
    expect(f.plugin.startDiscovery).not.toHaveBeenCalled();
    // With its only channel down, the courier is honestly unavailable (not falsely running).
    expect(controller.isRunning()).toBe(false);
    expect(decision.blockedReason).toBe('radio_unavailable');
    await vi.waitFor(() => expect(f.calls).toContain('stop')); // the channel was torn down
  });

  it('isolates a failing channel — one radio refusing does NOT stop the others', async () => {
    // Two channels.  The FIRST channel's startAdvertising fires a `startFailed` (an async refusal).
    // With per-channel teardown, ONLY that channel is torn down — the SECOND keeps running, and the
    // courier is NOT reported unavailable (the working radio + the HTTPS anchor still carry).
    const a = fakePlugin();
    const b = fakePlugin();
    a.plugin.startAdvertising = vi.fn(async () => {
      a.emit('startFailed', { operation: 'advertise', error: 'nearby_disabled' });
    });
    const controller = new CourierController({
      channels: [
        { channel: 'nearby', plugin: a.plugin },
        { channel: 'bluetooth', plugin: b.plugin },
      ],
      controls: ON,
      mode: 'courier',
      buildRequest: () => new Uint8Array([1]),
    });

    const decision = await controller.start();
    expect(controller.isRunning()).toBe(true); // still running on the working channel
    expect(controller.activeChannels()).toEqual(['bluetooth']); // only the failing one was dropped
    expect(b.calls).toContain('advertise');
    expect(decision.blockedReason).not.toBe('radio_unavailable');
    expect(a.calls).toContain('stop'); // the failing channel WAS torn down
  });

  it('reports radio_unavailable only when EVERY channel fails to start', async () => {
    const a = fakePlugin();
    const b = fakePlugin();
    const changes: Array<{ blockedReason?: string }> = [];
    a.plugin.startAdvertising = vi.fn(async () => {
      throw new Error('nearby_unavailable');
    });
    b.plugin.startAdvertising = vi.fn(async () => {
      throw new Error('bluetooth_unavailable');
    });
    const controller = new CourierController({
      channels: [
        { channel: 'nearby', plugin: a.plugin },
        { channel: 'bluetooth', plugin: b.plugin },
      ],
      controls: ON,
      mode: 'courier',
      buildRequest: () => new Uint8Array([1]),
      onDecisionChange: (d) => changes.push(d),
    });

    const decision = await controller.start();
    expect(decision).toMatchObject({ blockedReason: 'radio_unavailable' });
    expect(controller.isRunning()).toBe(false);
    expect(controller.activeChannels()).toEqual([]);
  });

  it('starts the radios and drives ONE §16 exchange over a connected endpoint', async () => {
    const f = fakePlugin();
    const outcomes: Array<{ endpointId: string; channel: string; carriedBy: string | null }> = [];
    const request = new Uint8Array([9, 8, 7]);
    const controller = new CourierController({
      plugin: f.plugin,
      controls: ON,
      mode: 'courier',
      buildRequest: () => request,
      httpsConfig: { fetchFn: REJECTING_FETCH },
      onOutcome: (o) =>
        outcomes.push({ endpointId: o.endpointId, channel: o.channel, carriedBy: o.carriedBy }),
    });

    await controller.start();
    expect(f.calls).toContain('advertise');
    expect(f.calls).toContain('discover');
    // A bare `plugin` drives the `nearby` channel only (back-compat).
    expect(controller.activeChannels()).toEqual(['nearby']);

    // A peer connects; the controller drives the exchange. The loopback echoes the request
    // bytes back as the response, so the courier leg resolves.
    f.emit('connectionResult', { endpointId: 'ep-1', connected: true });
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));

    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.endpointId).toBe('ep-1');
    expect(outcomes[0]).toEqual({ endpointId: 'ep-1', channel: 'nearby', carriedBy: 'courier' });
  });

  it('drives EACH selected native channel identically (WS-R.15.4d Wi-Fi Direct / Bluetooth)', async () => {
    // Two distinct channels, each its own plugin; both advertise+discover and each drives
    // ONE exchange over its own endpoint, tagged with the right channel.
    const wifi = fakePlugin();
    const bt = fakePlugin();
    const channels: CourierChannelPlugin[] = [
      { channel: 'wifiDirect', plugin: wifi.plugin },
      { channel: 'bluetooth', plugin: bt.plugin },
    ];
    const outcomes: Array<{ channel: string; carriedBy: string | null }> = [];
    const controller = new CourierController({
      channels,
      controls: ON,
      mode: 'courier',
      buildRequest: () => new Uint8Array([5, 6]),
      httpsConfig: { fetchFn: REJECTING_FETCH },
      onOutcome: (o) => outcomes.push({ channel: o.channel, carriedBy: o.carriedBy }),
    });

    await controller.start();
    expect(controller.activeChannels()).toEqual(['wifiDirect', 'bluetooth']);
    // Every selected radio is started.
    expect(wifi.calls).toEqual(expect.arrayContaining(['advertise', 'discover']));
    expect(bt.calls).toEqual(expect.arrayContaining(['advertise', 'discover']));

    // A peer connects on EACH channel (the same endpoint id namespace per channel is fine —
    // the controller keys mediums by (channel, endpoint)).
    wifi.emit('connectionResult', { endpointId: 'ep', connected: true });
    bt.emit('connectionResult', { endpointId: 'ep', connected: true });
    await vi.waitFor(() => expect(outcomes).toHaveLength(2));

    expect(wifi.sent).toHaveLength(1);
    expect(bt.sent).toHaveLength(1);
    expect(outcomes.map((o) => o.channel).sort()).toEqual(['bluetooth', 'wifiDirect']);
    for (const o of outcomes) expect(o.carriedBy).toBe('courier');

    await controller.stop();
    expect(wifi.plugin.stop).toHaveBeenCalled();
    expect(bt.plugin.stop).toHaveBeenCalled();
  });

  it('drives at most ONE exchange per connection', async () => {
    const f = fakePlugin();
    const outcomes: unknown[] = [];
    const controller = new CourierController({
      plugin: f.plugin,
      controls: ON,
      mode: 'courier',
      buildRequest: () => new Uint8Array([1]),
      httpsConfig: { fetchFn: REJECTING_FETCH },
      onOutcome: (o) => outcomes.push(o),
    });
    await controller.start();
    f.emit('connectionResult', { endpointId: 'ep-1', connected: true });
    f.emit('connectionResult', { endpointId: 'ep-1', connected: true }); // duplicate
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes).toHaveLength(1);
  });

  it('refuses an exchange with a peer the who-can-exchange control disallows', async () => {
    const f = fakePlugin();
    const outcomes: Array<{ skippedReason: string }> = [];
    const controller = new CourierController({
      plugin: f.plugin,
      controls: { ...ON, exchangePeers: 'known_only', allowedEndpointIds: ['ep-allowed'] },
      mode: 'courier',
      buildRequest: () => new Uint8Array([1]),
      httpsConfig: { fetchFn: REJECTING_FETCH },
      onOutcome: (o) => outcomes.push({ skippedReason: o.skippedReason }),
    });
    await controller.start();
    f.emit('connectionResult', { endpointId: 'ep-blocked', connected: true });
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]?.skippedReason).toBe('not_allowed_peer');
    expect(f.sent).toHaveLength(0); // nothing was ferried
  });

  it('refuses an exchange that would exceed the storage budget', async () => {
    const f = fakePlugin();
    const outcomes: Array<{ skippedReason: string }> = [];
    const controller = new CourierController({
      plugin: f.plugin,
      controls: { ...ON, storageBudgetBytes: 2 },
      mode: 'courier',
      buildRequest: () => new Uint8Array([1, 2, 3, 4, 5]), // 5 bytes > 2-byte budget
      httpsConfig: { fetchFn: REJECTING_FETCH },
      onOutcome: (o) => outcomes.push({ skippedReason: o.skippedReason }),
    });
    await controller.start();
    f.emit('connectionResult', { endpointId: 'ep-1', connected: true });
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]?.skippedReason).toBe('over_storage_budget');
    expect(f.sent).toHaveLength(0);
  });

  it('skips a connection with nothing to request', async () => {
    const f = fakePlugin();
    const outcomes: Array<{ skippedReason: string }> = [];
    const controller = new CourierController({
      plugin: f.plugin,
      controls: ON,
      mode: 'courier',
      buildRequest: () => null, // nothing to reconcile
      httpsConfig: { fetchFn: REJECTING_FETCH },
      onOutcome: (o) => outcomes.push({ skippedReason: o.skippedReason }),
    });
    await controller.start();
    f.emit('connectionResult', { endpointId: 'ep-1', connected: true });
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]?.skippedReason).toBe('nothing_to_request');
  });

  it('routes a payloadReceived event to the right per-endpoint medium (fail-closed)', async () => {
    const f = fakePlugin();
    const controller = new CourierController({
      plugin: f.plugin,
      controls: ON,
      mode: 'courier',
      buildRequest: () => new Uint8Array([1]),
      httpsConfig: { fetchFn: REJECTING_FETCH },
    });
    await controller.start();
    // A malformed native event must not throw out of the listener.
    expect(() => f.emit('payloadReceived', { endpointId: 'ep-1' })).not.toThrow();
    expect(() => f.emit('payloadReceived', 'garbage')).not.toThrow();
    expect(() => f.emit('connectionResult', { bad: true })).not.toThrow();
  });

  it('stops cleanly — removes listeners and stops the radios', async () => {
    const f = fakePlugin();
    const controller = new CourierController({
      plugin: f.plugin,
      controls: ON,
      mode: 'courier',
      buildRequest: () => new Uint8Array([1]),
      httpsConfig: { fetchFn: REJECTING_FETCH },
    });
    await controller.start();
    expect(controller.isRunning()).toBe(true);
    await controller.stop();
    expect(controller.isRunning()).toBe(false);
    expect(f.plugin.stop).toHaveBeenCalled();
  });

  it('refuses to start below the battery floor when unplugged (§22.5 battery budget)', async () => {
    const f = fakePlugin();
    const controller = new CourierController({
      plugin: f.plugin,
      controls: { ...ON, batteryFloor: 0.5 },
      mode: 'courier',
      power: { level: 0.2, charging: false },
      buildRequest: () => new Uint8Array([1]),
    });
    const decision = await controller.start();
    expect(decision.blockedReason).toBe('below_battery_floor');
    expect(controller.isRunning()).toBe(false);
    expect(f.calls).toEqual([]);
  });
});
