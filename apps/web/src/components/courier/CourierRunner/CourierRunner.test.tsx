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

// Mock the dynamically-imported controller + channel resolver + frontier-request builder so
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
// onDecisionChange callback (a late radio start-failure) the controller would invoke.
let lastControllerConfig: { onDecisionChange?: (d: unknown) => void } | undefined;
const ControllerCtor = vi.fn(function (
  this: Record<string, unknown>,
  config: { onDecisionChange?: (d: unknown) => void },
) {
  lastControllerConfig = config;
  this['start'] = controllerStart;
  this['stop'] = controllerStop;
  this['activeChannels'] = activeChannels;
  this['isRunning'] = controllerIsRunning;
  this['startDecision'] = controllerStartDecision;
  this['applyControls'] = controllerApplyControls;
});
const resolveCourierChannels = vi.fn((..._a: unknown[]) => [{ channel: 'nearby', plugin: {} }]);

vi.mock('../../../lcap/transports/courier-controller.js', () => ({
  CourierController: ControllerCtor,
  readCourierPower: vi.fn(async () => ({})),
}));
vi.mock('../../../lcap/transports/courier-channels.js', async (importOriginal) => {
  // Keep the real channel-info metadata + channel list; override only the resolver.
  const real =
    await importOriginal<typeof import('../../../lcap/transports/courier-channels.js')>();
  return { ...real, resolveCourierChannels: (...a: unknown[]) => resolveCourierChannels(...a) };
});
vi.mock('../../../lcap/transports/frontier-request.js', () => ({
  prepareCourierFrontierRequest: vi.fn(async () => () => new Uint8Array([1])),
}));

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
