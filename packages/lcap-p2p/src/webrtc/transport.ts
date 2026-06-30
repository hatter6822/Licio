// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The WebRTC `RTCDataChannel` LcapTransport (OFFLINE_SPEC §22.6, WS-R.15.6).  Carries
// the §16 exchange between two browsers over a data channel; received frames go through
// the SAME reader/validator as every other transport (source-independence).  The
// adapter is written over a minimal `DataChannelLike` so it is unit-testable with a
// fake channel; live establishment (`connectWebrtc`) wires a real RTCPeerConnection via
// the server-blind signaling rendezvous + STUN and is exercised by the gated E2E.
//
// An LCAP exchange pack can be far larger than a single SCTP datachannel message, so
// `send` FRAGMENTS the message into ≤ 16 KiB datachannel messages (the cross-browser
// safe size) and the receiver REASSEMBLES the exact original bytes (`./fragment.js`).
// Reassembly is fail-closed and DoS-bounded: a malformed, out-of-order, conflicting, or
// over-cap fragment aborts the channel rather than mis-stitching bytes.
//
// A peer transport is public-only (`carriesPrivate: false`).  The seam's `transportMayCarry` gate
// keeps non-public packs off any `carriesPrivate:false` transport for callers that route through
// `fallbackExchange` — but the LIVE WebRTC sync driver (apps/web `sync-over-p2p.ts`) drives this
// transport directly, so the REAL public-only enforcement on that path is the client responder
// (`exchange.ts` `collectShareableCids` — a per-record `visibility_scope === 'public'` filter) plus
// the `publicOnly` ingest, not the seam gate (§21.4/§26.4).

import type { LcapTransport, TransportCapabilities } from '@licio/lcap';
import { TransportUnavailableError } from '@licio/lcap';
import { FragmentReassembler, fragmentMessage, MAX_REASSEMBLY_BYTES } from './fragment.js';

/** The slice of `RTCDataChannel` the transport needs (so a fake can stand in). */
export interface DataChannelLike {
  readyState: 'connecting' | 'open' | 'closing' | 'closed';
  binaryType?: string;
  /** Outbound bytes still queued in the SCTP send buffer (present on a real channel). */
  bufferedAmount?: number;
  /** The drain low-water mark; `onbufferedamountlow` fires when `bufferedAmount` drops below it. */
  bufferedAmountLowThreshold?: number;
  send(data: Uint8Array): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror?: ((event: unknown) => void) | null;
  onbufferedamountlow?: (() => void) | null;
}

export const WEBRTC_CAPABILITIES: TransportCapabilities = {
  id: 'webrtc',
  bidirectional: true,
  serverMediated: false,
  carriesPrivate: false, // public-only over P2P unless WS-S encryption + permission (R.11.5)
  // The per-exchange ceiling equals the reassembly cap — a single inbound exchange can
  // pin at most this many bytes before it reaches the validator (the §27 DoS bound).
  maxExchangeBytes: MAX_REASSEMBLY_BYTES,
  latencyClass: 'low',
};

/** Coerce a datachannel message payload (ArrayBuffer | Uint8Array | string) to bytes. */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return null;
}

/**
 * An LcapTransport over an established data channel.  `receive` resolves with the next
 * message (buffering any that arrive before it is called), or `null` once the channel
 * closes — so a one-request/one-response exchange round drives cleanly.
 */
export class WebrtcTransport implements LcapTransport {
  readonly capabilities = WEBRTC_CAPABILITIES;
  /** Completed (reassembled) inbound messages awaiting a `receive`. */
  private readonly inbox: Uint8Array[] = [];
  /** Total bytes queued in {@link inbox} — bounded so a peer cannot grow renderer memory by sending
   *  many COMPLETE messages faster than they are consumed (the reassembler caps ONE message; this
   *  caps the accumulation across messages at the advertised `maxExchangeBytes`) (PUB-WEBRTC-4). */
  private inboxBytes = 0;
  private waiting: ((value: Uint8Array | null) => void) | null = null;
  private closed = false;
  /** Serializes `send()` calls (single-flight): a second send awaits the first rather than
   *  interleaving its fragments onto the one ordered datachannel (PUB-WEBRTC-5). */
  private sendChain: Promise<void> = Promise.resolve();
  /** Reassembles fragmented inbound datachannel messages into whole exchange bodies. */
  private readonly reassembler = new FragmentReassembler();
  /** Monotonic per-send message id so the receiver can detect a message boundary. */
  private nextMessageId = 0;
  /** SCTP backpressure (§22.6): pause fragment sends once this many bytes are queued. */
  private static readonly DRAIN_HIGH_WATER = 8 * 1024 * 1024;
  private static readonly DRAIN_LOW_WATER = 1 * 1024 * 1024;
  /** Bound on consecutive 2 s drain waits before declaring the channel stuck (≈60 s). */
  private static readonly MAX_DRAIN_WAITS = 30;
  /** Send promises parked on a full SCTP buffer, woken by `onbufferedamountlow`/`onclose`. */
  private drainWaiters: Array<() => void> = [];

  constructor(private readonly channel: DataChannelLike) {
    channel.binaryType = 'arraybuffer';
    // Wire SCTP backpressure when the channel exposes it (a real RTCDataChannel does; a
    // minimal fake does not, so `send` falls back to no-wait there).
    if ('bufferedAmountLowThreshold' in channel) {
      channel.bufferedAmountLowThreshold = WebrtcTransport.DRAIN_LOW_WATER;
      channel.onbufferedamountlow = () => this.wakeDrainWaiters();
    }
    channel.onmessage = (event) => {
      const bytes = toBytes(event.data);
      if (!bytes) return;
      let completed: Uint8Array | null;
      try {
        completed = this.reassembler.accept(bytes);
      } catch {
        // A malformed/out-of-order/over-cap fragment is fatal: a hostile peer must never
        // be able to mis-stitch a partial message.  Tear the channel down fail-closed.
        this.abort();
        return;
      }
      if (!completed) return; // mid-message; wait for the remaining fragments
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = null;
        resolve(completed);
      } else {
        this.inbox.push(completed);
        this.inboxBytes += completed.length;
        // Bound the un-consumed queue at the advertised single-exchange ceiling: a peer that floods
        // complete messages faster than `receive()` drains them is torn down fail-closed (PUB-WEBRTC-4).
        if (this.inboxBytes > MAX_REASSEMBLY_BYTES) this.abort();
      }
    };
    channel.onclose = () => {
      this.closed = true;
      this.drainWaiterWithNull();
      this.wakeDrainWaiters(); // unblock any parked send so it observes the closed channel
    };
  }

  private drainWaiterWithNull(): void {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(null);
    }
  }

  private wakeDrainWaiters(): void {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const wake of waiters) wake();
  }

  /** Wait for ONE drain signal — `onbufferedamountlow` / `onclose` / `abort` — or a 2 s safety
   *  timeout so a missing event never hangs the wait (the caller RE-CHECKS `bufferedAmount`). */
  private waitForDrainEvent(): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 2_000);
      this.drainWaiters.push(finish);
    });
  }

  /**
   * Park until the SCTP send buffer drains below the high-water mark (or the channel closes).
   * Without this, sending a multi-MiB pack as ~1024 back-to-back fragments overruns the SCTP
   * buffer and `channel.send` throws `OperationError` mid-stream — the peer then receives a
   * truncated message its reassembler (correctly) rejects.  Re-checks `bufferedAmount` after each
   * wait: the safety timeout must NEVER let a still-full buffer through (resuming sends while SCTP
   * is full would defeat the backpressure and risk `OperationError` / an unbounded send buffer).
   * If it never drains within the bound, the send FAILS so the exchange falls over.
   */
  private async awaitDrain(): Promise<void> {
    const ch = this.channel;
    if (typeof ch.bufferedAmount !== 'number') return; // a fake/non-buffering channel
    let waits = 0;
    while (
      ch.readyState === 'open' &&
      (ch.bufferedAmount ?? 0) > WebrtcTransport.DRAIN_HIGH_WATER
    ) {
      if (++waits > WebrtcTransport.MAX_DRAIN_WAITS) {
        throw new TransportUnavailableError('webrtc', 'SCTP send buffer did not drain');
      }
      await this.waitForDrainEvent();
    }
  }

  /** Fail-closed teardown: mark closed, wake any waiter with `null`, close the channel. */
  private abort(): void {
    this.closed = true;
    this.drainWaiterWithNull();
    this.wakeDrainWaiters();
    if (this.channel.readyState !== 'closed') this.channel.close();
  }

  async open(): Promise<void> {
    if (this.channel.readyState !== 'open') {
      throw new TransportUnavailableError('webrtc', 'data channel is not open');
    }
  }

  async send(message: Uint8Array): Promise<void> {
    // Single-flight: a concurrent send awaits the in-flight one so its fragments are not interleaved
    // with another message's on the single ordered datachannel (which the receiver — one in-flight
    // message at a time — would reject) (PUB-WEBRTC-5).  A prior failure is swallowed in the CHAIN so
    // it cannot wedge later sends, while THIS caller still gets its own rejection.
    const run = this.sendChain.then(() => this.sendSerial(message));
    this.sendChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async sendSerial(message: Uint8Array): Promise<void> {
    if (this.channel.readyState !== 'open') {
      throw new TransportUnavailableError('webrtc', 'data channel closed before send');
    }
    if (message.length > MAX_REASSEMBLY_BYTES) {
      throw new TransportUnavailableError(
        'webrtc',
        `message of ${message.length} bytes exceeds the ${MAX_REASSEMBLY_BYTES}-byte cap`,
      );
    }
    const messageId = this.nextMessageId;
    this.nextMessageId = (this.nextMessageId + 1) >>> 0; // wrap as a u32 (id need not be unique forever)
    for (const fragment of fragmentMessage(message, messageId)) {
      // Backpressure BEFORE each fragment so a large pack does not overrun the SCTP buffer.
      await this.awaitDrain();
      if (this.channel.readyState !== 'open') {
        throw new TransportUnavailableError('webrtc', 'data channel closed mid-send');
      }
      this.channel.send(fragment);
    }
  }

  async receive(signal?: AbortSignal): Promise<Uint8Array | null> {
    const buffered = this.inbox.shift();
    if (buffered) {
      this.inboxBytes -= buffered.length;
      return buffered;
    }
    if (this.closed) return null;
    // An ALREADY-aborted signal must resolve immediately: `addEventListener('abort', …)` does NOT
    // fire for an abort that already happened, so parking here would hang the receive forever (the
    // exchange-round driver passes the same signal it may have aborted before this call) (PUB-WEBRTC-1).
    if (signal?.aborted) return null;
    return new Promise<Uint8Array | null>((resolve) => {
      let done = false;
      const settle = (value: Uint8Array | null): void => {
        if (done) return;
        done = true;
        // Remove the abort listener on EVERY settle path (a delivered message, a close, or the
        // abort) so listeners do not accumulate on a long-lived signal across many receives (PUB-WEBRTC-2).
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = (): void => {
        // Only this parked receive owns the resolver; clear it so onmessage/onclose do not also fire it.
        if (this.waiting === settle) this.waiting = null;
        settle(null);
      };
      this.waiting = settle;
      signal?.addEventListener('abort', onAbort);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.channel.readyState !== 'closed') this.channel.close();
  }
}
