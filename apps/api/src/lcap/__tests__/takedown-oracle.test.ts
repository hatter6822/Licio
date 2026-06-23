// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Gate-19 (WS-R.15.7 / WS-S.4.4) — the REAL takedown oracle + block↔content linkage + the
// review-gated public-block (re)publisher.  These tests prove the gap closed by this slice:
//   • the `block_cid → content-entity` linkage resolves through the provenance store;
//   • an in-force (actioned) takedown over that entity HALTS (re)publication;
//   • the absence of any in-force takedown ALLOWS publication;
//   • an unknown block (no recorded provenance) is "not taken down" (publishable);
//   • the WS-S.4.4 public-gateway guard blocks a private-room CID even with a clean oracle;
//   • the bridge is no longer dead code — the publisher actually pins through it;
//   • the §29 route invokes the publisher and records provenance, so a takedown actioned
//     after the publish HALTS the republish (TOCTOU-safe, fail-closed).
//
// The pure decision cores (`takedownInForce`, `republicationSet`, the bridge oracle
// re-check) live in `@licio/lcap-p2p` and are covered by that package's `ipfs.test.ts`;
// this suite is about the apps/api binding (the DB-shaped adapters + the real caller).

import { cidFor } from '@licio/lcap';
import { describe, expect, it } from 'vitest';
import { LcapPublicPublisher } from '../publisher.js';
import { createLcapRoutes } from '../routes.js';
import { LcapIngestServer } from '../server-ingest.js';
import {
  InMemoryBlockProvenanceStore,
  InMemoryTakedownStatusReader,
  makeTakedownOracle,
  type ProvenanceTarget,
} from '../takedown-oracle.js';

const enc = new TextEncoder();
const STORY: ProvenanceTarget = { targetType: 'story', targetId: 'story-1' };
const SOURCE: ProvenanceTarget = { targetType: 'source', targetId: 'src-1' };

describe('Gate-19 — makeTakedownOracle (linkage + in-force resolution)', () => {
  it('resolves the block→content linkage and HALTS when the linked entity is taken down', async () => {
    const provenance = new InMemoryBlockProvenanceStore();
    const statuses = new InMemoryTakedownStatusReader();
    const oracle = makeTakedownOracle(provenance, statuses);
    const blockCid = await cidFor('block', enc.encode('story-1 body'));
    await provenance.link(blockCid, STORY);

    // No takedown yet → the linkage resolves but nothing is in force → publishable.
    expect(await oracle(blockCid)).toBe(false);

    // The story is actioned → the linkage now resolves to an in-force takedown → HALT.
    statuses.setInForce(STORY);
    expect(await oracle(blockCid)).toBe(true);
  });

  it('treats an UNKNOWN block (no provenance) as not-taken-down (publishable)', async () => {
    const statuses = new InMemoryTakedownStatusReader();
    statuses.setInForce(STORY); // even with an in-force takedown elsewhere…
    const oracle = makeTakedownOracle(new InMemoryBlockProvenanceStore(), statuses);
    const unknown = await cidFor('block', enc.encode('unlinked block'));
    // …a block with no recorded content target resolves to the empty target set → not halted.
    expect(await oracle(unknown)).toBe(false);
  });

  it('HALTS when ANY of a block’s multiple targets is taken down (fail-closed union)', async () => {
    const provenance = new InMemoryBlockProvenanceStore();
    const statuses = new InMemoryTakedownStatusReader();
    const oracle = makeTakedownOracle(provenance, statuses);
    const blockCid = await cidFor('block', enc.encode('embedded evidence in a story'));
    await provenance.link(blockCid, STORY);
    await provenance.link(blockCid, SOURCE);
    expect(await oracle(blockCid)).toBe(false);
    // Only the source is taken down — the block still halts (it derives from both).
    statuses.setInForce(SOURCE);
    expect(await oracle(blockCid)).toBe(true);
  });

  it('de-duplicates a repeated link (idempotent provenance) and clears a reversed takedown', async () => {
    const provenance = new InMemoryBlockProvenanceStore();
    const statuses = new InMemoryTakedownStatusReader();
    const oracle = makeTakedownOracle(provenance, statuses);
    const blockCid = await cidFor('block', enc.encode('reversible'));
    await provenance.link(blockCid, STORY);
    await provenance.link(blockCid, STORY); // idempotent
    expect(await provenance.targetsOf(blockCid)).toEqual([STORY]);
    statuses.setInForce(STORY);
    expect(await oracle(blockCid)).toBe(true);
    statuses.clear(STORY); // a reversed action lifts the halt
    expect(await oracle(blockCid)).toBe(false);
  });

  it('a throwing provenance lookup propagates (the bridge treats it as fail-closed halt)', async () => {
    const throwing = {
      link: () => Promise.resolve(),
      targetsOf: () => Promise.reject(new Error('db down')),
    };
    const oracle = makeTakedownOracle(throwing, new InMemoryTakedownStatusReader());
    await expect(oracle('lcapb_x')).rejects.toThrow('db down');
  });
});

describe('Gate-19 — LcapPublicPublisher (the REAL caller, no longer dead code)', () => {
  const makePublisher = (
    takedownOracle: (cid: string) => boolean | Promise<boolean>,
    onPin: () => void,
  ) =>
    new LcapPublicPublisher({
      gatewayUrl: 'https://gw.test',
      pinningUrl: 'https://pin.test/add',
      takedownOracle,
      fetchFn: async () => {
        onPin();
        return new Response(null, { status: 200 });
      },
    });

  it('publishes a clean public block (oracle says no takedown) — actually pins', async () => {
    let pinned = false;
    const payload = enc.encode('clean public');
    const blockCid = await cidFor('block', payload);
    const pub = makePublisher(
      async () => false,
      () => {
        pinned = true;
      },
    );
    const res = await pub.publish({
      blockCid,
      bytes: payload,
      visibility: 'public',
      encrypted: false,
      privateRoomCid: false,
    });
    expect(res.ok).toBe(true);
    expect(pinned).toBe(true);
  });

  it('HALTS publish when the oracle reports a takedown (no pin)', async () => {
    let pinned = false;
    const payload = enc.encode('taken down');
    const blockCid = await cidFor('block', payload);
    const pub = makePublisher(
      async () => true,
      () => {
        pinned = true;
      },
    );
    const res = await pub.publish({
      blockCid,
      bytes: payload,
      visibility: 'public',
      encrypted: false,
      privateRoomCid: false,
    });
    expect(res).toEqual({ ok: false, reason: 'takedown_recheck_halt' });
    expect(pinned).toBe(false);
  });

  it('FAILS CLOSED on an unreadable takedown state (a throwing oracle halts, no pin)', async () => {
    let pinned = false;
    const payload = enc.encode('oracle down');
    const blockCid = await cidFor('block', payload);
    const pub = makePublisher(
      () => {
        throw new Error('takedown store unreadable');
      },
      () => {
        pinned = true;
      },
    );
    const res = await pub.publish({
      blockCid,
      bytes: payload,
      visibility: 'public',
      encrypted: false,
      privateRoomCid: false,
    });
    expect(res).toEqual({ ok: false, reason: 'takedown_recheck_halt' });
    expect(pinned).toBe(false);
  });

  it('the WS-S.4.4 guard blocks a private-room CID even with a clean oracle (no pin)', async () => {
    let pinned = false;
    const payload = enc.encode('private leak attempt');
    const blockCid = await cidFor('block', payload);
    const pub = makePublisher(
      async () => false,
      () => {
        pinned = true;
      },
    );
    const res = await pub.publish({
      blockCid,
      bytes: payload,
      visibility: 'public',
      encrypted: false,
      privateRoomCid: true,
    });
    expect(res).toEqual({ ok: false, reason: 'private_room_cid' });
    expect(pinned).toBe(false);
  });

  it('refuses a non-public / encrypted block up front (no pin)', async () => {
    let pinned = 0;
    const payload = enc.encode('not public');
    const blockCid = await cidFor('block', payload);
    const pub = makePublisher(
      async () => false,
      () => {
        pinned += 1;
      },
    );
    const inRoom = await pub.publish({
      blockCid,
      bytes: payload,
      visibility: 'in_room',
      encrypted: false,
      privateRoomCid: false,
    });
    expect(inRoom).toEqual({ ok: false, reason: 'not_public' });
    const encrypted = await pub.publish({
      blockCid,
      bytes: payload,
      visibility: 'public',
      encrypted: true,
      privateRoomCid: false,
    });
    expect(encrypted).toEqual({ ok: false, reason: 'encrypted' });
    expect(pinned).toBe(0);
  });

  it('republish re-checks the live oracle: HALTS a taken-down block, re-pins a clean one', async () => {
    const payload = enc.encode('republish');
    const blockCid = await cidFor('block', payload);
    let halted = false;
    const haltPub = makePublisher(
      async () => true,
      () => {
        halted = true;
      },
    );
    expect(await haltPub.republish(blockCid, payload)).toEqual({
      ok: false,
      reason: 'takedown_recheck_halt',
    });
    expect(halted).toBe(false);

    let pinned = false;
    const cleanPub = makePublisher(
      async () => false,
      () => {
        pinned = true;
      },
    );
    expect((await cleanPub.republish(blockCid, payload)).ok).toBe(true);
    expect(pinned).toBe(true);
  });

  it('republishMany excludes taken-down CIDs and re-pins the eligible ones over the live oracle', async () => {
    const a = await cidFor('block', enc.encode('a'));
    const b = await cidFor('block', enc.encode('b'));
    const bytesOf = new Map([
      [a, enc.encode('a')],
      [b, enc.encode('b')],
    ]);
    let pins = 0;
    const pub = makePublisher(
      (cid) => cid === b,
      () => {
        pins += 1;
      },
    );
    const { set, outcomes } = await pub.republishMany([a, b], (cid) => bytesOf.get(cid));
    expect(set.eligible).toEqual([a]); // b is taken down → excluded fail-closed
    expect(set.excluded).toEqual([{ blockCid: b, eligible: false, reason: 'taken_down' }]);
    expect(outcomes.get(a)).toMatchObject({ ok: true });
    expect(outcomes.has(b)).toBe(false); // never even attempted
    expect(pins).toBe(1);
  });
});

describe('Gate-19 — the §29 public-bridge route (the wired entry point)', () => {
  /** Build the routes with an explicit server + a fake-pinning publisher + provenance. */
  function harness(takedown: (cid: string) => boolean | Promise<boolean>) {
    const server = new LcapIngestServer('net');
    const provenance = new InMemoryBlockProvenanceStore();
    let pinned = 0;
    const publisher = new LcapPublicPublisher({
      gatewayUrl: 'https://gw.test',
      pinningUrl: 'https://pin.test/add',
      takedownOracle: takedown,
      fetchFn: async () => {
        pinned += 1;
        return new Response(null, { status: 200 });
      },
    });
    const app = createLcapRoutes(server, publisher, provenance);
    return { server, provenance, app, pins: () => pinned };
  }

  it('503 when the public bridge is not configured (no publisher)', async () => {
    const server = new LcapIngestServer('net');
    const app = createLcapRoutes(server); // no publisher override → env-gated factory returns undefined
    const res = await app.request('/public-bridge/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        block_cid: 'lcapb_x',
        visibility: 'public',
        encrypted: false,
        private_room_cid: false,
      }),
    });
    expect(res.status).toBe(503);
  });

  it('404 when the CAS does not hold the block', async () => {
    const { app } = harness(async () => false);
    const absent = await cidFor('block', enc.encode('absent'));
    const res = await app.request('/public-bridge/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        block_cid: absent,
        visibility: 'public',
        encrypted: false,
        private_room_cid: false,
      }),
    });
    expect(res.status).toBe(404);
  });

  it('publishes a held clean public block, records provenance, and pins', async () => {
    const { server, provenance, app, pins } = harness(async () => false);
    const payload = enc.encode('held public');
    const blockCid = await cidFor('block', payload);
    await server.putObject(blockCid, 'block', payload);
    const res = await app.request('/public-bridge/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        block_cid: blockCid,
        visibility: 'public',
        encrypted: false,
        private_room_cid: false,
        content_target: { target_type: 'story', target_id: 'story-1' },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(pins()).toBe(1);
    // The linkage was recorded — exactly the data a later takedown halt needs.
    expect(await provenance.targetsOf(blockCid)).toEqual([STORY]);
  });

  it('TOCTOU: a takedown actioned AFTER publish HALTS the later republish (fail-closed)', async () => {
    // The oracle is backed by a live status reader the test mutates between calls — the
    // production shape (the oracle reads live `takedown_requests` on every call).
    const provenance = new InMemoryBlockProvenanceStore();
    const statuses = new InMemoryTakedownStatusReader();
    const oracle = makeTakedownOracle(provenance, statuses);
    const server = new LcapIngestServer('net');
    let pinned = 0;
    const publisher = new LcapPublicPublisher({
      gatewayUrl: 'https://gw.test',
      pinningUrl: 'https://pin.test/add',
      takedownOracle: oracle,
      fetchFn: async () => {
        pinned += 1;
        return new Response(null, { status: 200 });
      },
    });
    const app = createLcapRoutes(server, publisher, provenance);

    const payload = enc.encode('toctou public');
    const blockCid = await cidFor('block', payload);
    await server.putObject(blockCid, 'block', payload);

    // 1) Publish succeeds + records the story linkage.
    const pub = await app.request('/public-bridge/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        block_cid: blockCid,
        visibility: 'public',
        encrypted: false,
        private_room_cid: false,
        content_target: { target_type: 'story', target_id: 'story-1' },
      }),
    });
    expect((await pub.json()) as { ok: boolean }).toMatchObject({ ok: true });
    expect(pinned).toBe(1);

    // 2) A steward actions a takedown over the story AFTER the publish.
    statuses.setInForce(STORY);

    // 3) The republish re-checks the live oracle → resolves the linkage → HALT (no new pin).
    const re = await app.request('/public-bridge/republish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ block_cid: blockCid }),
    });
    expect(await re.json()).toEqual({ ok: false, reason: 'takedown_recheck_halt' });
    expect(pinned).toBe(1); // still 1 — the republish did NOT pin

    // 4) The reverse direction also resolves: clearing the action lifts the halt.
    statuses.clear(STORY);
    const re2 = await app.request('/public-bridge/republish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ block_cid: blockCid }),
    });
    expect((await re2.json()) as { ok: boolean }).toMatchObject({ ok: true });
    expect(pinned).toBe(2);
  });

  it('400 on a malformed request body / non-block CID', async () => {
    const { app } = harness(async () => false);
    const bad = await app.request('/public-bridge/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    expect(bad.status).toBe(400);
    const recordCid = await cidFor('record', enc.encode('a record, not a block'));
    const wrongKind = await app.request('/public-bridge/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        block_cid: recordCid,
        visibility: 'public',
        encrypted: false,
        private_room_cid: false,
      }),
    });
    // The CAS holds nothing under that CID → 404 (a well-formed CID, but not a held block).
    expect(wrongKind.status).toBe(404);
  });
});
