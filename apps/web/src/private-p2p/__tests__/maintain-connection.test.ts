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
    let lastOnClose: ((graceful: boolean) => void) | null = null;
    const dial = (onClose: (graceful: boolean) => void): Promise<DialedSession> => {
      dials += 1;
      lastOnClose = onClose;
      return Promise.resolve({ close: () => {} });
    };
    const ctrl = maintainConnection(dial, { backoffMs: 1, sleep: () => Promise.resolve() });
    await flush();
    expect(dials).toBe(1);
    expect(ctrl.status()).toBe('connected');

    // A network drop (no bye) → reconnect.
    lastOnClose?.(false);
    await flush();
    expect(dials).toBe(2);
    expect(ctrl.status()).toBe('connected');

    // A graceful drop (peer said bye) → do NOT reconnect.
    lastOnClose?.(true);
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
    const closes: boolean[] = [];
    let lastOnClose: ((graceful: boolean) => void) | null = null;
    const dial = (onClose: (graceful: boolean) => void): Promise<DialedSession> => {
      lastOnClose = onClose;
      return Promise.resolve({ close: (graceful = true) => closes.push(graceful) });
    };
    const ctrl = maintainConnection(dial, { backoffMs: 1, sleep: () => Promise.resolve() });
    await flush();
    ctrl.close();
    expect(closes).toEqual([true]); // graceful close of the current session
    expect(ctrl.status()).toBe('closed');

    // A drop AFTER close() must not reconnect.
    const dialsAfter = 0;
    lastOnClose?.(false);
    await flush();
    expect(dialsAfter).toBe(0);
  });

  it('a successful reconnect RESETS the backoff window', async () => {
    let dials = 0;
    let lastOnClose: ((graceful: boolean) => void) | null = null;
    const dial = (onClose: (graceful: boolean) => void): Promise<DialedSession> => {
      dials += 1;
      lastOnClose = onClose;
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
      lastOnClose?.(false);
      await flush();
    }
    expect(dials).toBe(4); // initial + 3 reconnects
    expect(ctrl.status()).toBe('connected');
  });
});
