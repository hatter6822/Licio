// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.5.6 — snapshot tests (PRIVATE_SPEC §14.5, §25.6): the state-root is a
// deterministic commitment over the reduced state (order-independent, like the
// reducer itself); `verifySnapshotRoot` accepts ONLY a byte-matching root and
// rejects a forged/stale one (a snapshot is never authority on its own); the
// §25.6 cadence predicate fires on the documented triggers; and history is
// retained by default (compaction needs room policy + member agreement).
import { describe, expect, it } from 'vitest';
import { reduceRoom } from '../reducer/reduce.js';
import {
  computeStateRoot,
  mayCompactHistory,
  SNAPSHOT_CADENCE,
  shouldCreateSnapshot,
  verifySnapshotRoot,
} from '../reducer/snapshot.js';
import { type PrivateOpBody, type PrivateRoomOp, privateRoomOpSchema } from '../schemas/ops.js';

const KEY = 'AAAA';
let n = 0;
function mkOp(
  body: PrivateOpBody,
  fields: {
    op_id?: string;
    author_member_id?: string;
    author_device_id?: string;
    author_seq?: number;
    lamport?: string;
    parents?: string[];
  } = {},
): PrivateRoomOp {
  return privateRoomOpSchema.parse({
    schema: 'licio.private.op.v1',
    room_id: 'room-1',
    epoch: 0,
    op_id: fields.op_id ?? `op-${++n}`,
    author_member_id: fields.author_member_id ?? 'founder',
    author_device_id: fields.author_device_id ?? 'founder-dev',
    author_seq: fields.author_seq ?? 0,
    created_at: '2026-06-22T00:00:00Z',
    created_at_bucket: '2026-06-22T00',
    lamport: fields.lamport ?? '1',
    parents: fields.parents ?? [],
    body,
  });
}

function genesis(): PrivateRoomOp {
  return mkOp(
    {
      type: 'member.add',
      member_id: 'founder',
      device_id: 'founder-dev',
      signing_public_key: KEY,
      hpke_public_key: KEY,
      mls_key_package: KEY,
      granted_role: 'admin',
    },
    { op_id: 'genesis', lamport: '1' },
  );
}

function story(id: string, title: string, lamport: string): PrivateRoomOp {
  return mkOp(
    {
      type: 'story.create',
      story_id: id,
      thread_id: `t-${id}`,
      title,
      submission_type: 'original_brief',
      topic_ids: [],
      submission_metadata: {},
    },
    { op_id: `cs-${id}`, lamport, parents: ['genesis'] },
  );
}

function shuffle<T>(arr: readonly T[], seed: number): T[] {
  const out = arr.slice();
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

describe('SNAPSHOT_CADENCE', () => {
  it('pins the §25.6 thresholds', () => {
    expect(SNAPSHOT_CADENCE.everyOps).toBe(1000);
    expect(SNAPSHOT_CADENCE.everyMs).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('computeStateRoot — deterministic state commitment', () => {
  it('equal logical state ⇒ equal root, regardless of op-delivery order', async () => {
    const ops = [genesis(), story('s1', 'Alpha', '2'), story('s2', 'Beta', '3')];
    const root = await computeStateRoot(ops);
    expect(root.length).toBeGreaterThan(0);
    for (let seed = 1; seed <= 8; seed++) {
      // The set is the same, so the recomputed root must byte-match.
      expect(await computeStateRoot(shuffle(ops, seed))).toBe(root);
    }
  });

  it('different state ⇒ different root', async () => {
    const a = await computeStateRoot([genesis(), story('s1', 'Alpha', '2')]);
    const b = await computeStateRoot([genesis(), story('s1', 'CHANGED', '2')]);
    expect(a).not.toBe(b);
  });
});

describe('verifySnapshotRoot — verify-before-use (§14.5)', () => {
  it('accepts a root recomputed from the covered ops', async () => {
    const ops = [genesis(), story('s1', 'Alpha', '2')];
    const declared = await computeStateRoot(ops);
    expect(await verifySnapshotRoot(declared, ops)).toBe(true);
    // Order-independence carries through verification.
    expect(await verifySnapshotRoot(declared, shuffle(ops, 5))).toBe(true);
  });

  it('rejects a forged root (never trusts the snapshot body on its own)', async () => {
    const ops = [genesis(), story('s1', 'Alpha', '2')];
    expect(await verifySnapshotRoot('not-the-real-root', ops)).toBe(false);
  });

  it('rejects a STALE root once the covered set changes', async () => {
    const ops = [genesis(), story('s1', 'Alpha', '2')];
    const stale = await computeStateRoot(ops);
    const grown = [...ops, story('s2', 'Beta', '3')];
    // A stale root must not validate against the grown covered set.
    expect(await verifySnapshotRoot(stale, grown)).toBe(false);
    // …and the freshly-computed root for the grown set DOES validate.
    expect(await verifySnapshotRoot(await computeStateRoot(grown), grown)).toBe(true);
  });
});

describe('shouldCreateSnapshot — §25.6 cadence', () => {
  it('does NOT snapshot below thresholds with no special trigger', () => {
    expect(shouldCreateSnapshot({ opsSinceLastSnapshot: 10, msSinceLastSnapshot: 1000 })).toBe(
      false,
    );
  });

  it('fires at the op-count threshold', () => {
    expect(
      shouldCreateSnapshot({
        opsSinceLastSnapshot: SNAPSHOT_CADENCE.everyOps,
        msSinceLastSnapshot: 0,
      }),
    ).toBe(true);
  });

  it('fires at the time-window threshold', () => {
    expect(
      shouldCreateSnapshot({
        opsSinceLastSnapshot: 0,
        msSinceLastSnapshot: SNAPSHOT_CADENCE.everyMs,
      }),
    ).toBe(true);
  });

  it('fires after a large import, membership churn, or a manual request', () => {
    const base = { opsSinceLastSnapshot: 0, msSinceLastSnapshot: 0 };
    expect(shouldCreateSnapshot({ ...base, afterLargeImport: true })).toBe(true);
    expect(shouldCreateSnapshot({ ...base, afterMembershipChurn: true })).toBe(true);
    expect(shouldCreateSnapshot({ ...base, manual: true })).toBe(true);
  });
});

describe('mayCompactHistory — retained by default (§14.5)', () => {
  it('refuses compaction when the room policy forbids it', () => {
    expect(mayCompactHistory(false, 100, 1)).toBe(false);
  });

  it('refuses compaction without enough agreeing members', () => {
    expect(mayCompactHistory(true, 1, 3)).toBe(false);
  });

  it('allows compaction only with policy + a met agreement threshold', () => {
    expect(mayCompactHistory(true, 3, 3)).toBe(true);
    expect(mayCompactHistory(true, 5, 3)).toBe(true);
  });

  it('a zero agreement threshold can never authorize compaction', () => {
    expect(mayCompactHistory(true, 0, 0)).toBe(false);
  });
});

describe('snapshot integration — a snapshot.commit op enters state, but the root still re-verifies', () => {
  it('an admin snapshot.commit is recorded; a verified root matches the covered ops', async () => {
    const ops = [genesis(), story('s1', 'Alpha', '2')];
    const root = await computeStateRoot(ops);
    const commit = mkOp(
      {
        type: 'snapshot.commit',
        snapshot_id: 'snap-1',
        includes_ops_up_to: ['cs-s1'],
        state_merkle_root: root,
        snapshot_body_cid: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
      },
      { op_id: 'snap-op', lamport: '3', parents: ['cs-s1'] },
    );
    const state = reduceRoom([...ops, commit]);
    expect(state.snapshots).toContain('snap-1');
    // The committed root re-verifies against the ops it covers.
    expect(await verifySnapshotRoot(root, ops)).toBe(true);
  });
});
