// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The WebTransport (HTTP/3) transport (OFFLINE_SPEC §22.6, WS-R.15.5) — a lower-latency,
// loss-tolerant carrier for the SAME §16 exchange on flaky mobile links.  Uses the
// PLATFORM `WebTransport` API (no npm dependency) and MUST fall back to HTTPS when
// unsupported/blocked: it is server-mediated, but the registry orders it ahead of the
// plain HTTPS anchor, so a failure simply falls through.  The adapter runs over a
// minimal `WebTransportLike` so it is unit-testable with a fake session; the live path
// wraps a real `WebTransport`.

import type { LcapTransport, TransportCapabilities } from '@licio/lcap';
import { TransportUnavailableError } from '@licio/lcap';

export const WEBTRANSPORT_CAPABILITIES: TransportCapabilities = {
  id: 'webtransport',
  bidirectional: true,
  serverMediated: true,
  carriesPrivate: true,
  maxExchangeBytes: 64 * 1024 * 1024,
  latencyClass: 'low',
};

/** The slice of a `WebTransport` bidirectional stream the adapter needs. */
export interface BidiStreamLike {
  readonly writable: {
    getWriter(): { write(b: Uint8Array): Promise<void>; close(): Promise<void> };
  };
  readonly readable: {
    getReader(): {
      read(): Promise<{ value?: Uint8Array; done: boolean }>;
      cancel?(): Promise<void>;
    };
  };
}

/** The slice of a `WebTransport` session the adapter needs. */
export interface WebTransportLike {
  readonly ready: Promise<void>;
  createBidirectionalStream(): Promise<BidiStreamLike>;
  close(): void;
}

/** Whether the platform exposes the WebTransport API (else the registry omits it). */
export function isWebTransportSupported(): boolean {
  return typeof (globalThis as { WebTransport?: unknown }).WebTransport !== 'undefined';
}

export class WebTransportTransport implements LcapTransport {
  readonly capabilities = WEBTRANSPORT_CAPABILITIES;
  private stream: BidiStreamLike | null = null;
  /** Captured at `open` so `send` does not write after a cancelled/Stopped sync. */
  private signal: AbortSignal | undefined;

  constructor(private readonly session: WebTransportLike) {}

  async open(signal?: AbortSignal): Promise<void> {
    this.signal = signal;
    try {
      await this.session.ready;
      this.stream = await this.session.createBidirectionalStream();
    } catch (error) {
      throw new TransportUnavailableError('webtransport', String(error));
    }
  }

  async send(message: Uint8Array): Promise<void> {
    if (!this.stream) throw new TransportUnavailableError('webtransport', 'stream not open');
    if (this.signal?.aborted)
      throw new TransportUnavailableError('webtransport', 'aborted before send');
    const writer = this.stream.writable.getWriter();
    await writer.write(message);
    await writer.close();
  }

  async receive(signal?: AbortSignal): Promise<Uint8Array | null> {
    if (!this.stream) return null;
    const abort = signal ?? this.signal;
    const cap = this.capabilities.maxExchangeBytes;
    const reader = this.stream.readable.getReader();
    // Cancel the reader the moment the signal fires.  A cancelled reader resolves any
    // IN-FLIGHT `read()` with `done`, so a `receive` parked on an idle stream unblocks
    // promptly (and the exchange falls back to the HTTPS anchor) instead of hanging until
    // the server sends or closes — observing `aborted` only before the read would miss an
    // abort that arrives while the read is already pending.
    let aborted = abort?.aborted ?? false;
    const onAbort = (): void => {
      aborted = true;
      void reader.cancel?.().catch(() => {});
    };
    if (abort) {
      if (aborted) {
        void reader.cancel?.().catch(() => {});
        return null;
      }
      abort.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (aborted) return null; // an abort during the read cancelled the reader → give up
        if (value) {
          total += value.length;
          // The read loop is otherwise UNBOUNDED — enforce the declared per-exchange ceiling
          // so a misbehaving server-mediated stream cannot exhaust memory before `readPack`'s
          // caps.
          if (total > cap) {
            await reader.cancel?.().catch(() => {});
            throw new TransportUnavailableError(
              'webtransport',
              `response exceeds the ${cap}-byte cap`,
            );
          }
          chunks.push(value);
        }
        if (done) break;
      }
      if (chunks.length === 0) return null;
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    } finally {
      if (abort) abort.removeEventListener('abort', onAbort);
    }
  }

  async close(): Promise<void> {
    this.stream = null;
    this.session.close();
  }
}
