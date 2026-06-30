// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The untrusted relay (§22.4, WS-R.15.3): a content-addressed cache that stores +
// serves by CID, returns storage RECEIPTS (never an `accepted` verdict), enforces the
// §27.3 quotas, and refuses unencrypted/unpermitted private content.  The "relay
// cannot accept" property is verified structurally — the backing store's acceptance
// log stays empty no matter how much the relay stores.

import { cidFor, type RelayQuotaConfig } from '@licio/lcap';
import { describe, expect, it } from 'vitest';
import { LcapRelay, type RelayObjectInput } from '../lcap/relay.js';
import { InMemoryLcapServerStore } from '../lcap/store.js';

const enc = new TextEncoder();

async function blockInput(
  tag: string,
  over: Partial<RelayObjectInput> = {},
): Promise<RelayObjectInput> {
  const bytes = enc.encode(tag);
  return {
    cid: await cidFor('block', bytes),
    kind: 'block',
    bytes,
    lane: 'B4',
    peerId: 'peer-1',
    roomId: 'room-1',
    verified: true,
    visibility: 'public',
    encrypted: false,
    permitted: false,
    ...over,
  };
}

describe('LcapRelay — store / serve / receipt', () => {
  it('stores a valid object, returns a receipt, and serves it back by CID', async () => {
    const relay = new LcapRelay(new InMemoryLcapServerStore());
    const input = await blockInput('relay-block');
    const receipt = await relay.admit(input);
    expect(receipt).toEqual({ stored: true, cid: input.cid, alreadyHad: false });

    const served = await relay.serve(input.cid);
    expect(served && new Uint8Array(served.bytes)).toEqual(input.bytes);
  });

  it('is idempotent: re-admitting the same object reports alreadyHad', async () => {
    const relay = new LcapRelay(new InMemoryLcapServerStore());
    const input = await blockInput('dup');
    await relay.admit(input);
    expect(await relay.admit(input)).toEqual({ stored: true, cid: input.cid, alreadyHad: true });
  });

  it('refuses an object whose bytes do not match its claimed CID', async () => {
    const relay = new LcapRelay(new InMemoryLcapServerStore());
    const input = await blockInput('honest');
    const tampered = { ...input, bytes: enc.encode('different') };
    expect(await relay.admit(tampered)).toEqual({
      stored: false,
      cid: input.cid,
      refused: 'rejected_bad_cid',
    });
  });
});

describe('LcapRelay — CANNOT accept (structural)', () => {
  it('never marks canonical state: the backing acceptance log stays empty', async () => {
    const store = new InMemoryLcapServerStore();
    const relay = new LcapRelay(store);
    const input = await blockInput('not-accepted');
    await relay.admit(input);
    // Stored in the CAS …
    expect(await store.hasObject(input.cid)).toBe(true);
    // … but NEVER accepted: no room log, not in the acceptance set.
    expect(await store.isAccepted(input.cid)).toBe(false);
    expect(await store.roomSize(input.roomId)).toBe(0);
    expect(await store.listRooms()).toEqual([]);
  });

  it('exposes no accept/commit surface', () => {
    const relay = new LcapRelay(new InMemoryLcapServerStore());
    expect((relay as unknown as Record<string, unknown>)['commitRecord']).toBeUndefined();
    expect((relay as unknown as Record<string, unknown>)['appendAcceptance']).toBeUndefined();
  });
});

describe('LcapRelay — private-content refusal (§22.4)', () => {
  it('refuses plaintext private content', async () => {
    const relay = new LcapRelay(new InMemoryLcapServerStore());
    const input = await blockInput('priv', {
      visibility: 'private',
      encrypted: false,
      permitted: true,
    });
    expect(await relay.admit(input)).toEqual({
      stored: false,
      cid: input.cid,
      refused: 'private_content_refused',
    });
  });

  it('refuses encrypted private content the room policy does not permit', async () => {
    const relay = new LcapRelay(new InMemoryLcapServerStore());
    const input = await blockInput('priv2', {
      visibility: 'private',
      encrypted: true,
      permitted: false,
    });
    expect((await relay.admit(input)).stored).toBe(false);
  });

  it('admits encrypted + permitted private content', async () => {
    const relay = new LcapRelay(new InMemoryLcapServerStore());
    const input = await blockInput('priv3', {
      visibility: 'private',
      encrypted: true,
      permitted: true,
    });
    expect((await relay.admit(input)).stored).toBe(true);
  });

  it('refuses plaintext in_room content too (PUB-API-CORE-5: in_room treated like private)', async () => {
    const relay = new LcapRelay(new InMemoryLcapServerStore());
    const input = await blockInput('inroom', {
      visibility: 'in_room',
      encrypted: false,
      permitted: false,
    });
    expect(await relay.admit(input)).toEqual({
      stored: false,
      cid: input.cid,
      refused: 'private_content_refused',
    });
  });

  it('refuses encrypted in_room content the room policy does not permit (PUB-API-CORE-5)', async () => {
    const relay = new LcapRelay(new InMemoryLcapServerStore());
    const input = await blockInput('inroom2', {
      visibility: 'in_room',
      encrypted: true,
      permitted: false,
    });
    expect((await relay.admit(input)).stored).toBe(false);
  });

  it('admits encrypted + permitted in_room content (PUB-API-CORE-5)', async () => {
    const relay = new LcapRelay(new InMemoryLcapServerStore());
    const input = await blockInput('inroom3', {
      visibility: 'in_room',
      encrypted: true,
      permitted: true,
    });
    expect((await relay.admit(input)).stored).toBe(true);
  });
});

describe('LcapRelay — §27.3 quota enforcement', () => {
  it('refuses an object over the per-peer quota with the quota reason', async () => {
    const quota: RelayQuotaConfig = {
      totalBytes: 1_000_000,
      reservedFractionByLane: { C0: 0.1, T1: 0.2 },
      perPeerBytes: 8,
      perRoomBytes: 1_000_000,
      maxObjectBytes: 1_000_000,
      maxUnverifiedBytes: 1_000_000,
      maxInvalidRatio: 0.9,
      invalidRatioMinSample: 100,
    };
    const relay = new LcapRelay(new InMemoryLcapServerStore(), quota);
    // First small object fits; a second pushes the peer over its 8-byte quota.
    expect((await relay.admit(await blockInput('aaaa'))).stored).toBe(true); // 4 bytes
    const refusal = await relay.admit(await blockInput('bbbbb')); // +5 → 9 > 8
    expect(refusal).toEqual(expect.objectContaining({ stored: false, refused: 'peer_quota' }));
  });
});
