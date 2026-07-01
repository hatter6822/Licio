// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.4.3 — the private-carrier datachannel fragmenter (PRIVATE_SPEC §15.6/§15.7).  The
// SEND path splits a large sealed sync frame into ≤ 16 KiB fragments; the RECEIVE path
// reassembles the EXACT original bytes fail-closed.  These tests pin the round-trip AND the
// fail-closed reject matrix (a hostile relay that reorders / drops / over-declares fragments
// must never mis-stitch a partial message).

import { describe, expect, it } from 'vitest';
import {
  fragmentPrivateMessage,
  PRIVATE_FRAGMENT_HEADER_BYTES,
  PRIVATE_FRAGMENT_PAYLOAD_BYTES,
  PRIVATE_MAX_REASSEMBLY_BYTES,
  PrivateFragmentError,
  PrivateFragmentReassembler,
} from '../sync/fragment.js';

function roundTrip(message: Uint8Array): Uint8Array {
  const r = new PrivateFragmentReassembler();
  let out: Uint8Array | null = null;
  for (const frag of fragmentPrivateMessage(message, 7)) {
    const done = r.accept(frag);
    if (done) out = done;
  }
  if (!out) throw new Error('never completed');
  return out;
}

/** Fast byte equality (vitest's `toEqual` deep-compare is O(n) with heavy overhead on large
 *  typed arrays — a manual loop keeps a multi-fragment round-trip check well under the timeout). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe('private-carrier fragmenter (WS-S.4.3)', () => {
  it('round-trips a zero-length message as exactly one fragment', () => {
    const frags = fragmentPrivateMessage(new Uint8Array(0), 1);
    expect(frags).toHaveLength(1);
    expect(roundTrip(new Uint8Array(0))).toEqual(new Uint8Array(0));
  });

  it('round-trips a message smaller than one fragment (single fragment, transparent)', () => {
    const msg = new Uint8Array([1, 2, 3, 4, 5]);
    expect(fragmentPrivateMessage(msg, 1)).toHaveLength(1);
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('round-trips a message spanning MANY fragments byte-identically', () => {
    // 512 KiB → 32 fragments (a message the unfragmented carrier could not send at all).
    const msg = new Uint8Array(512 * 1024);
    for (let i = 0; i < msg.length; i++) msg[i] = (i * 31 + 7) & 0xff;
    const frags = fragmentPrivateMessage(msg, 42);
    expect(frags.length).toBe(Math.ceil(msg.length / PRIVATE_FRAGMENT_PAYLOAD_BYTES));
    for (const f of frags) {
      expect(f.length).toBeLessThanOrEqual(
        PRIVATE_FRAGMENT_HEADER_BYTES + PRIVATE_FRAGMENT_PAYLOAD_BYTES,
      );
    }
    expect(bytesEqual(roundTrip(msg), msg)).toBe(true);
  });

  it('interleaves two DISTINCT messages correctly (id-keyed, one at a time)', () => {
    const r = new PrivateFragmentReassembler();
    const a = new Uint8Array(PRIVATE_FRAGMENT_PAYLOAD_BYTES * 2 + 10).fill(0xaa);
    const b = new Uint8Array(50).fill(0xbb);
    let outA: Uint8Array | null = null;
    for (const f of fragmentPrivateMessage(a, 1)) outA = r.accept(f) ?? outA;
    let outB: Uint8Array | null = null;
    for (const f of fragmentPrivateMessage(b, 2)) outB = r.accept(f) ?? outB;
    expect(outA).toEqual(a);
    expect(outB).toEqual(b);
  });

  it('refuses to fragment a message beyond the reassembly cap', () => {
    const tooBig = new Uint8Array(PRIVATE_MAX_REASSEMBLY_BYTES + 1);
    expect(() => fragmentPrivateMessage(tooBig, 1)).toThrow(PrivateFragmentError);
  });

  it('fails closed on a truncated header', () => {
    const r = new PrivateFragmentReassembler();
    expect(() => r.accept(new Uint8Array(3))).toThrow(PrivateFragmentError);
  });

  it('fails closed on an unsupported version', () => {
    const [frag] = fragmentPrivateMessage(new Uint8Array([9]), 1);
    const bad = (frag as Uint8Array).slice();
    bad[0] = 0xff; // corrupt the version byte
    expect(() => new PrivateFragmentReassembler().accept(bad)).toThrow(/version/);
  });

  it('fails closed when the first fragment is not seq 0', () => {
    const frags = fragmentPrivateMessage(new Uint8Array(PRIVATE_FRAGMENT_PAYLOAD_BYTES * 2), 1);
    expect(() => new PrivateFragmentReassembler().accept(frags[1] as Uint8Array)).toThrow(/seq/);
  });

  it('fails closed on an out-of-order continuation fragment', () => {
    const frags = fragmentPrivateMessage(new Uint8Array(PRIVATE_FRAGMENT_PAYLOAD_BYTES * 3), 1);
    const r = new PrivateFragmentReassembler();
    r.accept(frags[0] as Uint8Array); // seq 0
    expect(() => r.accept(frags[2] as Uint8Array)).toThrow(/out-of-order/); // skips seq 1
  });

  it('fails closed on a continuation fragment for a DIFFERENT message', () => {
    const a = fragmentPrivateMessage(new Uint8Array(PRIVATE_FRAGMENT_PAYLOAD_BYTES * 2), 1);
    const b = fragmentPrivateMessage(new Uint8Array(PRIVATE_FRAGMENT_PAYLOAD_BYTES * 2), 2);
    const r = new PrivateFragmentReassembler();
    r.accept(a[0] as Uint8Array);
    expect(() => r.accept(b[1] as Uint8Array)).toThrow(/in-flight message/);
  });

  it('fails closed when fragment_total disagrees with message_total_len', () => {
    const [frag] = fragmentPrivateMessage(new Uint8Array(10), 1);
    const bad = (frag as Uint8Array).slice();
    const view = new DataView(bad.buffer);
    view.setUint32(1 + 4 + 4, 5, false); // overwrite fragment_total (offset: version + msgId + seq)
    expect(() => new PrivateFragmentReassembler().accept(bad)).toThrow(/disagrees/);
  });
});
