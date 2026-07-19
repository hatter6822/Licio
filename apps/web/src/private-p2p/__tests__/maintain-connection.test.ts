// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WP-7 finding 11 — the §15.4 reconnect manager: re-dial on a NON-GRACEFUL channel drop
// (the peer did not send `bye`), with bounded exponential backoff that resets on a
// successful (re)connect; a graceful drop, a local close(), or exhausting maxAttempts
// stops reconnecting.  The `dial` is injected, so the logic is tested without WebRTC.

import { describe, expect, it } from 'vitest';
import { type DialedSession, maintainConnection } from '../sync-session.js';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('maintainConnection (§15.4 reconnect)', () => {
  it('reconnects on a non-graceful drop but NOT on a graceful one', async () => {
    let dials = 0;
    const onCloseRef: { current: ((graceful: boolean) => void) | null } = { current: null };
    const dial = (onClose: (graceful: boolean) => void): Promise<DialedSession> => {
      dials += 1;
      onCloseRef.current = onClose;
      return Promise.resolve({ close: () => {} });
    };
    const ctrl = maintainConnection(dial, { backoffMs: 1, sleep: () => Promise.resolve() });
    await flush();
    expect(dials).toBe(1);
    expect(ctrl.status()).toBe('connected');

    // A network drop (no bye) → reconnect.
    onCloseRef.current?.(false);
    await flush();
    expect(dials).toBe(2);
    expect(ctrl.status()).toBe('connected');

    // A graceful drop (peer said bye) → do NOT reconnect.
    onCloseRef.current?.(true);
    await flush();
    expect(dials).toBe(2);
    expect(ctrl.status()).toBe('closed');
  });

  it('gives up after maxAttempts when every re-dial fails', async () => {
    let dials = 0;
    const dial = (): Promise<DialedSession> => {
      dials += 1;
      return Promise.reject(new Error('handshake failed'));
    };
    const ctrl = maintainConnection(dial, {
      maxAttempts: 3,
      backoffMs: 1,
      sleep: () => Promise.resolve(),
    });
    await flush();
    await flush();
    expect(ctrl.status()).toBe('failed');
    expect(dials).toBe(4); // the initial dial + 3 retries, then give up
  });

  it('close() stops reconnecting and gracefully closes the current session', async () => {
    let dials = 0;
    const closes: boolean[] = [];
    const onCloseRef: { current: ((graceful: boolean) => void) | null } = { current: null };
    const dial = (onClose: (graceful: boolean) => void): Promise<DialedSession> => {
      dials += 1;
      onCloseRef.current = onClose;
      return Promise.resolve({ close: (graceful = true) => closes.push(graceful) });
    };
    const ctrl = maintainConnection(dial, { backoffMs: 1, sleep: () => Promise.resolve() });
    await flush();
    expect(dials).toBe(1);
    ctrl.close();
    expect(closes).toEqual([true]); // graceful close of the current session
    expect(ctrl.status()).toBe('closed');

    // A drop AFTER close() must NOT reconnect — assert the REAL dial counter is unchanged.
    const dialsAtClose = dials;
    onCloseRef.current?.(false);
    await flush();
    expect(dials).toBe(dialsAtClose);
  });

  it('close() DURING an in-flight dial closes the raced session and stays closed', async () => {
    let dials = 0;
    const closes: boolean[] = [];
    const resolveRef: { current: ((s: DialedSession) => void) | null } = { current: null };
    const dial = (): Promise<DialedSession> => {
      dials += 1;
      return new Promise<DialedSession>((resolve) => {
        resolveRef.current = resolve;
      });
    };
    const ctrl = maintainConnection(dial, { backoffMs: 1, sleep: () => Promise.resolve() });
    await flush();
    expect(dials).toBe(1);
    // The dial has not resolved yet — `current` is still null.
    expect(ctrl.status()).toBe('connecting');

    // Close BEFORE the dial resolves: close() cannot reach the not-yet-dialed session.
    ctrl.close();
    expect(ctrl.status()).toBe('closed');

    // The dial now resolves with a LIVE session; it must be closed here, not surfaced.
    resolveRef.current?.({ close: (graceful = true) => closes.push(graceful) });
    await flush();
    expect(closes).toEqual([true]); // the raced session was closed
    expect(ctrl.status()).toBe('closed'); // never flipped to 'connected'
  });

  it('a successful reconnect RESETS the backoff window', async () => {
    let dials = 0;
    const onCloseRef: { current: ((graceful: boolean) => void) | null } = { current: null };
    const dial = (onClose: (graceful: boolean) => void): Promise<DialedSession> => {
      dials += 1;
      onCloseRef.current = onClose;
      return Promise.resolve({ close: () => {} });
    };
    const ctrl = maintainConnection(dial, {
      maxAttempts: 1,
      backoffMs: 1,
      sleep: () => Promise.resolve(),
    });
    await flush();
    // Three separate drops, each reconnecting successfully — never exhausts maxAttempts=1
    // because each success resets the counter.
    for (let i = 0; i < 3; i++) {
      onCloseRef.current?.(false);
      await flush();
    }
    expect(dials).toBe(4); // initial + 3 reconnects
    expect(ctrl.status()).toBe('connected');
  });
});
