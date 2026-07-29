// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.2 — event records and the record graph: the WS-G/WS-Q visibility mapping,
// the append-only edit/tombstone projection (arrival-order independent), the
// §12.4 display-ordering precedence ladder (clock-skew resistant), and
// device-fork detection.

import { beforeAll, describe, expect, it } from 'vitest';
import { cidFor } from '../cid/index.js';
import { defaultLane } from '../priority.js';
import {
  buildDeviceForkEvidence,
  DeviceForkDetector,
  displayOrder,
  forkEvidencePriority,
  mapLcapVisibilityToStory,
  mapStoryVisibilityToLcap,
  operationForEventType,
  reduceThreadProjection,
  type ThreadRecord,
} from '../records/index.js';
import type { ContributionEventRecordV2 } from '../schemas/records.js';

function mkRecord(
  over: Partial<ContributionEventRecordV2> & {
    event_type: ContributionEventRecordV2['event_type'];
  },
): ContributionEventRecordV2 {
  return {
    record_version: 2,
    kind: 'contribution_event',
    home_room_id: 'room-1',
    visibility_scope: 'public',
    author_account_id: 'acct-1',
    author_device_id: 'dev-1',
    author_device_key_id: 'key-1',
    device_seq: 0,
    capability_cid: 'cap-cid',
    policy_epoch_claim: 0,
    revocation_epoch_claim: 0,
    client_nonce: new Uint8Array([0]),
    priority: 1,
    ...over,
  };
}

function tr(
  recordCid: string,
  record: ContributionEventRecordV2,
  hints: Partial<ThreadRecord> = {},
): ThreadRecord {
  return { recordCid, record, ...hints };
}

describe('contribution mapping (WS-R.2.1)', () => {
  it('maps every event type to its capability operation', () => {
    expect(operationForEventType('post')).toBe('post');
    expect(operationForEventType('question')).toBe('post');
    expect(operationForEventType('answer')).toBe('reply');
    expect(operationForEventType('edit')).toBe('edit');
    expect(operationForEventType('tombstone')).toBe('tombstone');
    expect(operationForEventType('moderation_action')).toBe('moderate');
    expect(operationForEventType('source_snapshot_ref')).toBe('source_snapshot');
  });

  it('translates visibility totally and round-trips public/room_only', () => {
    expect(mapLcapVisibilityToStory('public')).toBe('public');
    expect(mapLcapVisibilityToStory('in_room')).toBe('room_only');
    expect(mapLcapVisibilityToStory('private')).toBeNull(); // never a server story
    expect(mapStoryVisibilityToLcap('public')).toBe('public');
    expect(mapStoryVisibilityToLcap('room_only')).toBe('in_room');
    // round-trip S → L → S
    for (const v of ['public', 'room_only'] as const) {
      expect(mapLcapVisibilityToStory(mapStoryVisibilityToLcap(v))).toBe(v);
    }
  });
});

describe('thread projection (WS-R.2.2)', () => {
  const post = tr('r-o', mkRecord({ event_type: 'post', device_seq: 0 }));
  const edit1 = tr(
    'r-e1',
    mkRecord({ event_type: 'edit', device_seq: 1, replaces_record_cid: 'r-o' }),
  );
  const edit2 = tr(
    'r-e2',
    mkRecord({ event_type: 'edit', device_seq: 2, replaces_record_cid: 'r-e1' }),
  );
  const tomb = tr(
    'r-t',
    mkRecord({ event_type: 'tombstone', device_seq: 3, target_record_cid: 'r-e2' }),
  );

  it('resolves the edit chain to the latest visible tip', () => {
    const projected = reduceThreadProjection([post, edit1, edit2]);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ rootCid: 'r-o', visibleCid: 'r-e2', hidden: false });
    expect(projected[0]?.editChain).toEqual(['r-o', 'r-e1', 'r-e2']);
  });

  it('hides a tombstoned contribution but retains its chain', () => {
    const projected = reduceThreadProjection([post, edit1, edit2, tomb]);
    expect(projected[0]).toMatchObject({ rootCid: 'r-o', hidden: true, hiddenBy: 'r-t' });
  });

  it('picks the canonically-latest edit under §12.4, not the higher device_seq', () => {
    // Two conflicting edits of the SAME target, authored by DIFFERENT devices.
    // The stale one carries a higher local device_seq; the fresh one carries the
    // higher room-log sequence (§12.4 rung #1).  device_seq is meaningless across
    // devices, so the room-log-ordered edit must win — the stale high-seq edit
    // must NOT surface as the visible tip.
    const base = tr('t-o', mkRecord({ event_type: 'post', device_seq: 0 }));
    const staleHighSeq = tr(
      't-stale',
      mkRecord({
        event_type: 'edit',
        author_device_key_id: 'dev-A',
        device_seq: 99,
        replaces_record_cid: 't-o',
      }),
      { roomLogSeq: 1 },
    );
    const freshLowSeq = tr(
      't-fresh',
      mkRecord({
        event_type: 'edit',
        author_device_key_id: 'dev-B',
        device_seq: 1,
        replaces_record_cid: 't-o',
      }),
      { roomLogSeq: 2 },
    );
    const projected = reduceThreadProjection([base, staleHighSeq, freshLowSeq]);
    expect(projected).toHaveLength(1);
    expect(projected[0]?.visibleCid).toBe('t-fresh');
  });

  it('refuses a cross-author edit and keeps it inspectable (never the visible tip)', () => {
    // `edit` authorizes acting on one's OWN contribution; superseding another
    // member's requires `moderate`, i.e. a `moderation_action`.  The hostile edit
    // carries the higher room-log seq, so only the ownership gate stops it winning.
    const victim = tr('x-post', mkRecord({ event_type: 'post' }), { roomLogSeq: 0 });
    const hostile = tr(
      'x-edit',
      mkRecord({
        event_type: 'edit',
        author_account_id: 'attacker',
        author_device_key_id: 'attacker-key',
        replaces_record_cid: 'x-post',
      }),
      { roomLogSeq: 5 },
    );
    const projected = reduceThreadProjection([victim, hostile]);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ rootCid: 'x-post', visibleCid: 'x-post' });
    expect(projected[0]?.editChain).toEqual(['x-post']);
    expect(projected[0]?.unauthorizedSupersedes).toEqual(['x-edit']);
  });

  it('keeps refusal evidence aimed at the branch the projection did NOT pick', () => {
    // Two competing AUTHORIZED edits fork the record; `pickLatestEdit` selects
    // one, so the loser's CID is absent from `editChain`.  A hostile
    // cross-author edit aimed at that loser used to vanish from
    // `unauthorizedSupersedes` entirely — the evidence disappeared for exactly
    // the conflict case the field exists to expose.
    const base = tr('b-post', mkRecord({ event_type: 'post' }), { roomLogSeq: 0 });
    const branchA = tr(
      'b-a',
      mkRecord({ event_type: 'edit', device_seq: 1, replaces_record_cid: 'b-post' }),
      { roomLogSeq: 1 },
    );
    const branchB = tr(
      'b-b',
      mkRecord({
        event_type: 'edit',
        author_device_key_id: 'dev-B',
        device_seq: 1,
        replaces_record_cid: 'b-post',
      }),
      { roomLogSeq: 2 },
    );
    const hostile = tr(
      'b-hostile',
      mkRecord({
        event_type: 'edit',
        author_account_id: 'attacker',
        author_device_key_id: 'attacker-key',
        // Aimed at whichever branch loses below — both are asserted.
        replaces_record_cid: 'b-a',
      }),
      { roomLogSeq: 9 },
    );
    const projected = reduceThreadProjection([base, branchA, branchB, hostile]);
    expect(projected).toHaveLength(1);
    const visible = projected[0]?.visibleCid;
    // The refusal is retained WHICHEVER branch the projection selected — when
    // it picks `b-a` the target is on the chain, and when it picks `b-b` it is
    // not, and that second case is the one that used to lose the evidence.
    expect(projected[0]?.unauthorizedSupersedes).toEqual(['b-hostile']);
    expect(['b-a', 'b-b']).toContain(visible);
  });

  it('refuses a cross-author tombstone but honours a moderation_action', () => {
    const victim = tr('y-post', mkRecord({ event_type: 'post' }));
    const hostileTomb = tr(
      'y-tomb',
      mkRecord({
        event_type: 'tombstone',
        author_account_id: 'attacker',
        target_record_cid: 'y-post',
      }),
    );
    const notHidden = reduceThreadProjection([victim, hostileTomb]);
    expect(notHidden[0]).toMatchObject({ hidden: false });
    expect(notHidden[0]?.unauthorizedSupersedes).toEqual(['y-tomb']);

    const moderation = tr(
      'y-mod',
      mkRecord({
        event_type: 'moderation_action',
        author_account_id: 'moderator',
        target_record_cid: 'y-post',
      }),
    );
    expect(reduceThreadProjection([victim, moderation])[0]).toMatchObject({
      hidden: true,
      hiddenBy: 'y-mod',
    });
  });

  it("still applies an edit made from the author's SECOND device", () => {
    // Ownership is per ACCOUNT, not per device key — a member editing from another
    // of their own devices must keep working.
    const post = tr('z-post', mkRecord({ event_type: 'post', author_device_key_id: 'key-a' }));
    const fromOtherDevice = tr(
      'z-edit',
      mkRecord({
        event_type: 'edit',
        author_device_id: 'dev-2',
        author_device_key_id: 'key-b',
        replaces_record_cid: 'z-post',
      }),
    );
    const projected = reduceThreadProjection([post, fromOtherDevice]);
    expect(projected[0]?.visibleCid).toBe('z-edit');
    expect(projected[0]?.unauthorizedSupersedes).toBeUndefined();
  });

  it('is independent of record arrival order (property)', () => {
    const records = [post, edit1, edit2, tomb];
    const reference = JSON.stringify(
      reduceThreadProjection(records).map((p) => p.visibleCid + p.hidden),
    );
    const permutations = [
      [tomb, edit2, edit1, post],
      [edit2, post, tomb, edit1],
      [edit1, tomb, post, edit2],
    ];
    for (const perm of permutations) {
      expect(JSON.stringify(reduceThreadProjection(perm).map((p) => p.visibleCid + p.hidden))).toBe(
        reference,
      );
    }
  });
});

describe('display ordering (WS-R.2.3)', () => {
  it('prefers room-log sequence where present', () => {
    const a = tr('r-a', mkRecord({ event_type: 'post', device_seq: 9 }), { roomLogSeq: 1 });
    const b = tr('r-b', mkRecord({ event_type: 'post', device_seq: 0 }), { roomLogSeq: 0 });
    expect(displayOrder([a, b]).map((r) => r.recordCid)).toEqual(['r-b', 'r-a']);
  });

  it('does not let a skewed clock reorder sequence-ordered records', () => {
    // Same device: seq 0 has a LATER claimed timestamp than seq 1 (clock skew).  The
    // §12.2 device chain (prev_device_record_cid) orders them via the topological pass,
    // not the (now clock-driven) comparator.
    const seq0 = tr(
      'r-0',
      mkRecord({ event_type: 'post', device_seq: 0, created_at_claim_ms: 9000 }),
    );
    const seq1 = tr(
      'r-1',
      mkRecord({
        event_type: 'answer',
        device_seq: 1,
        created_at_claim_ms: 1000,
        prev_device_record_cid: 'r-0',
      }),
    );
    expect(displayOrder([seq1, seq0]).map((r) => r.recordCid)).toEqual(['r-0', 'r-1']);
  });

  it('ignores an unverified prev_device_record_cid (cross-device / wrong-seq forgery)', () => {
    // An author points prev_device_record_cid at a VICTIM's record to force its own
    // content after it.  The edge is honored ONLY for a verified same-device seq-1
    // predecessor, so a cross-device (or wrong-seq) pointer is ignored and the §12.4
    // ladder (here receiptMs) orders instead — the forgery cannot jump the order.
    const victim = tr('r-v', mkRecord({ event_type: 'post', device_seq: 0 }), { receiptMs: 100 });
    const crossDevice = tr(
      'r-x',
      mkRecord({
        event_type: 'post',
        author_device_key_id: 'key-attacker', // different device
        device_seq: 5,
        prev_device_record_cid: 'r-v',
      }),
      { receiptMs: 50 },
    );
    // receiptMs 50 < 100 ⇒ the attacker sorts FIRST; the forged edge did NOT force it
    // after the victim (which it would have, had the edge been honored).
    expect(displayOrder([victim, crossDevice]).map((r) => r.recordCid)).toEqual(['r-x', 'r-v']);
    // Same device but a non-adjacent sequence (must be exactly prev + 1) is ignored too.
    const wrongSeq = tr(
      'r-ws',
      mkRecord({ event_type: 'post', device_seq: 9, prev_device_record_cid: 'r-v' }),
      { receiptMs: 40 },
    );
    expect(displayOrder([victim, wrongSeq]).map((r) => r.recordCid)).toEqual(['r-ws', 'r-v']);
  });

  it('stays deterministic when same-device seq order contradicts cross-device claim order', () => {
    // The old CONDITIONAL device-seq rung made a 3-cycle: A<B (same device, seq), but
    // B<C and C<A by claim — so Array.sort output depended on input order.  With device
    // order in the topological pass and a pure total-order comparator, every input
    // permutation yields the identical projection.
    const a = tr('A', mkRecord({ event_type: 'post', device_seq: 1, created_at_claim_ms: 600000 }));
    const b = tr(
      'B',
      mkRecord({
        event_type: 'answer',
        device_seq: 2,
        created_at_claim_ms: 540000,
        prev_device_record_cid: 'A',
      }),
    );
    const c = tr(
      'C',
      mkRecord({
        event_type: 'answer',
        device_seq: 0,
        author_device_key_id: 'other-device',
        created_at_claim_ms: 570000,
      }),
    );
    const canonical = displayOrder([a, b, c]).map((r) => r.recordCid);
    for (const perm of [
      [b, a, c],
      [c, b, a],
      [c, a, b],
      [b, c, a],
      [a, c, b],
    ]) {
      expect(displayOrder(perm).map((r) => r.recordCid)).toEqual(canonical);
    }
    // A precedes B (its device-chain successor) regardless of the skewed claim.
    expect(canonical.indexOf('A')).toBeLessThan(canonical.indexOf('B'));
  });

  it('orders one-sided weak hints transitively + deterministically (input-order-independent)', () => {
    // A weak hint present on only one side must yield a TOTAL order
    // (present-before-absent), NOT a tie-then-CID rule — the latter is
    // non-transitive (A>B, B>C by CID while A<C by value) and would make
    // displayOrder depend on input order.  Different devices, no
    // room-log/checkpoint, so the ladder reaches the claim rung.
    const a = tr(
      'r-zzz',
      mkRecord({ event_type: 'post', author_device_key_id: 'k1', created_at_claim_ms: 1000 }),
    );
    const b = tr('r-mmm', mkRecord({ event_type: 'post', author_device_key_id: 'k2' })); // no claim
    const c = tr(
      'r-aaa',
      mkRecord({ event_type: 'post', author_device_key_id: 'k3', created_at_claim_ms: 2000 }),
    );
    // claim 1000 < claim 2000 < no-claim (present before absent).
    const expected = ['r-zzz', 'r-aaa', 'r-mmm'];
    for (const perm of [
      [a, b, c],
      [c, a, b],
      [b, c, a],
      [a, c, b],
      [c, b, a],
      [b, a, c],
    ]) {
      expect(displayOrder(perm).map((r) => r.recordCid)).toEqual(expected);
    }
  });

  it('places a causal parent before its child regardless of other hints', () => {
    const parent = tr(
      'r-p',
      mkRecord({ event_type: 'post', author_device_key_id: 'key-1', device_seq: 5 }),
    );
    const child = tr(
      'r-c',
      mkRecord({
        event_type: 'answer',
        author_device_key_id: 'key-2',
        device_seq: 0,
        parent_record_cids: ['r-p'],
      }),
    );
    expect(displayOrder([child, parent]).map((r) => r.recordCid)).toEqual(['r-p', 'r-c']);
  });
});

describe('device-fork detection (WS-R.2.4)', () => {
  let cidA: string;
  let cidB: string;

  beforeAll(async () => {
    cidA = await cidFor('record', new Uint8Array([1]));
    cidB = await cidFor('record', new Uint8Array([2]));
  });

  it('discriminates a fork from an idempotent re-submission', () => {
    const detector = new DeviceForkDetector();
    expect(detector.observe('key-1', 0, cidA)).toBeUndefined(); // first sighting
    expect(detector.observe('key-1', 0, cidA)).toBeUndefined(); // idempotent
    const fork = detector.observe('key-1', 0, cidB);
    expect(fork).toBeDefined();
    expect(fork).toMatchObject({ deviceKeyId: 'key-1', deviceSeq: 0 });
    // CIDs are sorted deterministically.
    const [lo, hi] = cidA < cidB ? [cidA, cidB] : [cidB, cidA];
    expect(fork).toMatchObject({ objectCidA: lo, objectCidB: hi });
  });

  it('builds P0/C0 fork evidence from an observation', () => {
    const detector = new DeviceForkDetector();
    detector.observe('key-1', 7, cidA);
    const fork = detector.observe('key-1', 7, cidB);
    if (!fork) throw new Error('expected a fork');
    const evidence = buildDeviceForkEvidence({ observation: fork, observedContext: 'relay' });
    expect(evidence).toMatchObject({
      kind: 'fork_evidence',
      fork_kind: 'device_sequence',
      device_key_id: 'key-1',
      device_seq: 7,
      observed_context: 'relay',
    });
    expect(defaultLane(forkEvidencePriority())).toBe('C0');
  });
});
