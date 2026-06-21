// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.11.4 — the C0-first sync HOOKS wiring.  The orchestrator + suppression logic is
// covered by `sync-triggers.test.ts`; here we prove the boot wiring: the trigger
// listeners attach (and detach on stop), the wiring is idempotent, an app-open fires the
// minimal C0 pulse through the lazily-imported pass, and a service-worker `lcap-sync`
// message re-triggers a pass.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { startLcapSync, stopLcapSync } from './sync-boot.js';

afterEach(() => {
  stopLcapSync();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('startLcapSync (WS-R.11.4 hooks wiring)', () => {
  it('attaches the online/focus trigger listeners and is idempotent; stop removes them', () => {
    const add = vi.spyOn(globalThis, 'addEventListener');
    const remove = vi.spyOn(globalThis, 'removeEventListener');

    const stop = startLcapSync();
    expect(add.mock.calls.some(([type]) => type === 'online')).toBe(true);
    expect(add.mock.calls.some(([type]) => type === 'focus')).toBe(true);

    // A second start does not double-attach (one orchestrator).
    const attachedCount = add.mock.calls.length;
    startLcapSync();
    expect(add.mock.calls.length).toBe(attachedCount);

    stop();
    expect(remove.mock.calls.some(([type]) => type === 'online')).toBe(true);
  });

  it('fires the minimal C0 pulse on app open, through the lazily-imported pass', async () => {
    const fetchMock = vi.fn(
      async (_url: string) => new Response(new Uint8Array() as BodyInit, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // A tiny real debounce so the lazily-imported pass + fetch settle in the test.
    startLcapSync({ debounceMs: 1 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/lcap/v2/pulse');
  });

  it('a service-worker lcap-sync message re-triggers a C0 pass (and ignores other messages)', async () => {
    const fetchMock = vi.fn(
      async (_url: string) => new Response(new Uint8Array() as BodyInit, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // A minimal serviceWorker mock that captures the message listener.
    let messageHandler: ((event: { data?: unknown }) => void) | undefined;
    vi.stubGlobal('navigator', {
      serviceWorker: {
        addEventListener: (_type: string, handler: (event: { data?: unknown }) => void) => {
          messageHandler = handler;
        },
        removeEventListener: () => undefined,
      },
    });

    startLcapSync({ debounceMs: 1 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1)); // the initial open pulse
    fetchMock.mockClear();

    // The SW posts a background-sync message → the client runs another pass.
    messageHandler?.({ data: { type: 'lcap-sync' } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // An unrelated message does NOT trigger a pass.
    fetchMock.mockClear();
    messageHandler?.({ data: { type: 'something-else' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
