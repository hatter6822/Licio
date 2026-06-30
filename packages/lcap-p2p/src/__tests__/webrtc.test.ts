// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.6 — the WebRTC plane: the server-blind signaling envelope seals SDP under a
// member key with an AAD bound to (room, from, to) — so a captured blob cannot be
// replayed into another room/peer and the server sees only opaque ciphertext; the ICE
// policy is off by default, forced off in Stealth/Emergency, refuses relay-only without
// TURN, and discloses IP exposure for a direct connection; the data-channel transport
// moves bytes, buffers, and is public-only.

import { describe, expect, it, vi } from 'vitest';
import {
  type DataChannelLike,
  decideWebrtc,
  FRAGMENT_HEADER_BYTES,
  fragmentMessage,
  importSignalKey,
  MAX_REASSEMBLY_BYTES,
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

/** A fake channel that exposes the SCTP buffer surface so backpressure can be exercised. */
class BufferingChannel implements DataChannelLike {
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'open';
  binaryType = 'blob';
  bufferedAmount = 16 * 1024 * 1024; // start ABOVE the 8 MiB high-water mark
  bufferedAmountLowThreshold = 0;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;
  readonly sent: Uint8Array[] = [];
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 'closed';
  }
  /** Model the SCTP buffer emptying: drop to zero + fire the low-water event. */
  drain(): void {
    this.bufferedAmount = 0;
    this.onbufferedamountlow?.();
  }
  /** Fire the low-water event WITHOUT draining (a spurious wake / still-full buffer). */
  spuriousWake(): void {
    this.onbufferedamountlow?.();
  }
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

  it('DISCARDS the buffered inbox on an over-cap flood teardown — no leak to the exchange (PUB-WEBRTC-4)', async () => {
    const ch = fakeChannel();
    const t = new WebrtcTransport(ch);
    // Two COMPLETE messages whose combined size exceeds the inbox byte cap, delivered before any
    // receive() drains them: the second push trips `inboxBytes > MAX_REASSEMBLY_BYTES` and aborts.
    // Each is ≤ the per-message cap, so both reassemble; together they overflow the un-consumed queue.
    const size = Math.floor(MAX_REASSEMBLY_BYTES * 0.6);
    ch.deliver(new Uint8Array(size)); // buffered (inbox ≈ 0.6× cap)
    ch.deliver(new Uint8Array(size)); // inbox ≈ 1.2× cap > cap ⇒ fail-closed abort clears the inbox
    // The teardown DISCARDED the queued (untrusted) messages: receive() must hand NOTHING to the
    // exchange — without the inbox clear it would shift the first 0.6×-cap message and return it.
    expect(await t.receive()).toBeNull();
  });

  it('resolves receive() with null immediately for an ALREADY-aborted signal (PUB-WEBRTC-1)', async () => {
    const t = new WebrtcTransport(fakeChannel());
    const ac = new AbortController();
    ac.abort(); // aborted BEFORE receive(): an `abort` listener would never fire, so parking hangs
    expect(await t.receive(ac.signal)).toBeNull();
  });

  it('aborts a parked receive via the signal, then resolves null', async () => {
    const t = new WebrtcTransport(fakeChannel());
    const ac = new AbortController();
    const pending = t.receive(ac.signal);
    ac.abort();
    expect(await pending).toBeNull();
  });

  it('removes the abort listener when a message resolves the receive (no leak, PUB-WEBRTC-2)', async () => {
    const ch = fakeChannel();
    const t = new WebrtcTransport(ch);
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');
    const pending = t.receive(ac.signal);
    ch.deliver(new Uint8Array([9]));
    expect(await pending).toEqual(new Uint8Array([9]));
    // The abort listener was cleaned up on the message path — it does not accumulate across receives.
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
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

  it('applies SCTP backpressure: a send parks until the buffer drains', async () => {
    const ch = new BufferingChannel();
    const t = new WebrtcTransport(ch);
    let resolved = false;
    const p = t.send(new Uint8Array([1, 2, 3])).then(() => {
      resolved = true;
    });
    // bufferedAmount is over the high-water mark ⇒ the send is parked (no fragment written).
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);
    expect(ch.sent.length).toBe(0);
    ch.drain(); // SCTP drains → onbufferedamountlow wakes the parked send
    await p;
    expect(resolved).toBe(true);
    expect(ch.sent.length).toBe(1);
  });

  it('does NOT resume sending on a spurious wake while the buffer is still full', async () => {
    // A drain event can fire (or the safety timeout elapse) while `bufferedAmount` is STILL over
    // the high-water mark; the send must re-check and stay parked rather than resume and risk
    // overrunning the SCTP buffer.
    const ch = new BufferingChannel();
    const t = new WebrtcTransport(ch);
    let resolved = false;
    const p = t.send(new Uint8Array([1, 2, 3])).then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    ch.spuriousWake(); // low-water event, but bufferedAmount is unchanged (still full)
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false); // re-checked → still parked, no fragment written
    expect(ch.sent.length).toBe(0);
    ch.drain(); // now it actually drains
    await p;
    expect(resolved).toBe(true);
    expect(ch.sent.length).toBe(1);
  });

  it('a parked send unblocks and refuses when the channel closes mid-backpressure', async () => {
    const ch = new BufferingChannel();
    const t = new WebrtcTransport(ch);
    const p = t.send(new Uint8Array([1, 2, 3]));
    await new Promise((r) => setTimeout(r, 5));
    ch.readyState = 'closed';
    ch.onclose?.(); // close wakes the parked send, which then observes the closed channel
    await expect(p).rejects.toThrow(/closed mid-send/);
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
