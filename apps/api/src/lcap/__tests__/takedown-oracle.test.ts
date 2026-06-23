// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Gate-19 (WS-R.15.7 / WS-S.4.4) — the REAL takedown oracle + block↔content linkage + the
// REVIEW-gated, AUDITED, STEWARD-AUTHORIZED public-block (re)publisher.  These tests prove the
// gaps closed by this slice:
//   • the `block_cid → content-entity` linkage resolves through the provenance store;
//   • an in-force (actioned) takedown over that entity HALTS (re)publication;
//   • the §22.7 privacy/moderation/abuse-REVIEW gate REFUSES an unreviewed / pending /
//     rejected / source-less candidate, and ALLOWS an `approved` one (fail-closed);
//   • an unreadable review store fails closed (refuse, never pin);
//   • the WS-S.4.4 public-gateway guard blocks a private-room CID even with a clean oracle;
//   • the bridge is no longer dead code — the publisher actually pins through it;
//   • the §29 route is STEWARD-AUTHORIZED (an anonymous / non-steward caller is denied),
//     records MANDATORY provenance, runs the review gate, and writes ONE append-only AUDIT
//     record per (re)publish decision — and a takedown actioned after publish HALTS the
//     republish (TOCTOU-safe, fail-closed).
//
// The pure decision cores (`takedownInForce`, `republicationSet`, the bridge oracle
// re-check) live in `@licio/lcap-p2p` and are covered by that package's `ipfs.test.ts`;
// this suite is about the apps/api binding (the DB-shaped adapters + the real caller).

import { cidFor } from '@licio/lcap';
import { describe, expect, it } from 'vitest';
import { freshForumServices, seedUserWithSession } from '../../__tests__/forum-test-helpers.js';
import { InMemoryPublishAuditStore } from '../publish-audit.js';
import { LcapPublicPublisher } from '../publisher.js';
import { type BlockPublishReviewStore, InMemoryBlockPublishReviewStore } from '../review-gate.js';
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

/** A review store with every supplied target pre-approved (the common "clean" case). */
function approvedReviewStore(...targets: readonly ProvenanceTarget[]): BlockPublishReviewStore {
  const store = new InMemoryBlockPublishReviewStore();
  for (const t of targets) void store.record(t, 'approved', 'steward-1', null);
  return store;
}

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

describe('Gate-19 — the §22.7 review gate (assertPublishReviewApproved)', () => {
  it('refuses a candidate with NO content target (a source-less block can never be approved)', async () => {
    const { assertPublishReviewApproved } = await import('../review-gate.js');
    const v = await assertPublishReviewApproved(new InMemoryBlockPublishReviewStore(), []);
    expect(v).toEqual({ approved: false, reason: 'review_required', blockedState: 'unreviewed' });
  });

  it('refuses an unreviewed target, a pending target, and a rejected target', async () => {
    const { assertPublishReviewApproved } = await import('../review-gate.js');
    const store = new InMemoryBlockPublishReviewStore();
    // unreviewed
    expect((await assertPublishReviewApproved(store, [STORY])).approved).toBe(false);
    // pending
    await store.record(STORY, 'pending', 's', null);
    expect((await assertPublishReviewApproved(store, [STORY])).approved).toBe(false);
    // rejected
    await store.record(STORY, 'rejected', 's', 'privacy leak');
    expect((await assertPublishReviewApproved(store, [STORY])).approved).toBe(false);
  });

  it('approves only when EVERY target is approved', async () => {
    const { assertPublishReviewApproved } = await import('../review-gate.js');
    const store = new InMemoryBlockPublishReviewStore();
    await store.record(STORY, 'approved', 's', null);
    // STORY approved but SOURCE not → refuse.
    expect((await assertPublishReviewApproved(store, [STORY, SOURCE])).approved).toBe(false);
    await store.record(SOURCE, 'approved', 's', null);
    expect((await assertPublishReviewApproved(store, [STORY, SOURCE])).approved).toBe(true);
  });
});

describe('Gate-19 — LcapPublicPublisher (review + takedown gates, no longer dead code)', () => {
  const makePublisher = (
    takedownOracle: (cid: string) => boolean | Promise<boolean>,
    onPin: () => void,
    reviewStore: BlockPublishReviewStore = approvedReviewStore(STORY),
  ) =>
    new LcapPublicPublisher({
      gatewayUrl: 'https://gw.test',
      pinningUrl: 'https://pin.test/add',
      takedownOracle,
      reviewStore,
      fetchFn: async () => {
        onPin();
        return new Response(null, { status: 200 });
      },
    });

  it('publishes a clean, reviewed-approved public block (oracle says no takedown) — actually pins', async () => {
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
      targets: [STORY],
    });
    expect(res.outcome.ok).toBe(true);
    expect(pinned).toBe(true);
  });

  it('REFUSES an unreviewed block (review_required) before any takedown re-check or pin', async () => {
    let pinned = false;
    const payload = enc.encode('unreviewed public');
    const blockCid = await cidFor('block', payload);
    // A clean oracle, but the review store has NO approval for STORY.
    const pub = makePublisher(
      async () => false,
      () => {
        pinned = true;
      },
      new InMemoryBlockPublishReviewStore(),
    );
    const res = await pub.publish({
      blockCid,
      bytes: payload,
      visibility: 'public',
      encrypted: false,
      privateRoomCid: false,
      targets: [STORY],
    });
    expect(res.outcome).toEqual({ ok: false, reason: 'review_required' });
    expect(pinned).toBe(false);
  });

  it('FAILS CLOSED on an unreadable review store (a throwing store refuses, no pin)', async () => {
    let pinned = false;
    const payload = enc.encode('review store down');
    const blockCid = await cidFor('block', payload);
    const throwingReview: BlockPublishReviewStore = {
      record: () => Promise.resolve(),
      decisionsFor: () => Promise.reject(new Error('review store unreadable')),
    };
    const pub = makePublisher(
      async () => false,
      () => {
        pinned = true;
      },
      throwingReview,
    );
    const res = await pub.publish({
      blockCid,
      bytes: payload,
      visibility: 'public',
      encrypted: false,
      privateRoomCid: false,
      targets: [STORY],
    });
    expect(res.outcome).toEqual({ ok: false, reason: 'review_required' });
    expect(pinned).toBe(false);
  });

  it('HALTS publish when the oracle reports a takedown (no pin), even when reviewed', async () => {
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
      targets: [STORY],
    });
    expect(res.outcome).toEqual({ ok: false, reason: 'takedown_recheck_halt' });
    expect(pinned).toBe(false);
  });

  it('the WS-S.4.4 guard blocks a private-room CID even with a clean oracle + approved review (no pin)', async () => {
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
      targets: [STORY],
    });
    expect(res.outcome).toEqual({ ok: false, reason: 'private_room_cid' });
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
      targets: [STORY],
    });
    expect(inRoom.outcome).toEqual({ ok: false, reason: 'not_public' });
    const encrypted = await pub.publish({
      blockCid,
      bytes: payload,
      visibility: 'public',
      encrypted: true,
      privateRoomCid: false,
      targets: [STORY],
    });
    expect(encrypted.outcome).toEqual({ ok: false, reason: 'encrypted' });
    expect(pinned).toBe(0);
  });

  it('republish re-checks the review gate AND the live oracle: HALTS, then re-pins a clean one', async () => {
    const payload = enc.encode('republish');
    const blockCid = await cidFor('block', payload);
    let halted = false;
    const haltPub = makePublisher(
      async () => true,
      () => {
        halted = true;
      },
    );
    expect((await haltPub.republish(blockCid, payload, [STORY])).outcome).toEqual({
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
    expect((await cleanPub.republish(blockCid, payload, [STORY])).outcome.ok).toBe(true);
    expect(pinned).toBe(true);
  });

  it('republish REFUSES when the recorded targets are no longer approved (review_required)', async () => {
    const payload = enc.encode('rerepublish');
    const blockCid = await cidFor('block', payload);
    let pinned = false;
    const pub = makePublisher(
      async () => false,
      () => {
        pinned = true;
      },
      new InMemoryBlockPublishReviewStore(), // STORY not approved
    );
    expect((await pub.republish(blockCid, payload, [STORY])).outcome).toEqual({
      ok: false,
      reason: 'review_required',
    });
    expect(pinned).toBe(false);
  });

  it('republishMany excludes taken-down CIDs and re-pins the eligible (reviewed) ones', async () => {
    const a = await cidFor('block', enc.encode('a'));
    const b = await cidFor('block', enc.encode('b'));
    const bytesOf = new Map([
      [a, enc.encode('a')],
      [b, enc.encode('b')],
    ]);
    const targetsOf = new Map<string, ProvenanceTarget[]>([
      [a, [STORY]],
      [b, [SOURCE]],
    ]);
    let pins = 0;
    const pub = makePublisher(
      (cid) => cid === b,
      () => {
        pins += 1;
      },
      approvedReviewStore(STORY, SOURCE),
    );
    const { set, outcomes } = await pub.republishMany(
      [a, b],
      (cid) => bytesOf.get(cid),
      (cid) => targetsOf.get(cid) ?? [],
    );
    expect(set.eligible).toEqual([a]); // b is taken down → excluded fail-closed
    expect(set.excluded).toEqual([{ blockCid: b, eligible: false, reason: 'taken_down' }]);
    const oa = outcomes.get(a);
    expect(oa !== 'no_bytes' && oa?.outcome.ok).toBe(true);
    expect(outcomes.has(b)).toBe(false); // never even attempted
    expect(pins).toBe(1);
  });
});

describe('Gate-19 — the §29 public-bridge route (steward-authorized, audited, provenance)', () => {
  /**
   * Build the routes with an explicit server + a fake-pinning publisher + provenance + an
   * in-memory review + audit store, plus a fresh identity bundle so the steward session cookie
   * resolves through the real `authMiddleware()`.
   */
  async function harness(
    takedown: (cid: string) => boolean | Promise<boolean>,
    review: BlockPublishReviewStore = approvedReviewStore(STORY),
  ) {
    const forum = freshForumServices();
    const steward = await seedUserWithSession(forum.identity, { steward: true });
    const regular = await seedUserWithSession(forum.identity);
    const server = new LcapIngestServer('net');
    const provenance = new InMemoryBlockProvenanceStore();
    const audit = new InMemoryPublishAuditStore();
    let pinned = 0;
    const publisher = new LcapPublicPublisher({
      gatewayUrl: 'https://gw.test',
      pinningUrl: 'https://pin.test/add',
      takedownOracle: takedown,
      reviewStore: review,
      fetchFn: async () => {
        pinned += 1;
        return new Response(null, { status: 200 });
      },
    });
    const app = createLcapRoutes(server, publisher, provenance, audit, review);
    return { server, provenance, audit, review, app, steward, regular, pins: () => pinned };
  }

  const STORY_BODY = (path: string, cookie: string, blockCid: string) =>
    new Request(`http://x${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        block_cid: blockCid,
        visibility: 'public',
        encrypted: false,
        private_room_cid: false,
        content_targets: [{ target_type: 'story', target_id: 'story-1' }],
      }),
    });

  it('401 for an anonymous caller (no session) — never reaches the bridge', async () => {
    const { app } = await harness(async () => false);
    const res = await app.request('/public-bridge/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        block_cid: 'lcapb_x',
        visibility: 'public',
        encrypted: false,
        private_room_cid: false,
        content_targets: [{ target_type: 'story', target_id: 'story-1' }],
      }),
    });
    expect(res.status).toBe(401);
  });

  it('403 for an authenticated NON-steward caller', async () => {
    const { app, regular } = await harness(async () => false);
    const blockCid = await cidFor('block', enc.encode('x'));
    const res = await app.request(STORY_BODY('/public-bridge/publish', regular.cookie, blockCid));
    expect(res.status).toBe(403);
  });

  it('503 when the public bridge is not configured (no publisher), for a steward', async () => {
    const forum = freshForumServices();
    const steward = await seedUserWithSession(forum.identity, { steward: true });
    const server = new LcapIngestServer('net');
    const app = createLcapRoutes(server); // no publisher override → env-gated factory returns undefined
    const res = await app.request(STORY_BODY('/public-bridge/publish', steward.cookie, 'lcapb_x'));
    expect(res.status).toBe(503);
  });

  it('404 when the CAS does not hold the block', async () => {
    const { app, steward } = await harness(async () => false);
    const absent = await cidFor('block', enc.encode('absent'));
    const res = await app.request(STORY_BODY('/public-bridge/publish', steward.cookie, absent));
    expect(res.status).toBe(404);
  });

  it('publishes a held clean block, records MANDATORY provenance, pins, and AUDITS the decision', async () => {
    const { server, provenance, audit, app, steward, pins } = await harness(async () => false);
    const payload = enc.encode('held public');
    const blockCid = await cidFor('block', payload);
    await server.putObject(blockCid, 'block', payload);
    const res = await app.request(STORY_BODY('/public-bridge/publish', steward.cookie, blockCid));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(pins()).toBe(1);
    // The linkage was recorded — exactly the data a later takedown halt needs.
    expect(await provenance.targetsOf(blockCid)).toEqual([STORY]);
    // The decision is durably audited (finding #37).
    const rows = audit.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'publish',
      blockCid,
      target: STORY,
      actorUserId: steward.userId,
      reviewVerdict: 'approved',
      takedownVerdict: 'clear',
      published: true,
    });
    expect(rows[0]?.ipfsCid).not.toBeNull();
  });

  it('an UNREVIEWED block is refused review_required at the route, AUDITED, and never pinned', async () => {
    // No approval recorded for STORY.
    const { server, app, audit, steward, pins } = await harness(
      async () => false,
      new InMemoryBlockPublishReviewStore(),
    );
    const payload = enc.encode('unreviewed route');
    const blockCid = await cidFor('block', payload);
    await server.putObject(blockCid, 'block', payload);
    const res = await app.request(STORY_BODY('/public-bridge/publish', steward.cookie, blockCid));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: 'review_required' });
    expect(pins()).toBe(0);
    expect(audit.all()[0]).toMatchObject({
      reviewVerdict: 'review_required',
      published: false,
      outcomeReason: 'review_required',
    });
  });

  it('a steward can RECORD a review, then the same block publishes (the gate is real)', async () => {
    const { server, app, steward, pins } = await harness(
      async () => false,
      new InMemoryBlockPublishReviewStore(), // starts un-approved
    );
    const payload = enc.encode('review then publish');
    const blockCid = await cidFor('block', payload);
    await server.putObject(blockCid, 'block', payload);
    // 1) First attempt → refused (no approval yet).
    const first = await app.request(STORY_BODY('/public-bridge/publish', steward.cookie, blockCid));
    expect(await first.json()).toEqual({ ok: false, reason: 'review_required' });
    expect(pins()).toBe(0);
    // 2) The steward records the affirmative review through the real route.
    const recorded = await app.request('/public-bridge/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: steward.cookie },
      body: JSON.stringify({ target_type: 'story', target_id: 'story-1', state: 'approved' }),
    });
    expect(recorded.status).toBe(200);
    // 3) Now the same block publishes.
    const second = await app.request(
      STORY_BODY('/public-bridge/publish', steward.cookie, blockCid),
    );
    expect(await second.json()).toMatchObject({ ok: true });
    expect(pins()).toBe(1);
  });

  it('the review route is steward-gated (403 for a non-steward)', async () => {
    const { app, regular } = await harness(async () => false);
    const res = await app.request('/public-bridge/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: regular.cookie },
      body: JSON.stringify({ target_type: 'story', target_id: 'story-1', state: 'approved' }),
    });
    expect(res.status).toBe(403);
  });

  it('TOCTOU: a takedown actioned AFTER publish HALTS the later republish (fail-closed), both audited', async () => {
    // The oracle is backed by a live status reader the test mutates between calls — the
    // production shape (the oracle reads live `takedown_requests` on every call).
    const forum = freshForumServices();
    const steward = await seedUserWithSession(forum.identity, { steward: true });
    const provenance = new InMemoryBlockProvenanceStore();
    const statuses = new InMemoryTakedownStatusReader();
    const oracle = makeTakedownOracle(provenance, statuses);
    const review = approvedReviewStore(STORY);
    const audit = new InMemoryPublishAuditStore();
    const server = new LcapIngestServer('net');
    let pinned = 0;
    const publisher = new LcapPublicPublisher({
      gatewayUrl: 'https://gw.test',
      pinningUrl: 'https://pin.test/add',
      takedownOracle: oracle,
      reviewStore: review,
      fetchFn: async () => {
        pinned += 1;
        return new Response(null, { status: 200 });
      },
    });
    const app = createLcapRoutes(server, publisher, provenance, audit, review);

    const payload = enc.encode('toctou public');
    const blockCid = await cidFor('block', payload);
    await server.putObject(blockCid, 'block', payload);

    // 1) Publish succeeds + records the story linkage.
    const pub = await app.request(STORY_BODY('/public-bridge/publish', steward.cookie, blockCid));
    expect((await pub.json()) as { ok: boolean }).toMatchObject({ ok: true });
    expect(pinned).toBe(1);

    // 2) A steward actions a takedown over the story AFTER the publish.
    statuses.setInForce(STORY);

    // 3) The republish re-checks the live oracle → resolves the linkage → HALT (no new pin).
    const re = await app.request('/public-bridge/republish', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: steward.cookie },
      body: JSON.stringify({ block_cid: blockCid }),
    });
    expect(await re.json()).toEqual({ ok: false, reason: 'takedown_recheck_halt' });
    expect(pinned).toBe(1); // still 1 — the republish did NOT pin

    // 4) The reverse direction also resolves: clearing the action lifts the halt.
    statuses.clear(STORY);
    const re2 = await app.request('/public-bridge/republish', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: steward.cookie },
      body: JSON.stringify({ block_cid: blockCid }),
    });
    expect((await re2.json()) as { ok: boolean }).toMatchObject({ ok: true });
    expect(pinned).toBe(2);

    // Every decision is audited: publish(ok) + republish(halt) + republish(ok) = 3 rows.
    const rows = audit.all();
    expect(rows.map((r) => `${r.action}:${r.published}`)).toEqual([
      'publish:true',
      'republish:false',
      'republish:true',
    ]);
    expect(rows[1]).toMatchObject({
      takedownVerdict: 'halt',
      outcomeReason: 'takedown_recheck_halt',
    });
  });

  it('400 on a malformed request body / a non-block CID', async () => {
    const { app, steward } = await harness(async () => false);
    const bad = await app.request('/public-bridge/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: steward.cookie },
      body: '{ not json',
    });
    expect(bad.status).toBe(400);
    // A missing content_targets is a 400 (the field is required now).
    const noTarget = await app.request('/public-bridge/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: steward.cookie },
      body: JSON.stringify({
        block_cid: await cidFor('block', enc.encode('x')),
        visibility: 'public',
        encrypted: false,
        private_room_cid: false,
      }),
    });
    expect(noTarget.status).toBe(400);
    const recordCid = await cidFor('record', enc.encode('a record, not a block'));
    const wrongKind = await app.request(
      STORY_BODY('/public-bridge/publish', steward.cookie, recordCid),
    );
    // The CAS holds nothing under that CID → 404 (a well-formed CID, but not a held block).
    expect(wrongKind.status).toBe(404);
  });
});
