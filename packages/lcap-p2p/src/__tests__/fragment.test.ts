// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.6 — datachannel message fragmentation.  An LCAP exchange pack larger than the
// 16 KiB cross-browser SCTP-safe message size is split into ordered fragments and
// reassembled BYTE-IDENTICALLY by the receiver; a malformed / out-of-order / conflicting
// / over-cap fragment aborts the reassembly fail-closed (a §27 DoS bound).

import { describe, expect, it } from 'vitest';
import {
  FRAGMENT_HEADER_BYTES,
  FRAGMENT_PAYLOAD_BYTES,
  FragmentError,
  FragmentReassembler,
  fragmentMessage,
  MAX_REASSEMBLY_BYTES,
} from '../index.js';

function deterministicBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

describe('WS-R.15.6 fragmentation', () => {
  it('emits exactly one fragment for a small (sub-cap) message', () => {
    const msg = new Uint8Array([1, 2, 3, 4, 5]);
    const frags = fragmentMessage(msg, 0);
    expect(frags.length).toBe(1);
    expect(frags[0]?.length).toBe(FRAGMENT_HEADER_BYTES + 5);
  });

  it('emits exactly one fragment for a zero-length message (complete-message signal)', () => {
    const frags = fragmentMessage(new Uint8Array(0), 0);
    expect(frags.length).toBe(1);
    const r = new FragmentReassembler();
    expect(r.accept(frags[0] as Uint8Array)).toEqual(new Uint8Array(0));
  });

  it('round-trips a LARGE multi-fragment message byte-identically', () => {
    const size = FRAGMENT_PAYLOAD_BYTES * 3 + 123; // > 16 KiB, several fragments + a tail
    const msg = deterministicBytes(size);
    const frags = fragmentMessage(msg, 42);
    expect(frags.length).toBe(4);
    // Every fragment but possibly the last is a full header + full payload.
    for (let i = 0; i < frags.length - 1; i++) {
      expect(frags[i]?.length).toBe(FRAGMENT_HEADER_BYTES + FRAGMENT_PAYLOAD_BYTES);
    }
    const r = new FragmentReassembler();
    let assembled: Uint8Array | null = null;
    for (const f of frags) {
      const out = r.accept(f);
      if (out) assembled = out;
    }
    expect(assembled).not.toBeNull();
    expect(assembled).toEqual(msg);
  });

  it('reassembles a message exactly at a fragment boundary', () => {
    const msg = deterministicBytes(FRAGMENT_PAYLOAD_BYTES * 2); // no tail fragment
    const frags = fragmentMessage(msg, 1);
    expect(frags.length).toBe(2);
    const r = new FragmentReassembler();
    expect(r.accept(frags[0] as Uint8Array)).toBeNull();
    expect(r.accept(frags[1] as Uint8Array)).toEqual(msg);
  });

  it('reassembles consecutive messages on the same reassembler', () => {
    const r = new FragmentReassembler();
    const a = deterministicBytes(FRAGMENT_PAYLOAD_BYTES + 10);
    const b = deterministicBytes(50);
    for (const f of fragmentMessage(a, 0)) {
      const out = r.accept(f);
      if (out) expect(out).toEqual(a);
    }
    for (const f of fragmentMessage(b, 1)) {
      const out = r.accept(f);
      if (out) expect(out).toEqual(b);
    }
  });

  it('rejects an outbound message over the absolute cap', () => {
    expect(() => fragmentMessage(new Uint8Array(MAX_REASSEMBLY_BYTES + 1), 0)).toThrow(
      FragmentError,
    );
  });

  it('fails closed on a truncated header', () => {
    const r = new FragmentReassembler();
    expect(() => r.accept(new Uint8Array(FRAGMENT_HEADER_BYTES - 1))).toThrow(FragmentError);
  });

  it('fails closed on an unsupported version byte', () => {
    const frag = fragmentMessage(new Uint8Array([1]), 0)[0] as Uint8Array;
    const tampered = frag.slice();
    tampered[0] = 9; // bad version
    const r = new FragmentReassembler();
    expect(() => r.accept(tampered)).toThrow(/version/);
  });

  it('fails closed on an out-of-order fragment (a missing/dropped middle fragment)', () => {
    const msg = deterministicBytes(FRAGMENT_PAYLOAD_BYTES * 3);
    const frags = fragmentMessage(msg, 7);
    const r = new FragmentReassembler();
    expect(r.accept(frags[0] as Uint8Array)).toBeNull();
    // Skip seq 1, feed seq 2 → out of order.
    expect(() => r.accept(frags[2] as Uint8Array)).toThrow(/out-of-order/);
  });

  it('fails closed when a continuation fragment belongs to a different message', () => {
    const a = fragmentMessage(deterministicBytes(FRAGMENT_PAYLOAD_BYTES * 2), 1);
    const b = fragmentMessage(deterministicBytes(FRAGMENT_PAYLOAD_BYTES * 2), 2);
    const r = new FragmentReassembler();
    expect(r.accept(a[0] as Uint8Array)).toBeNull();
    // A fragment from message 2 (different messageId) cannot continue message 1.
    expect(() => r.accept(b[1] as Uint8Array)).toThrow(/in-flight message/);
  });

  it('fails closed when a declared total exceeds the cap', () => {
    // Hand-craft a header claiming an impossible fragment_total.
    const frame = new Uint8Array(FRAGMENT_HEADER_BYTES + 1);
    const view = new DataView(frame.buffer);
    frame[0] = 1; // version
    view.setUint32(1, 0, false); // messageId
    view.setUint32(5, 0, false); // seq
    view.setUint32(9, 0xffffffff, false); // fragment_total — absurd
    view.setUint32(13, 1, false); // messageLen
    const r = new FragmentReassembler();
    expect(() => r.accept(frame)).toThrow(/fragment_total/);
  });

  it('fails closed when the declared message length exceeds the reassembly cap', () => {
    const frame = new Uint8Array(FRAGMENT_HEADER_BYTES + 1);
    const view = new DataView(frame.buffer);
    frame[0] = 1;
    view.setUint32(1, 0, false);
    view.setUint32(5, 0, false);
    view.setUint32(9, 1, false);
    view.setUint32(13, MAX_REASSEMBLY_BYTES + 1, false); // message_total_len over cap
    const r = new FragmentReassembler();
    expect(() => r.accept(frame)).toThrow(/reassembly cap/);
  });

  it('fails closed when the reassembled length disagrees with the declared length', () => {
    // Build a valid 2-fragment message, then truncate the last fragment's payload so the
    // reassembled total is short of the declared message_total_len.
    const msg = deterministicBytes(FRAGMENT_PAYLOAD_BYTES + 100);
    const frags = fragmentMessage(msg, 0);
    const last = frags[1] as Uint8Array;
    const truncated = last.subarray(0, last.length - 10); // drop 10 payload bytes
    const r = new FragmentReassembler();
    expect(r.accept(frags[0] as Uint8Array)).toBeNull();
    expect(() => r.accept(truncated)).toThrow(/!=|exceed/);
  });

  it('fails closed when a fragment payload exceeds the per-fragment cap', () => {
    const frame = new Uint8Array(FRAGMENT_HEADER_BYTES + FRAGMENT_PAYLOAD_BYTES + 1);
    const view = new DataView(frame.buffer);
    frame[0] = 1;
    view.setUint32(1, 0, false);
    view.setUint32(5, 0, false);
    view.setUint32(9, 1, false);
    view.setUint32(13, FRAGMENT_PAYLOAD_BYTES + 1, false);
    const r = new FragmentReassembler();
    expect(() => r.accept(frame)).toThrow(/per-fragment cap/);
  });
});
