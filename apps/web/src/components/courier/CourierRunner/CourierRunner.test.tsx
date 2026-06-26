// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4c/d/e — the courier RUNTIME driver UI.  Asserts: outside the native shell the
// runtime control is honestly disabled (no Start, a "needs the app" explanation); the
// per-channel selection persists; inside a faked native shell pressing Start constructs +
// drives a `CourierController` (mocked) and reports the honest running state; a blocked
// decision surfaces its reason, never a false "running"; and the copy never uses a false
// trust word.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setOperationalMode } from '../../../lcap/mode-state.js';
import { getCourierControls } from '../../../lcap/transports/courier-controls-state.js';
import { checkA11y } from '../../../test/axe.js';
import { CourierRunner } from './CourierRunner.js';

const FORBIDDEN = /\b(secure|trusted|safe|anonymous)\b/i;

// Mock the dynamically-imported controller + channel resolver + §16 exchange engine so
// the test drives the runtime path without any native plugin or real codec.
const controllerStart = vi.fn(async () => ({ advertise: true, discover: true, blockedReason: '' }));
const controllerStop = vi.fn(async () => {});
const activeChannels = vi.fn(() => ['nearby'] as const);
const controllerIsRunning = vi.fn(() => true);
const controllerApplyControls = vi.fn(async () => {});
const controllerStartDecision = vi.fn(() => ({
  advertise: false,
  discover: false,
  blockedReason: 'radio_unavailable',
}));
// The last config the controller was constructed with — lets a test fire the async
// onDecisionChange callback (a late radio start-failure) the controller would invoke, and assert
// the bidirectional wiring (a real responder + a response-ingestion onOutcome).
interface CapturedConfig {
  onDecisionChange?: (d: unknown) => void;
  buildRequest?: (endpointId: string) => unknown;
  buildResponse?: (request: Uint8Array, endpointId: string) => unknown;
  onOutcome?: (o: {
    response: Uint8Array | null;
    channel: string;
    carriedBy: string | null;
    skippedReason: string;
  }) => void;
}
let lastControllerConfig: CapturedConfig | undefined;
const ControllerCtor = vi.fn(function (this: Record<string, unknown>, config: CapturedConfig) {
  lastControllerConfig = config;
  this['start'] = controllerStart;
  this['stop'] = controllerStop;
  this['activeChannels'] = activeChannels;
  this['isRunning'] = controllerIsRunning;
  this['startDecision'] = controllerStartDecision;
  this['applyControls'] = controllerApplyControls;
});
const resolveCourierChannels = vi.fn((..._a: unknown[]) => [{ channel: 'nearby', plugin: {} }]);

const readCourierPower = vi.fn(async () => ({}));
vi.mock('../../../lcap/transports/courier-controller.js', () => ({
  CourierController: ControllerCtor,
  readCourierPower: (...a: unknown[]) => readCourierPower(...(a as [])),
}));
vi.mock('../../../lcap/transports/courier-channels.js', async (importOriginal) => {
  // Keep the real channel-info metadata + channel list; override only the resolver.
  const real =
    await importOriginal<typeof import('../../../lcap/transports/courier-channels.js')>();
  return { ...real, resolveCourierChannels: (...a: unknown[]) => resolveCourierChannels(...a) };
});
// The §16 exchange engine + the lcap_v2 db handle (stubbed: this suite drives the runtime UI, not
// the real store).  Keep the real db module but stub `getLcapDb` so no IndexedDB is touched.
const buildClientExchangeRequest = vi.fn(async () => new Uint8Array([1]));
const respondToClientExchange = vi.fn(async () => new Uint8Array([2]));
const ingestClientExchangeResponse = vi.fn(async () => null);
vi.mock('../../../lcap/exchange.js', () => ({
  buildClientExchangeRequest: (...a: unknown[]) => buildClientExchangeRequest(...(a as [])),
  respondToClientExchange: (...a: unknown[]) => respondToClientExchange(...(a as [])),
  ingestClientExchangeResponse: (...a: unknown[]) => ingestClientExchangeResponse(...(a as [])),
}));
vi.mock('../../../lcap/db.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lcap/db.js')>();
  return { ...real, getLcapDb: vi.fn(async () => ({}) as IDBDatabase) };
});

function injectNativeShell(): void {
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    registerPlugin: () => ({}),
  };
}

function clearNativeShell(): void {
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
}

describe('CourierRunner (WS-R.15.4c/d/e)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    controllerStart.mockResolvedValue({ advertise: true, discover: true, blockedReason: '' });
  });
  afterEach(() => {
    localStorage.clear();
    clearNativeShell();
  });

  it('is honest outside the native shell: no Start, an explanation that the app is needed', () => {
    render(<CourierRunner />);
    expect(screen.getByText(/need the installed licio app/i)).toBeInTheDocument();
    const start = screen.getByRole('button', { name: /start courier/i });
    expect(start).toHaveAttribute('aria-disabled', 'true');
  });

  it('persists a per-channel selection once the disclosure is acknowledged', () => {
    render(<CourierRunner />);
    fireEvent.click(
      screen.getByRole('checkbox', { name: /i understand what a nearby radio reveals/i }),
    );
    // The per-channel selection appears after acknowledgment.
    const wifi = screen.getByRole('checkbox', { name: /wi-fi direct/i });
    fireEvent.click(wifi);
    expect(getCourierControls().enabledChannels).toContain('wifiDirect');
  });

  it('drives a CourierController inside the native shell and reports running honestly', async () => {
    injectNativeShell();
    render(<CourierRunner />);
    // Acknowledge + enable advertising so a Start is permitted.
    fireEvent.click(
      screen.getByRole('checkbox', { name: /i understand what a nearby radio reveals/i }),
    );
    fireEvent.click(screen.getByRole('switch', { name: /advertise this device/i }));

    const start = screen.getByRole('button', { name: /start courier/i });
    expect(start).not.toHaveAttribute('aria-disabled');
    fireEvent.click(start);

    await waitFor(() => expect(ControllerCtor).toHaveBeenCalledOnce());
    expect(controllerStart).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByText(/^Running$/)).toBeInTheDocument());
    // A Stop control now drives the controller teardown.
    fireEvent.click(screen.getByRole('button', { name: /stop courier/i }));
    await waitFor(() => expect(controllerStop).toHaveBeenCalled());
  });

  it('wires a BIDIRECTIONAL courier: a real responder + response-ingestion', async () => {
    injectNativeShell();
    render(<CourierRunner />);
    fireEvent.click(
      screen.getByRole('checkbox', { name: /i understand what a nearby radio reveals/i }),
    );
    fireEvent.click(screen.getByRole('switch', { name: /advertise this device/i }));
    fireEvent.click(screen.getByRole('button', { name: /start courier/i }));
    await waitFor(() => expect(ControllerCtor).toHaveBeenCalledOnce());

    // The controller is constructed with a real responder (serves a peer's request)...
    expect(typeof lastControllerConfig?.buildResponse).toBe('function');
    await lastControllerConfig?.buildResponse?.(new Uint8Array([7]), 'ep');
    expect(respondToClientExchange).toHaveBeenCalled();

    // ...a request builder (advertises our gaps)...
    await lastControllerConfig?.buildRequest?.('ep');
    expect(buildClientExchangeRequest).toHaveBeenCalled();

    // ...and an onOutcome that INGESTS a served response into the local store.
    lastControllerConfig?.onOutcome?.({
      response: new Uint8Array([9]),
      channel: 'nearby',
      carriedBy: 'courier',
      skippedReason: '',
    });
    expect(ingestClientExchangeResponse).toHaveBeenCalled();
  });

  it('aborts the start if a forced-off mode lands DURING the async init (#A)', async () => {
    injectNativeShell();
    render(<CourierRunner />);
    fireEvent.click(
      screen.getByRole('checkbox', { name: /i understand what a nearby radio reveals/i }),
    );
    fireEvent.click(screen.getByRole('switch', { name: /advertise this device/i }));
    // The user switches into Stealth (radios forced off) WHILE the async imports / IDB open /
    // battery read are still pending — the live re-check must abort before constructing the radios.
    readCourierPower.mockImplementationOnce(async () => {
      setOperationalMode('stealth');
      return {};
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start courier/i }));
    });
    await waitFor(() => expect(readCourierPower).toHaveBeenCalled());
    expect(ControllerCtor).not.toHaveBeenCalled(); // never brought radios up after the forced-off mode
  });

  it('cancels the start if the runner UNMOUNTS during the async init (#7)', async () => {
    injectNativeShell();
    let resolvePower: (() => void) | undefined;
    readCourierPower.mockImplementationOnce(
      () =>
        new Promise<object>((res) => {
          resolvePower = () => res({});
        }),
    );
    const { unmount } = render(<CourierRunner />);
    fireEvent.click(
      screen.getByRole('checkbox', { name: /i understand what a nearby radio reveals/i }),
    );
    fireEvent.click(screen.getByRole('switch', { name: /advertise this device/i }));
    fireEvent.click(screen.getByRole('button', { name: /start courier/i }));
    await waitFor(() => expect(readCourierPower).toHaveBeenCalled());
    unmount(); // the page leaves WHILE the battery read is still pending
    await act(async () => {
      resolvePower?.(); // the async init resumes after the unmount
      await Promise.resolve();
    });
    expect(ControllerCtor).not.toHaveBeenCalled(); // no radios brought up after the UI owner is gone
  });

  it('reconciles a RUNNING courier when the operational mode changes (§33.5 forced-off)', async () => {
    injectNativeShell();
    render(<CourierRunner />);
    fireEvent.click(
      screen.getByRole('checkbox', { name: /i understand what a nearby radio reveals/i }),
    );
    fireEvent.click(screen.getByRole('switch', { name: /advertise this device/i }));
    fireEvent.click(screen.getByRole('button', { name: /start courier/i }));
    await waitFor(() => expect(screen.getByText(/^Running$/)).toBeInTheDocument());

    // Switching the §33 mode while running must reach the live controller with the NEW mode, so it
    // can enforce a forced-off mode immediately (the controller-level test proves it then stops).
    controllerApplyControls.mockClear();
    await act(async () => {
      setOperationalMode('stealth');
    });
    await waitFor(() => expect(controllerApplyControls).toHaveBeenCalled());
    const lastCall = controllerApplyControls.mock.calls.at(-1) as unknown[] | undefined;
    expect((lastCall?.[1] as { mode?: string } | undefined)?.mode).toBe('stealth');
  });

  it('drops a RUNNING courier to blocked when a radio fails to start asynchronously', async () => {
    injectNativeShell();
    render(<CourierRunner />);
    fireEvent.click(
      screen.getByRole('checkbox', { name: /i understand what a nearby radio reveals/i }),
    );
    fireEvent.click(screen.getByRole('switch', { name: /advertise this device/i }));
    fireEvent.click(screen.getByRole('button', { name: /start courier/i }));
    await waitFor(() => expect(screen.getByText(/^Running$/)).toBeInTheDocument());

    // The radio's native start Task rejects LATE — the controller invokes onDecisionChange, which
    // the runner must consume (it cannot see this via start()'s already-resolved return value).
    expect(lastControllerConfig?.onDecisionChange).toBeDefined();
    act(() => {
      lastControllerConfig?.onDecisionChange?.({
        advertise: false,
        discover: false,
        blockedReason: 'radio_unavailable',
      });
    });
    await waitFor(() => expect(screen.queryByText(/^Running$/)).not.toBeInTheDocument());
    expect(screen.getByText(/a radio could not start/i)).toBeInTheDocument();
  });

  it('surfaces a blocked decision honestly (never a false "running")', async () => {
    injectNativeShell();
    controllerStart.mockResolvedValue({
      advertise: false,
      discover: false,
      blockedReason: 'below_battery_floor',
    });
    render(<CourierRunner />);
    fireEvent.click(
      screen.getByRole('checkbox', { name: /i understand what a nearby radio reveals/i }),
    );
    fireEvent.click(screen.getByRole('switch', { name: /advertise this device/i }));
    fireEvent.click(screen.getByRole('button', { name: /start courier/i }));

    await waitFor(() => expect(controllerStop).toHaveBeenCalled());
    expect(screen.getByText(/battery is below your courier floor/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Running$/)).not.toBeInTheDocument();
  });

  it('never uses a false trust word', () => {
    render(<CourierRunner />);
    expect(document.body.textContent ?? '').not.toMatch(FORBIDDEN);
  });

  it('has no axe violations', async () => {
    const { container } = render(<CourierRunner />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
