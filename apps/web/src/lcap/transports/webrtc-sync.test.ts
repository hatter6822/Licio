// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.10 — the BIDIRECTIONAL WebRTC §16 driver moves content over one duplex channel: peer A
// (which wants a quarantined dep) and peer B (which holds it) each run the driver; A's request is
// SERVED by B's responder half and A INGESTS the served block.  A fake in-memory duplex channel
// pair + two isolated fake-indexeddb stores stand in for the live data channel + the two devices.

import 'fake-indexeddb/auto';
import { cidFor } from '@licio/lcap';
import type { DataChannelLike } from '@licio/lcap-p2p';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LCAP_DB_VERSION, LCAP_MIGRATIONS, LCAP_STORE, openLcapDb } from '../db.js';
import { putBlock, readBlockBytes } from '../store.js';
import { runWebrtcBidirectionalExchange } from './webrtc-sync.js';

/** A fake duplex data channel: `send` delivers (a copy of) the bytes to the peer's `onmessage`. */
class FakeDuplex implements DataChannelLike {
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'open';
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  peer: FakeDuplex | null = null;
  send(data: Uint8Array): void {
    const peer = this.peer;
    if (peer?.readyState !== 'open') return;
    const copy = data.slice();
    queueMicrotask(() => peer.onmessage?.({ data: copy.buffer }));
  }
  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    queueMicrotask(() => this.onclose?.());
  }
}

let peerA: IDBDatabase;
let peerB: IDBDatabase;

beforeEach(async () => {
  const s = Math.random().toString(36).slice(2);
  peerA = await openLcapDb(`lcap_v2-rtc-A-${s}`, LCAP_DB_VERSION, LCAP_MIGRATIONS);
  peerB = await openLcapDb(`lcap_v2-rtc-B-${s}`, LCAP_DB_VERSION, LCAP_MIGRATIONS);
});
afterEach(() => {
  peerA.close();
  peerB.close();
});

async function quarantineMissing(db: IDBDatabase, missing: string[]): Promise<void> {
  const tx = db.transaction(LCAP_STORE.quarantine, 'readwrite');
  tx.objectStore(LCAP_STORE.quarantine).put({
    cid: 'parent',
    reason: 'missing_dependency',
    firstSeen: 1,
    missingDeps: missing,
    byteSize: 0,
  });
  await new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

describe('runWebrtcBidirectionalExchange', () => {
  it('moves content bidirectionally: A wants a block, B serves it, A ingests + holds it', async () => {
    const bytes = new Uint8Array([5, 6, 7, 8, 9, 10]);
    const blockCid = await cidFor('block', bytes);
    await putBlock(peerB, { blockCid, state: 'integrity_verified', size: bytes.length }, [bytes]);
    await quarantineMissing(peerA, [blockCid]);

    const a = new FakeDuplex();
    const b = new FakeDuplex();
    a.peer = b;
    b.peer = a;

    // Both peers drive the exchange over the SAME duplex channel pair, concurrently.
    const [resultA] = await Promise.all([
      runWebrtcBidirectionalExchange({ db: peerA, channel: a, timeoutMs: 2000 }),
      runWebrtcBidirectionalExchange({ db: peerB, channel: b, timeoutMs: 2000 }),
    ]);

    expect(resultA.ingested?.blocks).toBe(1); // A ingested the served block
    expect(await readBlockBytes(peerA, blockCid)).toEqual(bytes); // A now HOLDS it
  });

  it('resolves (no ingest) on timeout when the channel has no peer', async () => {
    const lonely = new FakeDuplex(); // no `.peer` — nothing answers
    const result = await runWebrtcBidirectionalExchange({
      db: peerA,
      channel: lonely,
      timeoutMs: 100,
    });
    expect(result.ingested).toBeNull();
  });
});
