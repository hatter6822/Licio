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
import { buildClientExchangeRequest, respondToClientExchange } from '../exchange.js';
import { putBlock, readBlockBytes } from '../store.js';
import { runWebrtcBidirectionalExchange } from './webrtc-sync.js';

/** A fake duplex data channel: `send` delivers (a copy of) the bytes to the peer's `onmessage`. */
class FakeDuplex implements DataChannelLike {
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'open';
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  peer: FakeDuplex | null = null;
  sentCount = 0;
  send(data: Uint8Array): void {
    this.sentCount++;
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

/**
 * Await an observable CONDITION rather than a fixed delay.
 *
 * A `setTimeout` between two injected frames only makes an ordering LIKELY:
 * the inbound handler starts `handleInboundExchangeMessage` without awaiting
 * it, so under load the second frame can still overtake the first — the exact
 * class of coupling that made the bidirectional test flaky. Polling a real
 * condition makes the ordering hold whatever the scheduler does, and the
 * timeout turns a genuine hang into a clear failure rather than a wrong value.
 */
async function waitUntil(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
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

/** Put a PUBLIC record referencing `blockCid` so the block is shareable (an orphan block is not). */
async function putPublicRecordWithBlock(db: IDBDatabase, blockCid: string): Promise<void> {
  const lcap = await import('@licio/lcap');
  const body = lcap.encodeContributionEvent({
    record_version: 2,
    kind: 'contribution_event',
    event_type: 'post',
    home_room_id: 'room-1',
    visibility_scope: 'public',
    author_account_id: 'a',
    author_device_id: 'd',
    author_device_key_id: 'k',
    device_seq: 1,
    capability_cid: await lcap.cidFor('record', new Uint8Array([0])),
    policy_epoch_claim: 0,
    revocation_epoch_claim: 0,
    client_nonce: new Uint8Array([1]),
    priority: 2,
    body_block_cid: blockCid, // referenced in the SIGNED body so the share closure derives it (#O)
  });
  const recordCid = await lcap.cidFor('record', body);
  const tx = db.transaction(LCAP_STORE.records, 'readwrite');
  tx.objectStore(LCAP_STORE.records).put({
    recordCid,
    body,
    kind: 'contribution_event',
    lane: 'C0',
    priority: 2,
    roomHash: '',
    state: 'integrity_verified',
    size: body.length,
    deps: [blockCid],
  });
  await new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

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
    await putPublicRecordWithBlock(peerB, blockCid); // the block is reachable from a public record
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

    // WHICH LEG delivers the block is a genuine race, not a fixed outcome: B's own request carries
    // a gossip PUSH of the same block, and B's served RESPONSE carries it too.  Both are correct
    // and both leave A holding it — but if the push lands first the response then reports
    // `alreadyHave: 1, blocks: 0`.  Asserting `blocks === 1` here therefore pinned a scheduling
    // order rather than a guarantee, and failed under load once the push won the race.  The
    // response-leg count is asserted where it IS deterministic, in the injected-order test below.
    expect(resultA.ingested).not.toBeNull();
    const counts = resultA.ingested as NonNullable<typeof resultA.ingested>;
    expect(counts.blocks + counts.alreadyHave).toBeGreaterThanOrEqual(1); // accounted for, either leg
    expect(await readBlockBytes(peerA, blockCid)).toEqual(bytes); // A now HOLDS it
  });

  it('counts the block as INGESTED when the served response is processed first', async () => {
    // The order-dependent half of the test above, made deterministic by injecting the frames by
    // hand: A sees B's RESPONSE before B's request-borne push, so the response is the leg that
    // delivers the block and `blocks` must be 1 — the guarantee, decoupled from the scheduler.
    const bytes = new Uint8Array([5, 6, 7, 8, 9, 10]);
    const blockCid = await cidFor('block', bytes);
    await putBlock(peerB, { blockCid, state: 'integrity_verified', size: bytes.length }, [bytes]);
    await putPublicRecordWithBlock(peerB, blockCid);
    await quarantineMissing(peerA, [blockCid]);

    const aReq = await buildClientExchangeRequest(peerA, 'relay');
    const bResp = await respondToClientExchange(peerB, aReq); // B's served response, carrying it
    const bReq = await buildClientExchangeRequest(peerB, 'relay'); // B's request — settles A's round
    expect(bResp).not.toBeNull();

    const channel = new FakeDuplex(); // no `.peer`: only the frames we inject reach A
    const p2p = await import('@licio/lcap-p2p');
    const run = runWebrtcBidirectionalExchange({ db: peerA, channel, timeoutMs: 60_000 });
    const inject = (msg: Uint8Array): void => {
      for (const f of p2p.fragmentMessage(msg, 0)) channel.onmessage?.({ data: f.buffer });
    };
    // A is ready to receive once it has installed its inbound handler.
    await waitUntil(() => channel.onmessage !== null, "A's inbound handler");
    inject(bResp as Uint8Array); // the RESPONSE lands first…
    // …and is fully COMMITTED before the request-borne push can race it. The
    // block landing in A's store is the observable proof of that, so the
    // response is unambiguously the leg that delivered it.
    await waitUntil(
      async () => (await readBlockBytes(peerA, blockCid)) !== undefined,
      'the response to be committed',
    );
    inject(bReq); // …then the request, so the round settles without the timeout
    const result = await run;

    expect(result.ingested?.blocks).toBe(1); // the response leg delivered it
    expect(await readBlockBytes(peerA, blockCid)).toEqual(bytes);
  });

  it('does NOT commit a peer response delivered AFTER the exchange settled (#W)', async () => {
    const bytes = new Uint8Array([3, 1, 4, 1, 5, 9]);
    const blockCid = await cidFor('block', bytes);
    await putBlock(peerB, { blockCid, state: 'integrity_verified', size: bytes.length }, [bytes]);
    await putPublicRecordWithBlock(peerB, blockCid);
    await quarantineMissing(peerA, [blockCid]);
    // What B would serve in response to A's request (a real served pack carrying the block).
    const aReq = await buildClientExchangeRequest(peerA, 'relay');
    const bResp = await respondToClientExchange(peerB, aReq);
    expect(bResp).not.toBeNull();

    // A's exchange settles with NO peer (timeout) — nothing ingested.
    const channel = new FakeDuplex();
    const result = await runWebrtcBidirectionalExchange({ db: peerA, channel, timeoutMs: 100 });
    expect(result.ingested).toBeNull();

    // A late response arrives AFTER settle (delivered as fragments to the still-set onmessage); it
    // must be dropped — committing it now would mutate local state after the UI owner is gone.
    const { fragmentMessage } = await import('@licio/lcap-p2p'); // dynamic: keep the p2p chunk lazy
    for (const frag of fragmentMessage(bResp as Uint8Array, 0)) channel.onmessage?.({ data: frag });
    await new Promise((r) => setTimeout(r, 50));
    expect(await readBlockBytes(peerA, blockCid)).toBeUndefined(); // never committed post-settle
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

  it('sends NO payload when the signal is already aborted (page-unload / mode-change cancel)', async () => {
    const channel = new FakeDuplex();
    const controller = new AbortController();
    controller.abort(); // cancelled before we even start
    const result = await runWebrtcBidirectionalExchange({
      db: peerA,
      channel,
      signal: controller.signal,
      timeoutMs: 1000,
    });
    expect(channel.sentCount).toBe(0); // nothing transmitted after the cancel
    expect(result.ingested).toBeNull();
  });

  it('stays bidirectional under the grace window: BOTH peers’ wants are served', async () => {
    // A wants X (B holds), B wants Y (A holds) — both must end up holding the other's content.
    const x = new Uint8Array([1, 2, 3, 4]);
    const y = new Uint8Array([5, 6, 7, 8]);
    const xCid = await cidFor('block', x);
    const yCid = await cidFor('block', y);
    await putBlock(peerB, { blockCid: xCid, state: 'integrity_verified', size: x.length }, [x]);
    await putPublicRecordWithBlock(peerB, xCid);
    await putBlock(peerA, { blockCid: yCid, state: 'integrity_verified', size: y.length }, [y]);
    await putPublicRecordWithBlock(peerA, yCid);
    await quarantineMissing(peerA, [xCid]);
    await quarantineMissing(peerB, [yCid]);

    const a = new FakeDuplex();
    const b = new FakeDuplex();
    a.peer = b;
    b.peer = a;
    await Promise.all([
      runWebrtcBidirectionalExchange({ db: peerA, channel: a, timeoutMs: 3000 }),
      runWebrtcBidirectionalExchange({ db: peerB, channel: b, timeoutMs: 3000 }),
    ]);

    // Both directions completed: A holds X and B holds Y (the content may arrive via either the
    // gossip push in the request OR the served response — the grace window keeps BOTH alive).
    expect(await readBlockBytes(peerA, xCid)).toEqual(x); // A got X
    expect(await readBlockBytes(peerB, yCid)).toEqual(y); // B got Y
  });

  it('transmits the responder reply even when our own response is ingested FIRST (#reply-flush)', async () => {
    // The race the `finalize` drain closes: A ingests ITS response (gotResponse=true), THEN handles
    // the peer's request (served=true + a reply queued onto the async send chain).  A naive settle in
    // that same turn sets `settled` before the queued reply flushes, and the send guard then DROPS the
    // reply — the peer is marked served locally but never receives our served content.
    const x = new Uint8Array([9, 9, 9, 9]);
    const y = new Uint8Array([7, 7, 7, 7]);
    const xCid = await cidFor('block', x);
    const yCid = await cidFor('block', y);
    await putBlock(peerB, { blockCid: xCid, state: 'integrity_verified', size: x.length }, [x]);
    await putPublicRecordWithBlock(peerB, xCid);
    await putBlock(peerA, { blockCid: yCid, state: 'integrity_verified', size: y.length }, [y]);
    await putPublicRecordWithBlock(peerA, yCid);
    await quarantineMissing(peerA, [xCid]);
    await quarantineMissing(peerB, [yCid]);

    // Precompute the exact frames so we can DELIVER them to A in a controlled order.
    const aReq = await buildClientExchangeRequest(peerA, 'relay');
    const bRespToA = await respondToClientExchange(peerB, aReq); // B serves X → A ingests (gotResponse)
    const bReq = await buildClientExchangeRequest(peerB, 'relay'); // B wants Y → A serves it (a reply)
    expect(bRespToA).not.toBeNull();

    // A manual channel: capture A's OUTBOUND frames; inject inbound frames by hand.
    const sentFrames: Uint8Array[] = [];
    const channel = {
      readyState: 'open' as const,
      onmessage: null as ((event: { data: unknown }) => void) | null,
      onclose: null as (() => void) | null,
      send: (data: Uint8Array) => {
        sentFrames.push(data.slice());
      },
      close: () => {},
    } as unknown as DataChannelLike;

    const p2p = await import('@licio/lcap-p2p');
    const run = runWebrtcBidirectionalExchange({ db: peerA, channel, timeoutMs: 60_000 });
    const withOnmessage = channel as unknown as {
      onmessage: ((e: { data: unknown }) => void) | null;
    };
    const inject = (msg: Uint8Array): void => {
      for (const f of p2p.fragmentMessage(msg, 0)) withOnmessage.onmessage?.({ data: f });
    };
    // The race this test exists for needs OUR RESPONSE ingested BEFORE the
    // peer's request arrives. Both steps wait on the observable state rather
    // than on elapsed time, so the ordering holds under any scheduling.
    await waitUntil(() => withOnmessage.onmessage !== null, "A's inbound handler");
    inject(bRespToA as Uint8Array); // deliver our RESPONSE first → gotResponse = true
    await waitUntil(
      async () => (await readBlockBytes(peerA, xCid)) !== undefined,
      'our response to be ingested',
    );
    inject(bReq); // THEN the peer's REQUEST → served = true + a reply queued
    const result = await run;

    expect(result.served).toBe(true);
    // A must have actually TRANSMITTED a §16 RESPONSE serving Y — not just its own request.
    const lcap = await import('@licio/lcap');
    const reasm = new p2p.FragmentReassembler();
    const outbound: Uint8Array[] = [];
    for (const f of sentFrames) {
      const m = reasm.accept(f);
      if (m) outbound.push(m);
    }
    const sentAReply = outbound.some((m) => {
      try {
        return lcap.decodeWithSchema(lcap.exchangeResponseV2Schema, m).response_pack !== undefined;
      } catch {
        return false;
      }
    });
    expect(sentAReply).toBe(true); // the reply flushed before settle (dropped without the fix)
  });
});
