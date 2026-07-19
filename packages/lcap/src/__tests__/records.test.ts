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
    // Same device: seq 0 has a LATER claimed timestamp than seq 1 (clock skew).
    const seq0 = tr(
      'r-0',
      mkRecord({ event_type: 'post', device_seq: 0, created_at_claim_ms: 9000 }),
    );
    const seq1 = tr(
      'r-1',
      mkRecord({ event_type: 'answer', device_seq: 1, created_at_claim_ms: 1000 }),
    );
    expect(displayOrder([seq1, seq0]).map((r) => r.recordCid)).toEqual(['r-0', 'r-1']);
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
