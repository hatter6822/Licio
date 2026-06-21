// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The privacy-scoped `room_id_hash` derivation (OFFLINE_SPEC §16.2, §23.1) that
// keys sync frontiers.  It MUST be deterministic (both peers derive the same hash
// for a room) and injective across distinct (network, room) pairs (no frontier
// cross-talk between rooms or networks).

import { describe, expect, it } from 'vitest';
import { roomIdHash } from '../sync/index.js';

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe('roomIdHash (§16.2, §23.1)', () => {
  it('produces a 32-byte SHA-256 digest', async () => {
    const h = await roomIdHash('net-1', 'room-1');
    expect(h).toBeInstanceOf(Uint8Array);
    expect(h).toHaveLength(32);
  });

  it('is deterministic for the same (network, room) pair', async () => {
    const a = await roomIdHash('net-1', 'room-1');
    const b = await roomIdHash('net-1', 'room-1');
    expect(hex(a)).toBe(hex(b));
  });

  it('separates distinct rooms within a network', async () => {
    const a = await roomIdHash('net-1', 'room-1');
    const b = await roomIdHash('net-1', 'room-2');
    expect(hex(a)).not.toBe(hex(b));
  });

  it('separates the same room id across distinct networks', async () => {
    const a = await roomIdHash('net-1', 'room-1');
    const b = await roomIdHash('net-2', 'room-1');
    expect(hex(a)).not.toBe(hex(b));
  });

  it('is unambiguous across the network/room boundary (no concatenation collision)', async () => {
    // Without length-unambiguous encoding, ("ab","c") and ("a","bc") could collide.
    const a = await roomIdHash('ab', 'c');
    const b = await roomIdHash('a', 'bc');
    expect(hex(a)).not.toBe(hex(b));
  });
});
