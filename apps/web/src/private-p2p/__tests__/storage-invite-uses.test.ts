// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S — the v5 `invite_uses` store (the §10.3 max_uses acceptance counter) plus
// the `deleteAllForRoom()` purge that `leave()` runs so forgetting a room orphans
// no envelopes / media blocks / cap secrets / invite counters.

import 'fake-indexeddb/auto';
import type { PrivateEncryptedEnvelope } from '@licio/private-p2p';
import { afterEach, describe, expect, it } from 'vitest';
import { IndexedDbPrivateRoomStorage, PRIVATE_P2P_DB_NAME } from '../storage.js';

afterEach(() => {
  indexedDB.deleteDatabase(PRIVATE_P2P_DB_NAME);
});

// The storage adapter treats the envelope opaquely, so a placeholder suffices.
const envelope = { ciphertext: new Uint8Array([1, 2, 3]) } as unknown as PrivateEncryptedEnvelope;

describe('IndexedDbPrivateRoomStorage — invite-use counter (v5 store)', () => {
  it('starts at 0, increments monotonically, and returns the new total', async () => {
    const store = new IndexedDbPrivateRoomStorage('room-a');
    expect(await store.getInviteUses('invite-1')).toBe(0);
    expect(await store.incrementInviteUses('invite-1')).toBe(1);
    expect(await store.incrementInviteUses('invite-1')).toBe(2);
    expect(await store.getInviteUses('invite-1')).toBe(2);
  });

  it('counts each invite independently, and isolates across rooms', async () => {
    const a = new IndexedDbPrivateRoomStorage('room-1');
    const b = new IndexedDbPrivateRoomStorage('room-2');
    await a.incrementInviteUses('invite-x');
    // A different invite in the same room is untouched…
    expect(await a.getInviteUses('invite-y')).toBe(0);
    // …and the same invite id in a different room is a separate counter.
    expect(await b.getInviteUses('invite-x')).toBe(0);
  });
});

describe('IndexedDbPrivateRoomStorage — deleteAllForRoom() purge', () => {
  it('removes every store row for the room and leaves other rooms intact', async () => {
    const target = new IndexedDbPrivateRoomStorage('doomed');
    const other = new IndexedDbPrivateRoomStorage('keep');

    // Seed all four content stores for both rooms.
    await target.putEnvelope('op-1', envelope);
    await target.putBlock('cid-1', new Uint8Array([9]));
    await target.putCapSecret('nid', new Uint8Array([1]));
    await target.incrementInviteUses('invite-1');
    await other.putEnvelope('op-2', envelope);
    await other.putBlock('cid-2', new Uint8Array([8]));
    await other.putCapSecret('nid', new Uint8Array([2]));
    await other.incrementInviteUses('invite-2');

    await target.deleteAllForRoom();

    // The doomed room is fully purged across every store…
    expect(await target.listEnvelopes()).toHaveLength(0);
    expect(await target.getBlock('cid-1')).toBeUndefined();
    expect(await target.getCapSecret('nid')).toBeUndefined();
    expect(await target.getInviteUses('invite-1')).toBe(0);

    // …and the other room is completely untouched.
    expect(await other.listEnvelopes()).toHaveLength(1);
    expect(await other.getBlock('cid-2')).toBeDefined();
    expect(await other.getCapSecret('nid')).toBeDefined();
    expect(await other.getInviteUses('invite-2')).toBe(1);
  });
});
