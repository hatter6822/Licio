// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 — the cap-secret IndexedDB store (the v4 `cap_secrets` store): the device-local
// nid + issuer seed persist in the private-p2p DB (the same trust boundary as the room epoch
// keys), keyed per (roomId, field), isolated across rooms.

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { IndexedDbPrivateRoomStorage, PRIVATE_P2P_DB_NAME } from '../storage.js';

afterEach(() => {
  indexedDB.deleteDatabase(PRIVATE_P2P_DB_NAME);
});

/** Compare as plain arrays — fake-indexeddb structured-clones bytes across realms, so a
 *  retrieved Uint8Array is value-equal but not `toEqual`-equal to the source. */
const arr = (b: Uint8Array | undefined): number[] | undefined => (b ? [...b] : undefined);

describe('IndexedDbPrivateRoomStorage — Tier-2 cap secrets (v4 store)', () => {
  it('round-trips a secret and returns undefined for an unset field', async () => {
    const store = new IndexedDbPrivateRoomStorage('room-a');
    expect(await store.getCapSecret('nid')).toBeUndefined();

    const nid = new Uint8Array(32).fill(9);
    await store.putCapSecret('nid', nid);
    expect(arr(await store.getCapSecret('nid'))).toEqual([...nid]);

    // a second field is independent
    const seed = new Uint8Array(32).fill(3);
    await store.putCapSecret('issuer-seed', seed);
    expect(arr(await store.getCapSecret('issuer-seed'))).toEqual([...seed]);
    expect(arr(await store.getCapSecret('nid'))).toEqual([...nid]);
  });

  it('is idempotent on (roomId, field) — a re-put overwrites', async () => {
    const store = new IndexedDbPrivateRoomStorage('room-b');
    await store.putCapSecret('nid', new Uint8Array([1, 2, 3]));
    await store.putCapSecret('nid', new Uint8Array([4, 5, 6]));
    expect(arr(await store.getCapSecret('nid'))).toEqual([4, 5, 6]);
  });

  it('isolates secrets across rooms', async () => {
    const a = new IndexedDbPrivateRoomStorage('room-1');
    const b = new IndexedDbPrivateRoomStorage('room-2');
    await a.putCapSecret('nid', new Uint8Array([7]));
    expect(await b.getCapSecret('nid')).toBeUndefined();
    await b.putCapSecret('nid', new Uint8Array([8]));
    expect(arr(await a.getCapSecret('nid'))).toEqual([7]);
    expect(arr(await b.getCapSecret('nid'))).toEqual([8]);
  });
});
