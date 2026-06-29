// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The app-layer §16 wants-completion back-stop (#2/#2b): after a peer round, fill any STILL-unfilled
// wants from the anchor — but NEVER hit the anchor when the peer round already covered them.

import 'fake-indexeddb/auto';
import {
  buildExchangeResponse,
  buildPulse,
  cidFor,
  DEFAULT_BUDGET,
  encodeWithSchema,
  exchangeResponseV2Schema,
  repackHeldObjects,
} from '@licio/lcap';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LCAP_DB_VERSION, LCAP_MIGRATIONS, LCAP_STORE, openLcapDb } from '../db.js';
import { buildClientExchangeRequest } from '../exchange.js';
import { putBlock, readBlockBytes } from '../store.js';
import { backstopUnfilledWantsAtAnchor } from './anchor-backstop.js';

let db: IDBDatabase;
beforeEach(async () => {
  db = await openLcapDb(
    `lcap_v2-backstop-${Math.random().toString(36).slice(2)}`,
    LCAP_DB_VERSION,
    LCAP_MIGRATIONS,
  );
});
afterEach(() => db.close());

async function quarantineMissing(missing: string[]): Promise<void> {
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

/** A §16 exchange response whose `response_pack` serves `cids` from `held` (the anchor's reply). */
async function anchorResponseServing(
  held: Map<string, Uint8Array>,
  cids: string[],
): Promise<Uint8Array> {
  const repacked = await repackHeldObjects(
    async (cid) => {
      const bytes = held.get(cid);
      return bytes ? { kind: 'block', bytes } : undefined;
    },
    cids,
    1 << 20,
  );
  const pulse = buildPulse({
    nodeId: 'anchor',
    sessionNonce: new Uint8Array(16),
    transportProfile: 'https',
    privacyMode: 'public',
    budgets: { ...DEFAULT_BUDGET },
    supportedSuites: ['ES256'],
    supportedCompression: ['none'],
    supportedPackVersions: [2],
    checkpointFrontier: [],
    revocationFrontier: [{ scope: 'global', revocation_epoch: 0 }],
  });
  const response = buildExchangeResponse({
    pulse,
    status: 'ok',
    ...(repacked.pack !== undefined ? { responsePack: repacked.pack } : {}),
  });
  return encodeWithSchema(exchangeResponseV2Schema, response);
}

function recordingFetch(urls: string[], body: Uint8Array): typeof fetch {
  return (async (input: string | URL | Request) => {
    urls.push(String(input));
    if (String(input).includes('/exchange')) return new Response(body as BodyInit, { status: 200 });
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

describe('backstopUnfilledWantsAtAnchor (#2/#2b)', () => {
  it('fills a STILL-unfilled want from the anchor', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const cid = await cidFor('block', bytes);
    await quarantineMissing([cid]);
    const request = await buildClientExchangeRequest(db, 'courier');
    const urls: string[] = [];
    const result = await backstopUnfilledWantsAtAnchor(db, request, undefined, {
      fetchFn: recordingFetch(urls, await anchorResponseServing(new Map([[cid, bytes]]), [cid])),
    });
    expect(result).not.toBeNull();
    expect(result?.ingested?.blocks).toBe(1);
    expect(urls.some((u) => u.includes('/exchange'))).toBe(true);
    expect(await readBlockBytes(db, cid)).toEqual(bytes);
  });

  it('returns null and NEVER hits the anchor when the want is already HELD', async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const cid = await cidFor('block', bytes);
    await quarantineMissing([cid]); // a lingering quarantine row...
    await putBlock(db, { blockCid: cid, state: 'integrity_verified', size: bytes.length }, [bytes]); // ...but held
    const request = await buildClientExchangeRequest(db, 'courier');
    const urls: string[] = [];
    const result = await backstopUnfilledWantsAtAnchor(db, request, undefined, {
      fetchFn: recordingFetch(urls, new Uint8Array([0])),
    });
    expect(result).toBeNull(); // peer round already covered our wants
    expect(urls.some((u) => u.includes('/exchange'))).toBe(false); // anchor never reached
  });

  it('does NOT contact the anchor if liveness flips DURING the want scan (#1r)', async () => {
    // shouldCommit is true at the pre-scan check but false by the pre-anchor check (modelling a Stop /
    // forced-off mode landing during the async requestHasUnfilledWants DB reads).  The server must NOT
    // be contacted — the caller can suppress the commit but not an already-sent request/push_pack.
    const cid = await cidFor('block', new Uint8Array([8]));
    await quarantineMissing([cid]); // an unfilled want → would otherwise proceed to the anchor
    const request = await buildClientExchangeRequest(db, 'courier');
    const urls: string[] = [];
    let n = 0;
    const result = await backstopUnfilledWantsAtAnchor(
      db,
      request,
      undefined,
      { fetchFn: recordingFetch(urls, new Uint8Array([0])) },
      () => n++ === 0, // true at the pre-scan check, false at the (new) pre-anchor check
    );
    expect(result).toBeNull();
    expect(urls.length).toBe(0); // the server was NEVER contacted (#1r)
  });

  it('short-circuits (no anchor, no want scan) when shouldCommit is already false', async () => {
    const cid = await cidFor('block', new Uint8Array([7]));
    await quarantineMissing([cid]);
    const request = await buildClientExchangeRequest(db, 'courier');
    const urls: string[] = [];
    const result = await backstopUnfilledWantsAtAnchor(
      db,
      request,
      undefined,
      { fetchFn: recordingFetch(urls, new Uint8Array([0])) },
      () => false,
    );
    expect(result).toBeNull();
    expect(urls.length).toBe(0); // bailed before the anchor leg
  });
});
