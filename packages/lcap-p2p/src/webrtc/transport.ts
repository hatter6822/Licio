// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The WebRTC `RTCDataChannel` LcapTransport (OFFLINE_SPEC §22.6, WS-R.15.6a).  Carries
// the §16 exchange between two browsers over a data channel; received frames go through
// the SAME reader/validator as every other transport (source-independence).  The
// adapter is written over a minimal `DataChannelLike` so it is unit-testable with a
// fake channel; live establishment (`connectWebrtc`) wires a real RTCPeerConnection via
// the server-blind signaling rendezvous + STUN and is exercised by the gated E2E.
//
// A peer transport is public-only (`carriesPrivate: false`): the seam's
// `transportMayCarry` gate keeps in_room/private packs off it (§21.4/§26.4).

import type { LcapTransport, TransportCapabilities } from '@licio/lcap';
import { TransportUnavailableError } from '@licio/lcap';

/** The slice of `RTCDataChannel` the transport needs (so a fake can stand in). */
export interface DataChannelLike {
  readyState: 'connecting' | 'open' | 'closing' | 'closed';
  binaryType?: string;
  send(data: Uint8Array): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror?: ((event: unknown) => void) | null;
}

export const WEBRTC_CAPABILITIES: TransportCapabilities = {
  id: 'webrtc',
  bidirectional: true,
  serverMediated: false,
  carriesPrivate: false, // public-only over P2P unless WS-S encryption + permission (R.11.5)
  maxExchangeBytes: 16 * 1024 * 1024,
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
  private readonly inbox: Uint8Array[] = [];
  private waiting: ((value: Uint8Array | null) => void) | null = null;
  private closed = false;

  constructor(private readonly channel: DataChannelLike) {
    channel.binaryType = 'arraybuffer';
    channel.onmessage = (event) => {
      const bytes = toBytes(event.data);
      if (!bytes) return;
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = null;
        resolve(bytes);
      } else {
        this.inbox.push(bytes);
      }
    };
    channel.onclose = () => {
      this.closed = true;
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = null;
        resolve(null);
      }
    };
  }

  async open(): Promise<void> {
    if (this.channel.readyState !== 'open') {
      throw new TransportUnavailableError('webrtc', 'data channel is not open');
    }
  }

  async send(message: Uint8Array): Promise<void> {
    if (this.channel.readyState !== 'open') {
      throw new TransportUnavailableError('webrtc', 'data channel closed before send');
    }
    this.channel.send(message);
  }

  async receive(signal?: AbortSignal): Promise<Uint8Array | null> {
    const buffered = this.inbox.shift();
    if (buffered) return buffered;
    if (this.closed) return null;
    return new Promise<Uint8Array | null>((resolve) => {
      this.waiting = resolve;
      signal?.addEventListener('abort', () => {
        if (this.waiting === resolve) {
          this.waiting = null;
          resolve(null);
        }
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.channel.readyState !== 'closed') this.channel.close();
  }
}
