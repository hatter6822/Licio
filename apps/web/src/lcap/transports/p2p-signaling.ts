// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The client half of the server-blind WebRTC signaling rendezvous (WS-R.15.6a).  It
// POSTs sealed envelope frames to `/api/lcap/v2/p2p/signal?to=` and drains the peer's
// mailbox from `/api/lcap/v2/p2p/signal/poll?peer=`, unframing the server's
// `uvarint(count) ‖ (uvarint(len) ‖ blob)*` multiplexing (the SAME codec the server
// uses — `@licio/lcap`'s uvarint — so the two never drift).  The server only ever moves
// opaque ciphertext between two opaque peer keys (it parses no SDP/ICE, reads no IP,
// §19.1); these helpers feed `connectWebrtc`'s `postSignal`/`pollSignal` seam.

import { readUvarint } from '@licio/lcap';

const SIGNAL_PATH = '/api/lcap/v2/p2p/signal';
const POLL_PATH = '/api/lcap/v2/p2p/signal/poll';

/** Unframe a poll response (`uvarint(count) ‖ (uvarint(len) ‖ blob)*`), fail-closed. */
export function unframeSignalBlobs(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let pos = 0;
  let count: { value: number; bytesRead: number };
  try {
    count = readUvarint(bytes, pos);
  } catch {
    return out;
  }
  pos += count.bytesRead;
  for (let i = 0; i < count.value && pos < bytes.length; i++) {
    let len: { value: number; bytesRead: number };
    try {
      len = readUvarint(bytes, pos);
    } catch {
      break;
    }
    pos += len.bytesRead;
    if (len.value > bytes.length - pos) break; // declared payload overruns the buffer
    out.push(bytes.slice(pos, pos + len.value));
    pos += len.value;
  }
  return out;
}

export interface SignalClientConfig {
  /** API origin (default same-origin: ''). */
  readonly apiBase?: string;
  /** Injectable fetch (defaults to platform fetch); tests pass a fake. */
  readonly fetchFn?: typeof fetch;
}

/** Build `postSignal`/`pollSignal` bound to the rendezvous endpoints. */
export function createSignalClient(config: SignalClientConfig = {}): {
  postSignal: (toPeerKey: string, body: Uint8Array) => Promise<void>;
  pollSignal: (selfPeerKey: string) => Promise<Uint8Array[]>;
} {
  const base = config.apiBase ?? '';
  const doFetch = config.fetchFn ?? globalThis.fetch.bind(globalThis);
  return {
    postSignal: async (toPeerKey, body) => {
      const url = `${base}${SIGNAL_PATH}?to=${encodeURIComponent(toPeerKey)}`;
      await doFetch(url, {
        method: 'POST',
        body: body as BodyInit,
        headers: { 'content-type': 'application/octet-stream' },
      });
    },
    pollSignal: async (selfPeerKey) => {
      const url = `${base}${POLL_PATH}?peer=${encodeURIComponent(selfPeerKey)}`;
      const res = await doFetch(url, { method: 'POST' });
      if (!res.ok) return [];
      return unframeSignalBlobs(new Uint8Array(await res.arrayBuffer()));
    },
  };
}
