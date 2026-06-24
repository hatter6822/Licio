// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.6 — the WebRTC plane: the server-blind signaling envelope seals SDP under a
// member key with an AAD bound to (room, from, to) — so a captured blob cannot be
// replayed into another room/peer and the server sees only opaque ciphertext; the ICE
// policy is off by default, forced off in Stealth/Emergency, refuses relay-only without
// TURN, and discloses IP exposure for a direct connection; the data-channel transport
// moves bytes, buffers, and is public-only.

import { describe, expect, it } from 'vitest';
import {
  type DataChannelLike,
  decideWebrtc,
  FRAGMENT_HEADER_BYTES,
  fragmentMessage,
  importSignalKey,
  openSignal,
  sealSignal,
  signalEnvelopeV2Schema,
  WebrtcTransport,
} from '../index.js';

async function memberKey(byte = 7): Promise<CryptoKey> {
  return importSignalKey(new Uint8Array(32).fill(byte));
}

describe('server-blind signaling envelope (§19.1/§26.4)', () => {
  it('round-trips an SDP under the shared key and exposes only opaque fields', async () => {
    const key = await memberKey();
    const sdp = new TextEncoder().encode('v=0\r\no=- 42 2 IN IP4 0.0.0.0\r\n');
    const env = await sealSignal({
      roomIdHash: new Uint8Array([1, 2, 3]),
      from: 'peerA',
      to: 'peerB',
      payload: sdp,
      key,
    });
    // The envelope the server forwards has NO SDP/ICE/IP — only opaque routing + bytes.
    expect(Object.keys(env).sort()).toEqual([
      'ciphertext',
      'from',
      'nonce',
      'room_id_hash',
      'to',
      'v',
    ]);
    expect(signalEnvelopeV2Schema.parse(env)).toEqual(env);
    expect(await openSignal(env, key)).toEqual(sdp);
  });

  it('binds the seal to (room, from, to): tampering the route fails decryption', async () => {
    const key = await memberKey();
    const env = await sealSignal({
      roomIdHash: new Uint8Array([1, 2, 3]),
      from: 'peerA',
      to: 'peerB',
      payload: new TextEncoder().encode('offer'),
      key,
    });
    const tampered = { ...env, room_id_hash: new Uint8Array([9, 9, 9]) };
    await expect(openSignal(tampered, key)).rejects.toBeDefined();
    const wrongKey = await memberKey(8);
    await expect(openSignal(env, wrongKey)).rejects.toBeDefined();
  });
});

describe('ICE / NAT-privacy policy (§26.4/§33.5)', () => {
  it('is off by default and forced off in Stealth/Emergency', () => {
    expect(decideWebrtc({ mode: 'standard', userEnabled: false }).blockedReason).toBe(
      'off_by_default',
    );
    expect(decideWebrtc({ mode: 'stealth', userEnabled: true }).blockedReason).toBe(
      'forced_off_in_mode',
    );
    expect(decideWebrtc({ mode: 'emergency', userEnabled: true }).blockedReason).toBe(
      'forced_off_in_mode',
    );
  });

  it('refuses relay-only without TURN rather than leaking the IP', () => {
    const d = decideWebrtc({ mode: 'standard', userEnabled: true, relayOnlyIce: true });
    expect(d.allowed).toBe(false);
    expect(d.blockedReason).toBe('relay_without_turn');
  });

  it('relay-only hides the IP via TURN; a direct connection discloses IP exposure', () => {
    const relay = decideWebrtc({
      mode: 'standard',
      userEnabled: true,
      relayOnlyIce: true,
      turnServers: [{ urls: 'turn:turn.example', username: 'u', credential: 'c' }],
    });
    expect(relay.allowed).toBe(true);
    expect(relay.iceTransportPolicy).toBe('relay');
    expect(relay.exposesPeerIp).toBe(false);

    const direct = decideWebrtc({ mode: 'standard', userEnabled: true });
    expect(direct.allowed).toBe(true);
    expect(direct.iceTransportPolicy).toBe('all');
    expect(direct.exposesPeerIp).toBe(true); // the UI must disclose this before connecting
  });
});

/**
 * A minimal in-memory data channel for the transport test.  `deliver` FRAGMENTS a whole
 * message (the wire contract is fragmented since WS-R.15.6), feeding each fragment to
 * `onmessage`; `deliverFragments` injects pre-built fragment frames (e.g. an ArrayBuffer-
 * shaped one) for the coercion test.
 */
function fakeChannel(): DataChannelLike & {
  deliver(bytes: Uint8Array): void;
  deliverFragments(frames: Uint8Array[]): void;
  fireClose(): void;
} {
  let nextId = 0;
  const ch: DataChannelLike & {
    deliver(b: Uint8Array): void;
    deliverFragments(frames: Uint8Array[]): void;
    fireClose(): void;
  } = {
    readyState: 'open',
    send() {},
    close() {
      ch.readyState = 'closed';
    },
    onmessage: null,
    onclose: null,
    deliver(bytes) {
      for (const frame of fragmentMessage(bytes, nextId++)) ch.onmessage?.({ data: frame });
    },
    deliverFragments(frames) {
      for (const frame of frames) ch.onmessage?.({ data: frame });
    },
    fireClose() {
      ch.readyState = 'closed';
      ch.onclose?.();
    },
  };
  return ch;
}

describe('WebRTC data-channel transport (§22.6)', () => {
  it('is a public-only peer transport', () => {
    const t = new WebrtcTransport(fakeChannel());
    expect(t.capabilities.id).toBe('webrtc');
    expect(t.capabilities.serverMediated).toBe(false);
    expect(t.capabilities.carriesPrivate).toBe(false);
  });

  it('receives a buffered message and then resolves a pending receive', async () => {
    const ch = fakeChannel();
    const t = new WebrtcTransport(ch);
    ch.deliver(new Uint8Array([1, 2])); // arrives before receive() → buffered
    expect(await t.receive()).toEqual(new Uint8Array([1, 2]));
    const pending = t.receive(); // now nothing buffered → waits
    ch.deliver(new Uint8Array([3, 4]));
    expect(await pending).toEqual(new Uint8Array([3, 4]));
  });

  it('resolves a pending receive with null when the channel closes', async () => {
    const ch = fakeChannel();
    const t = new WebrtcTransport(ch);
    const pending = t.receive();
    ch.fireClose();
    expect(await pending).toBeNull();
  });

  it('coerces an ArrayBuffer-shaped fragment frame and ignores non-coercible junk', async () => {
    const ch = fakeChannel();
    const t = new WebrtcTransport(ch);
    // The real RTCDataChannel (binaryType='arraybuffer') delivers fragments as ArrayBuffers.
    const frame = fragmentMessage(new Uint8Array([5, 6, 7]), 0)[0] as Uint8Array;
    ch.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.length) });
    expect(await t.receive()).toEqual(new Uint8Array([5, 6, 7]));
    // A non-coercible payload (a number) is dropped, not fed to the reassembler.
    ch.onmessage?.({ data: 42 });
    const pending = t.receive();
    ch.deliver(new Uint8Array([8]));
    expect(await pending).toEqual(new Uint8Array([8]));
  });

  it('open() resolves when the channel is open and throws once it is not', async () => {
    const ch = fakeChannel();
    const t = new WebrtcTransport(ch);
    await expect(t.open()).resolves.toBeUndefined();
    ch.readyState = 'closed';
    await expect(t.open()).rejects.toThrow(/not open/);
  });

  it('send() writes a framed fragment to an open channel and refuses once it has closed', async () => {
    const sent: Uint8Array[] = [];
    const ch = fakeChannel();
    ch.send = (b) => sent.push(b);
    const t = new WebrtcTransport(ch);
    await t.send(new Uint8Array([1, 2, 3]));
    // A small message is one fragment: a 17-byte header + the 3-byte payload tail.
    expect(sent.length).toBe(1);
    expect(sent[0]?.length).toBe(FRAGMENT_HEADER_BYTES + 3);
    expect(sent[0]?.subarray(FRAGMENT_HEADER_BYTES)).toEqual(new Uint8Array([1, 2, 3]));
    ch.readyState = 'closing';
    await expect(t.send(new Uint8Array([4]))).rejects.toThrow(/closed before send/);
  });

  it('receive() honours an abort signal by resolving null and clearing the waiter', async () => {
    const ch = fakeChannel();
    const t = new WebrtcTransport(ch);
    const controller = new AbortController();
    const pending = t.receive(controller.signal);
    controller.abort();
    expect(await pending).toBeNull();
    // A later delivery does not erroneously resolve the already-aborted receive.
    ch.deliver(new Uint8Array([9]));
    expect(await t.receive()).toEqual(new Uint8Array([9]));
  });

  it('close() marks the transport closed and closes a still-open channel', async () => {
    let closedCalls = 0;
    const ch = fakeChannel();
    const realClose = ch.close;
    ch.close = () => {
      closedCalls += 1;
      realClose();
    };
    const t = new WebrtcTransport(ch);
    await t.close();
    expect(closedCalls).toBe(1);
    expect(ch.readyState).toBe('closed');
    // Idempotent: a second close does not call channel.close again (already closed).
    await t.close();
    expect(closedCalls).toBe(1);
    // A subsequent receive returns null (closed).
    expect(await t.receive()).toBeNull();
  });
});
