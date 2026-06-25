// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4c/e — the courier ORCHESTRATION controller.  Proves the previously caller-less
// native Nearby plugin is finally DRIVEN end-to-end: a fake plugin connects an endpoint,
// the controller constructs a `NearbyEndpointMedium`, and runs ONE §16 exchange over it
// (a loopback fake delivers the response as a `payloadReceived`); the §22.5/§33.5 controls
// gate WHETHER the radios run, the who-can-exchange + storage-budget controls gate WHICH
// exchanges are driven, and a malformed native event is dropped fail-closed.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CourierChannelPlugin, CourierController } from './courier-controller.js';
import type { CourierRadioControls } from './courier-native.js';

const ON: CourierRadioControls = { advertisingEnabled: true, discoveryEnabled: true };

// Real §16 exchange messages (built once via the lcap codec), so the fake peer answers with a
// VALID exchange RESPONSE (not an echo of the request) — the controller now classifies inbound
// messages and only a real response counts as a courier exchange.
let REQUEST_BYTES: Uint8Array;
let RESPONSE_BYTES: Uint8Array;
let RESPONSE_B64: string;
let REQUEST_B64: string;

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

beforeAll(async () => {
  const lcap = await import('@licio/lcap');
  const sessionNonce = new Uint8Array(16);
  const pulse = lcap.buildPulse({
    nodeId: 'lcap-courier',
    sessionNonce,
    transportProfile: 'courier',
    privacyMode: 'public',
    budgets: { ...lcap.DEFAULT_BUDGET, minimal_mode: true },
    supportedSuites: ['ES256'],
    supportedCompression: ['none', 'gzip', 'deflate'],
    supportedPackVersions: [2],
    checkpointFrontier: [],
    revocationFrontier: [{ scope: 'global', revocation_epoch: 0 }],
  });
  REQUEST_BYTES = lcap.encodeWithSchema(
    lcap.exchangeRequestV2Schema,
    lcap.buildExchangeRequest({ pulse, interests: [] }),
  );
  RESPONSE_BYTES = lcap.encodeWithSchema(
    lcap.exchangeResponseV2Schema,
    lcap.buildExchangeResponse({ pulse, status: 'ok' }),
  );
  RESPONSE_B64 = toB64(RESPONSE_BYTES);
  REQUEST_B64 = toB64(REQUEST_BYTES);
});

interface FakeListener {
  event: string;
  fn: (raw: unknown) => void;
}

/**
 * A fake native plugin that records radio calls and, on send, answers with a VALID §16 exchange
 * RESPONSE as an inbound `payloadReceived` (a loopback peer), so the courier `receive` resolves
 * with a real response and the exchange completes over the medium.
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
      // Answer with a real §16 RESPONSE (not an echo of the request — that would now be classified
      // as a peer request and dropped), so the requester's receive() resolves successfully.
      emit('payloadReceived', { endpointId: o.endpointId, message: RESPONSE_B64 });
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

  it('applyControls stops a running courier immediately when the new controls disable it', async () => {
    // A privacy control change must take effect NOW on the running courier, not only at the next
    // Stop — turning both radios off stops the native radios and flips the decision honestly.
    const f = fakePlugin();
    const changes: Array<{ blockedReason?: string }> = [];
    const controller = new CourierController({
      plugin: f.plugin,
      controls: ON,
      mode: 'courier',
      buildRequest: () => new Uint8Array([1]),
      onDecisionChange: (d) => changes.push(d),
    });
    await controller.start();
    expect(controller.isRunning()).toBe(true);

    await controller.applyControls({ advertisingEnabled: false, discoveryEnabled: false });
    expect(controller.isRunning()).toBe(false);
    expect(f.plugin.stop).toHaveBeenCalled(); // the radio was stopped live
    expect(changes.some((d) => d.blockedReason === 'disabled')).toBe(true);
  });

  it('applyControls tightens the who-can-exchange policy live (a now-disallowed peer is refused)', async () => {
    // The exchange gates must read the LIVE controls — after restricting to known peers, a peer
    // that was fine a moment ago is refused without ever being ferried to.
    const f = fakePlugin();
    const outcomes: Array<{ skippedReason: string }> = [];
    const controller = new CourierController({
      plugin: f.plugin,
      controls: ON,
      mode: 'courier',
      buildRequest: () => new Uint8Array([1]),
      httpsConfig: { fetchFn: REJECTING_FETCH },
      onOutcome: (o) => outcomes.push({ skippedReason: o.skippedReason }),
    });
    await controller.start();
    await controller.applyControls({
      ...ON,
      exchangePeers: 'known_only',
      allowedEndpointIds: ['ep-allowed'],
    });
    expect(controller.isRunning()).toBe(true); // radios stay up; only the policy tightened
    f.emit('connectionResult', { endpointId: 'ep-blocked', connected: true });
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]?.skippedReason).toBe('not_allowed_peer');
    expect(f.sent).toHaveLength(0); // nothing was ferried under the new policy
  });

  it('applyControls stops a DESELECTED channel live and keeps the others running', async () => {
    const a = fakePlugin();
    const b = fakePlugin();
    const controller = new CourierController({
      channels: [
        { channel: 'nearby', plugin: a.plugin },
        { channel: 'bluetooth', plugin: b.plugin },
      ],
      controls: { ...ON, enabledChannels: ['nearby', 'bluetooth'] },
      mode: 'courier',
      buildRequest: () => new Uint8Array([1]),
    });
    await controller.start();
    expect(controller.activeChannels()).toEqual(['nearby', 'bluetooth']);

    await controller.applyControls({ ...ON, enabledChannels: ['nearby'] });
    expect(controller.activeChannels()).toEqual(['nearby']); // bluetooth dropped live
    expect(b.plugin.stop).toHaveBeenCalled();
    expect(a.plugin.stop).not.toHaveBeenCalled();
    expect(controller.isRunning()).toBe(true);
  });

  it('applyControls restarts the radio to silence a toggled-off direction (native stop is wholesale)', async () => {
    // The native plugins expose stop() for the WHOLE radio only, so turning discovery off while
    // advertising stays on must STOP + RESTART the radio with advertise-only — otherwise the scan
    // keeps running until a full Stop.
    const f = fakePlugin();
    const controller = new CourierController({
      plugin: f.plugin,
      controls: ON,
      mode: 'courier',
      buildRequest: () => new Uint8Array([1]),
    });
    await controller.start();
    expect(f.plugin.startAdvertising).toHaveBeenCalledTimes(1);
    expect(f.plugin.startDiscovery).toHaveBeenCalledTimes(1);

    await controller.applyControls({ advertisingEnabled: true, discoveryEnabled: false });
    expect(f.plugin.stop).toHaveBeenCalled(); // stopped to actually silence discovery
    expect(f.plugin.startAdvertising).toHaveBeenCalledTimes(2); // re-advertised
    expect(f.plugin.startDiscovery).toHaveBeenCalledTimes(1); // NOT scanned again
    expect(controller.isRunning()).toBe(true);
  });

  it('applyControls enforces the battery floor against the FRESH power reading', async () => {
    // A stale start-snapshot would still permit the radios; a fresh reading below the floor must
    // stop them (the §22.5 battery budget enforced against the current level).
    const f = fakePlugin();
    const changes: Array<{ blockedReason?: string }> = [];
    const controller = new CourierController({
      plugin: f.plugin,
      controls: { ...ON, batteryFloor: 0.5 },
      mode: 'courier',
      power: { level: 0.9, charging: false }, // healthy at Start
      buildRequest: () => new Uint8Array([1]),
      onDecisionChange: (d) => changes.push(d),
    });
    await controller.start();
    expect(controller.isRunning()).toBe(true);

    await controller.applyControls(
      { ...ON, batteryFloor: 0.5 },
      { power: { level: 0.2, charging: false } },
    );
    expect(controller.isRunning()).toBe(false);
    expect(f.plugin.stop).toHaveBeenCalled();
    expect(changes.some((d) => d.blockedReason === 'below_battery_floor')).toBe(true);
  });

  it('applies a control change that arrives WHILE start is still launching (deferred, not lost)', async () => {
    // A native start / permission prompt can keep start() pending; a restriction made during that
    // window must be deferred and applied once the radios settle, not silently lost.
    const f = fakePlugin();
    let releaseStart = (): void => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    f.plugin.startAdvertising = vi.fn(async () => {
      f.calls.push('advertise');
      await startGate; // a pending native start / permission prompt
    });
    const changes: Array<{ blockedReason?: string }> = [];
    const controller = new CourierController({
      plugin: f.plugin,
      controls: ON,
      mode: 'courier',
      buildRequest: () => new Uint8Array([1]),
      onDecisionChange: (d) => changes.push(d),
    });

    const startPromise = controller.start(); // do NOT await — the radio is mid-start (blocked)
    // The user disables the radios while the start is still pending — this must DEFER (launching).
    await controller.applyControls({ advertisingEnabled: false, discoveryEnabled: false });
    expect(f.plugin.stop).not.toHaveBeenCalled(); // nothing applied yet — the start is still blocked

    releaseStart();
    await startPromise;
    // Once the launch settled, the deferred restriction was applied: the courier is OFF.
    expect(controller.isRunning()).toBe(false);
    expect(f.plugin.stop).toHaveBeenCalled();
    expect(changes.some((d) => d.blockedReason === 'disabled')).toBe(true);
  });

  it('switching into a forced-off mode stops a RUNNING courier immediately (§33.5)', async () => {
    const f = fakePlugin();
    const changes: Array<{ blockedReason?: string }> = [];
    const controller = new CourierController({
      plugin: f.plugin,
      controls: ON,
      mode: 'courier',
      buildRequest: () => REQUEST_BYTES,
      onDecisionChange: (d) => changes.push(d),
    });
    await controller.start();
    expect(controller.isRunning()).toBe(true);

    // The user switches into Stealth on the running courier — the mode must be enforced NOW.
    await controller.applyControls(ON, { mode: 'stealth' });
    expect(controller.isRunning()).toBe(false);
    expect(f.plugin.stop).toHaveBeenCalled();
    expect(changes.some((d) => d.blockedReason === 'forced_off_in_mode')).toBe(true);
  });

  it('does NOT report a courier exchange when it only received the PEER’S request', async () => {
    vi.useFakeTimers();
    try {
      const f = fakePlugin();
      // The "peer" answers our request with its OWN exchange REQUEST (the two-courier case) — which
      // must NOT be mistaken for our response and reported as a successful courier exchange.
      f.plugin.send = vi.fn(async (o: { endpointId: string; message: string }) => {
        f.sent.push(o);
        f.emit('payloadReceived', { endpointId: o.endpointId, message: REQUEST_B64 });
      });
      const outcomes: Array<{ carriedBy: string | null; skippedReason: string }> = [];
      const controller = new CourierController({
        plugin: f.plugin,
        controls: ON,
        mode: 'courier',
        buildRequest: () => REQUEST_BYTES,
        httpsConfig: { fetchFn: REJECTING_FETCH },
        onOutcome: (o) => outcomes.push({ carriedBy: o.carriedBy, skippedReason: o.skippedReason }),
      });
      await controller.start();
      f.emit('connectionResult', { endpointId: 'ep-1', connected: true });
      // The peer's request is dropped (not inboxed), so the courier leg times out and falls through
      // to the anchor (which also fails here) — an HONEST exchange_failed, never a false 'courier'.
      await vi.advanceTimersByTimeAsync(25_000);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.carriedBy).toBe(null);
      expect(outcomes[0]?.skippedReason).toBe('exchange_failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers a peer’s inbound exchange REQUEST via the responder seam', async () => {
    const f = fakePlugin();
    const requestsServed: number[] = [];
    const controller = new CourierController({
      plugin: f.plugin,
      controls: ON,
      mode: 'courier',
      buildRequest: () => REQUEST_BYTES,
      // The responder serves the peer's request with a real §16 response.
      buildResponse: (request) => {
        requestsServed.push(request.byteLength);
        return RESPONSE_BYTES;
      },
    });
    await controller.start();
    // The peer sends US a request (no connectionResult → our own driveExchange is not involved).
    f.emit('payloadReceived', { endpointId: 'ep-1', message: REQUEST_B64 });
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    expect(requestsServed).toEqual([REQUEST_BYTES.byteLength]); // buildResponse saw the request
    // The response was ferried back to the peer (base64 of our response bytes).
    expect(f.sent[0]?.endpointId).toBe('ep-1');
    expect(f.sent[0]?.message).toBe(toB64(RESPONSE_BYTES));
  });

  it('clears per-channel exchanged marks on teardown so a reconnect re-exchanges (key delimiter)', async () => {
    // A direction toggle restarts the radio (stopChannel → relaunch), which must CLEAR the
    // channel's `exchanged` marks using the SAME `channel\0` delimiter `key()` uses — else a stale
    // mark (a space prefix never matched) would skip a reconnecting endpoint forever.
    const f = fakePlugin();
    const outcomes: string[] = [];
    const controller = new CourierController({
      plugin: f.plugin,
      controls: ON,
      mode: 'courier',
      buildRequest: () => REQUEST_BYTES,
      httpsConfig: { fetchFn: REJECTING_FETCH },
      onOutcome: (o) => outcomes.push(o.endpointId),
    });
    await controller.start();
    f.emit('connectionResult', { endpointId: 'ep-1', connected: true });
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));

    await controller.applyControls({ advertisingEnabled: true, discoveryEnabled: false });
    f.emit('connectionResult', { endpointId: 'ep-1', connected: true });
    await vi.waitFor(() => expect(outcomes).toHaveLength(2)); // hangs if the stale mark were kept
    expect(outcomes).toEqual(['ep-1', 'ep-1']);
  });

  it('ignores a native connection event delivered AFTER the channel was torn down', async () => {
    // A Capacitor event queued before stop() removed the listeners can still invoke the handler;
    // it must NOT drive an exchange (send a courier request) for a stopped channel.  The fake's
    // remove() is a no-op, so emit still reaches the handler — exactly the queued-event case.
    const f = fakePlugin();
    const controller = new CourierController({
      plugin: f.plugin,
      controls: ON,
      mode: 'courier',
      buildRequest: () => REQUEST_BYTES,
      httpsConfig: { fetchFn: REJECTING_FETCH },
    });
    await controller.start();
    await controller.stop();

    f.emit('connectionResult', { endpointId: 'ep-late', connected: true });
    await Promise.resolve();
    expect(f.sent).toHaveLength(0); // no courier request sent after stop
  });

  it('charges bytes already ferried even when the exchange yields nothing (no budget bypass)', async () => {
    vi.useFakeTimers();
    try {
      const f = fakePlugin();
      // A peer that connects but never answers: the courier leg sends the request then times out,
      // the HTTPS anchor is unreachable → the exchange yields nothing, but the request bytes were
      // already ferried to the peer.
      f.plugin.send = vi.fn(async (o: { endpointId: string; message: string }) => {
        f.sent.push(o); // NO echo back
      });
      const outcomes: Array<{ endpointId: string; skippedReason: string }> = [];
      const controller = new CourierController({
        plugin: f.plugin,
        controls: { ...ON, storageBudgetBytes: 8 },
        mode: 'courier',
        buildRequest: () => new Uint8Array([1, 2, 3, 4, 5]), // 5 bytes ferried per attempt
        httpsConfig: { fetchFn: REJECTING_FETCH },
        onOutcome: (o) =>
          outcomes.push({ endpointId: o.endpointId, skippedReason: o.skippedReason }),
      });
      await controller.start();

      f.emit('connectionResult', { endpointId: 'ep-1', connected: true });
      // Advance past the courier leg deadline so it fails fast (no real 20s wait); the anchor then
      // fails too → offlineExchange yields null → the finally still charges the ferried bytes.
      await vi.advanceTimersByTimeAsync(25_000);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.skippedReason).toBe('exchange_failed');
      expect(f.sent).toHaveLength(1); // the request WAS ferried to the peer

      // A second peer's 5-byte request now exceeds the 8-byte budget BECAUSE the first failed
      // ferry's bytes were charged — without the fix sharedBytes would still be 0 and this proceeds.
      f.emit('connectionResult', { endpointId: 'ep-2', connected: true });
      await vi.advanceTimersByTimeAsync(1);
      expect(outcomes).toHaveLength(2);
      expect(outcomes[1]).toEqual({ endpointId: 'ep-2', skippedReason: 'over_storage_budget' });
    } finally {
      vi.useRealTimers();
    }
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
