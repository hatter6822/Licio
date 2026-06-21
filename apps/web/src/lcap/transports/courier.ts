// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The courier transport (OFFLINE_SPEC §22.5, WS-R.15.4b) — a manual, user-mediated
// ferry (USB stick / file hand-off / future native Nearby) over the shared
// LcapTransport seam.  It reuses the WS-R.15.1 `.licio-bundle` path (no new format): a
// `send` queues the exchange message into an OUTBOX the user exports as a bundle and
// carries; a `receive` returns the next message from an INBOX the user populated by
// importing a bundle a peer handed back.  The ferry is asynchronous and user-driven, so
// `receive` resolves as soon as an inbound message is available (buffering any that
// arrive first) and never blocks the seam indefinitely.  Public-only by default
// (`carriesPrivate: false`); the courier-controls UI (R.15.4e) gates private content.
//
// The native channels (Wi-Fi Direct / BLE / Nearby) ride the SAME adapter behind a
// `CourierMedium` — the Capacitor shell that provides them is the deferred WS-R.15.4a.

import type { LcapTransport, TransportCapabilities } from '@licio/lcap';

export const COURIER_CAPABILITIES: TransportCapabilities = {
  id: 'courier',
  bidirectional: true,
  serverMediated: false,
  carriesPrivate: false,
  maxExchangeBytes: 64 * 1024 * 1024,
  latencyClass: 'high',
};

/**
 * The out-of-band medium a courier ferries.  Outbound messages are handed to the user
 * (exported as a bundle); inbound messages arrive when the user imports a peer's bundle.
 * The default in-memory medium is used by tests + same-device hand-offs; a native
 * channel provides its own.
 */
export interface CourierMedium {
  /** Hand an outbound message to the ferry (the user exports + carries it). */
  enqueueOutbound(message: Uint8Array): void;
  /** Take the next inbound message the user ferried in, or `null` if none yet. */
  takeInbound(): Uint8Array | null;
  /** Register to be notified when an inbound message arrives (for a pending receive). */
  onInbound?(listener: () => void): void;
}

/** A simple in-memory courier medium (same-device hand-off + tests). */
export class InMemoryCourierMedium implements CourierMedium {
  readonly outbox: Uint8Array[] = [];
  private readonly inbox: Uint8Array[] = [];
  private listeners: Array<() => void> = [];

  enqueueOutbound(message: Uint8Array): void {
    this.outbox.push(message);
  }

  takeInbound(): Uint8Array | null {
    return this.inbox.shift() ?? null;
  }

  onInbound(listener: () => void): void {
    this.listeners.push(listener);
  }

  /** Deliver an inbound message (the peer's ferried response) + wake any waiter. */
  deliverInbound(message: Uint8Array): void {
    this.inbox.push(message);
    const listeners = this.listeners;
    this.listeners = [];
    for (const listener of listeners) listener();
  }
}

export class CourierTransport implements LcapTransport {
  readonly capabilities = COURIER_CAPABILITIES;
  constructor(private readonly medium: CourierMedium) {}

  async open(): Promise<void> {
    // The ferry is always "open"; reachability is the user carrying a bundle.
  }

  async send(message: Uint8Array): Promise<void> {
    this.medium.enqueueOutbound(message);
  }

  async receive(signal?: AbortSignal): Promise<Uint8Array | null> {
    const ready = this.medium.takeInbound();
    if (ready) return ready;
    if (!this.medium.onInbound) return null; // a non-notifying medium has nothing yet
    return new Promise<Uint8Array | null>((resolve) => {
      const settle = (): void => resolve(this.medium.takeInbound());
      this.medium.onInbound?.(settle);
      signal?.addEventListener('abort', () => resolve(null));
    });
  }

  async close(): Promise<void> {
    // No teardown; the outbox persists until the user exports it.
  }
}
