// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.5.4/5.5 — reducer tests: the canonical total order + Lamport causality,
// the genesis bootstrap, capability enforcement (room capabilities, never a
// platform role), the §14.4 conflict policy (latest-edit-wins, moderator
// tombstone, removed-member rejection, client_draft dedup), and the centerpiece
// §14.3.3/§26.1 property — byte-identical reducer state across shuffled op-
// delivery orders.
import { describe, expect, it } from 'vitest';
import {
  canonicalOpOrder,
  compareDecimalStrings,
  lamportRespectsCausality,
  nextLamport,
} from '../reducer/order.js';
import { reduceRoom } from '../reducer/reduce.js';
import { roomStateCommitment } from '../reducer/state.js';
import { type PrivateOpBody, type PrivateRoomOp, privateRoomOpSchema } from '../schemas/ops.js';

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const KEY = 'AAAA'; // a valid base64url placeholder for op key fields

let opCounter = 0;
function mkOp(
  body: PrivateOpBody,
  fields: Partial<
    Pick<
      PrivateRoomOp,
      | 'op_id'
      | 'author_member_id'
      | 'author_device_id'
      | 'author_seq'
      | 'lamport'
      | 'parents'
      | 'created_at_bucket'
      | 'epoch'
    >
  > = {},
): PrivateRoomOp {
  const id = fields.op_id ?? `op-${++opCounter}`;
  return privateRoomOpSchema.parse({
    schema: 'licio.private.op.v1',
    room_id: 'room-1',
    epoch: fields.epoch ?? 0,
    op_id: id,
    author_member_id: fields.author_member_id ?? 'founder',
    author_device_id: fields.author_device_id ?? 'founder-dev',
    author_seq: fields.author_seq ?? 0,
    created_at: '2026-06-22T00:00:00Z',
    created_at_bucket: fields.created_at_bucket ?? '2026-06-22T00',
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

describe('order — Lamport + canonical total order (§14.3)', () => {
  it('compares decimal strings as big integers', () => {
    expect(compareDecimalStrings('9', '10')).toBeLessThan(0);
    expect(compareDecimalStrings('100', '99')).toBeGreaterThan(0);
    expect(compareDecimalStrings('42', '42')).toBe(0);
    expect(compareDecimalStrings('123456789012345678901', '123456789012345678900')).toBeGreaterThan(
      0,
    ); // beyond 2^53
  });

  it('compares by exact value, not string length (robust to leading zeros)', () => {
    // The schema (`lamportSchema`) forbids leading zeros, so `canonicalOpOrder`
    // never sees one — but the comparator's correctness must NOT depend on that.
    // A length-then-lexicographic shortcut calls these wrong; BigInt is exact.
    expect(compareDecimalStrings('007', '9')).toBeLessThan(0); // 7 < 9 (length says 3 > 1)
    expect(compareDecimalStrings('007', '7')).toBe(0); // 7 === 7
    expect(compareDecimalStrings('010', '9')).toBeGreaterThan(0); // 10 > 9
  });

  it('nextLamport = 1 + max(parents ∪ local)', () => {
    expect(nextLamport(['3', '7', '5'], '4')).toBe('8');
    expect(nextLamport([], '0')).toBe('1');
    expect(nextLamport(['99999999999999999999'], '1')).toBe('100000000000000000000');
  });

  it('enforces lamport(child) > every parent', () => {
    expect(lamportRespectsCausality('5', ['3', '4'])).toBe(true);
    expect(lamportRespectsCausality('4', ['4'])).toBe(false);
    expect(lamportRespectsCausality('2', ['3'])).toBe(false);
  });

  it('sorts by (lamport, created_at_bucket, author_device_id, op_id), order-independent', () => {
    const a = mkOp({ type: 'member.remove', member_id: 'x' }, { op_id: 'a', lamport: '2' });
    const b = mkOp({ type: 'member.remove', member_id: 'y' }, { op_id: 'b', lamport: '1' });
    const c = mkOp(
      { type: 'member.remove', member_id: 'z' },
      { op_id: 'c', lamport: '2', author_device_id: 'aaa' },
    );
    const forward = canonicalOpOrder([a, b, c]).map((o) => o.op_id);
    const shuffled = canonicalOpOrder([c, a, b]).map((o) => o.op_id);
    expect(forward).toStrictEqual(shuffled);
    expect(forward[0]).toBe('b'); // lowest lamport first
  });
});

describe('genesis + membership', () => {
  it('bootstraps the founder via the self-add genesis op', () => {
    const state = reduceRoom([genesis()]);
    expect(state.members.get('founder')?.role).toBe('admin');
    expect(state.devices.get('founder-dev')?.removed).toBe(false);
    expect(state.rejected).toHaveLength(0);
  });

  it('rejects a non-genesis first op (no authority yet)', () => {
    const story = mkOp({
      type: 'story.create',
      story_id: 's1',
      thread_id: 't1',
      title: 'x',
      submission_type: 'original_brief',
      topic_ids: [],
      submission_metadata: {},
    });
    const state = reduceRoom([story]);
    expect(state.stories.size).toBe(0);
    expect(state.rejected[0]?.reason).toBe('no_genesis_member_add');
  });

  it('an admin adds a member; the new member gets member capabilities', () => {
    const add = mkOp(
      {
        type: 'member.add',
        member_id: 'bob',
        device_id: 'bob-dev',
        signing_public_key: KEY,
        hpke_public_key: KEY,
        mls_key_package: KEY,
        granted_role: 'member',
      },
      { lamport: '2', parents: ['genesis'] },
    );
    const state = reduceRoom([genesis(), add]);
    expect(state.members.get('bob')?.role).toBe('member');
    expect([...(state.members.get('bob')?.capabilities ?? [])].sort()).toStrictEqual([
      'post',
      'read',
    ]);
  });
});

describe('capability enforcement (§11.3/§11.4 — room capabilities only)', () => {
  function withBob(role: 'member' | 'moderator') {
    return [
      genesis(),
      mkOp(
        {
          type: 'member.add',
          member_id: 'bob',
          device_id: 'bob-dev',
          signing_public_key: KEY,
          hpke_public_key: KEY,
          mls_key_package: KEY,
          granted_role: role,
        },
        { lamport: '2', parents: ['genesis'] },
      ),
    ];
  }

  it('a plain member cannot add members (needs admin)', () => {
    const bobAddsCarol = mkOp(
      {
        type: 'member.add',
        member_id: 'carol',
        device_id: 'carol-dev',
        signing_public_key: KEY,
        hpke_public_key: KEY,
        mls_key_package: KEY,
        granted_role: 'member',
      },
      { author_member_id: 'bob', author_device_id: 'bob-dev', lamport: '3', parents: ['op-x'] },
    );
    const state = reduceRoom([...withBob('member'), bobAddsCarol]);
    expect(state.members.has('carol')).toBe(false);
    expect(state.rejected.some((r) => r.reason === 'not_authorized')).toBe(true);
  });

  it('a member can post a story; a non-member cannot', () => {
    const post = mkOp(
      {
        type: 'story.create',
        story_id: 's1',
        thread_id: 't1',
        title: 'hi',
        submission_type: 'original_brief',
        topic_ids: [],
        submission_metadata: {},
      },
      { author_member_id: 'bob', author_device_id: 'bob-dev', lamport: '3' },
    );
    const ok = reduceRoom([...withBob('member'), post]);
    expect(ok.stories.has('s1')).toBe(true);

    const ghostPost = mkOp(
      {
        type: 'story.create',
        story_id: 's2',
        thread_id: 't2',
        title: 'hi',
        submission_type: 'original_brief',
        topic_ids: [],
        submission_metadata: {},
      },
      { author_member_id: 'ghost', author_device_id: 'ghost-dev', lamport: '3' },
    );
    const blocked = reduceRoom([genesis(), ghostPost]);
    expect(blocked.stories.has('s2')).toBe(false);
    expect(blocked.rejected.some((r) => r.reason === 'author_device_not_active')).toBe(true);
  });
});

describe('§14.4 conflict policy', () => {
  function base() {
    return [
      genesis(),
      mkOp(
        {
          type: 'story.create',
          story_id: 's1',
          thread_id: 't1',
          title: 'v1',
          submission_type: 'original_brief',
          topic_ids: [],
          submission_metadata: {},
        },
        { op_id: 'create-s1', lamport: '2', parents: ['genesis'] },
      ),
    ];
  }

  it('latest valid author edit wins (by total-order position)', () => {
    const edit1 = mkOp(
      { type: 'story.edit', story_id: 's1', title: 'v2' },
      { op_id: 'e1', lamport: '3' },
    );
    const edit2 = mkOp(
      { type: 'story.edit', story_id: 's1', title: 'v3' },
      { op_id: 'e2', lamport: '4' },
    );
    const state = reduceRoom([...base(), edit2, edit1]); // delivered out of order
    expect(state.stories.get('s1')?.title).toBe('v3'); // highest lamport wins
    expect(state.stories.get('s1')?.editCount).toBe(2);
  });

  it('moderator tombstone hides display; edit history retained', () => {
    const tombstone = mkOp({ type: 'story.tombstone', story_id: 's1' }, { lamport: '3' });
    const state = reduceRoom([...base(), tombstone]);
    expect(state.stories.get('s1')?.tombstoned).toBe(true);
  });

  it('ops by a removed member are rejected', () => {
    const addBob = mkOp(
      {
        type: 'member.add',
        member_id: 'bob',
        device_id: 'bob-dev',
        signing_public_key: KEY,
        hpke_public_key: KEY,
        mls_key_package: KEY,
        granted_role: 'member',
      },
      { lamport: '2', parents: ['genesis'] },
    );
    const removeBob = mkOp({ type: 'member.remove', member_id: 'bob' }, { lamport: '3' });
    const bobPostsAfter = mkOp(
      {
        type: 'story.create',
        story_id: 'sx',
        thread_id: 'tx',
        title: 'late',
        submission_type: 'original_brief',
        topic_ids: [],
        submission_metadata: {},
      },
      { author_member_id: 'bob', author_device_id: 'bob-dev', lamport: '4' },
    );
    const state = reduceRoom([genesis(), addBob, removeBob, bobPostsAfter]);
    expect(state.members.get('bob')?.removed).toBe(true);
    expect(state.stories.has('sx')).toBe(false);
    // member.remove also removes the member's devices, so the post is rejected at
    // the device-active check (the more specific of the two removal reasons).
    expect(
      state.rejected.some(
        (r) => r.reason === 'author_device_not_active' || r.reason === 'author_member_removed',
      ),
    ).toBe(true);
  });

  it('same client_draft_id is idempotently deduped', () => {
    const draft = {
      type: 'contribution.create' as const,
      contribution_id: 'c1',
      thread_id: 't1',
      contribution_type: 'comment' as const,
      body_markdown_lite: 'hello',
      citations: [],
      metadata: {},
      client_draft_id: 'draft-1',
    };
    const first = mkOp(draft, { op_id: 'cc1', lamport: '3' });
    const dup = mkOp({ ...draft, contribution_id: 'c2' }, { op_id: 'cc2', lamport: '4' });
    const state = reduceRoom([...base(), first, dup]);
    expect(state.contributions.has('c1')).toBe(true);
    expect(state.contributions.has('c2')).toBe(false); // deduped by client_draft_id
  });

  it('a contribution with a missing parent is rejected (orphan)', () => {
    const orphan = mkOp(
      {
        type: 'contribution.create',
        contribution_id: 'c1',
        thread_id: 't1',
        contribution_type: 'comment',
        body_markdown_lite: 'reply',
        citations: [],
        metadata: {},
        parent_contribution_id: 'does-not-exist',
        client_draft_id: 'd',
      },
      { lamport: '3' },
    );
    const state = reduceRoom([...base(), orphan]);
    expect(state.contributions.has('c1')).toBe(false);
    expect(state.rejected.some((r) => r.reason === 'parent_contribution_missing')).toBe(true);
  });
});

describe('WS-S.5.3c reducer hardening (integrity)', () => {
  function storyBase() {
    return [
      genesis(),
      mkOp(
        {
          type: 'story.create',
          story_id: 's1',
          thread_id: 't1',
          title: 'v1',
          submission_type: 'original_brief',
          topic_ids: [],
          submission_metadata: {},
        },
        { op_id: 'create-s1', lamport: '2', parents: ['genesis'] },
      ),
    ];
  }

  it('rejects a story.create that reuses another story’s thread (one story per thread)', () => {
    const reuse = mkOp(
      {
        type: 'story.create',
        story_id: 's2',
        thread_id: 't1', // already owned by s1
        title: 'reuse',
        submission_type: 'original_brief',
        topic_ids: [],
        submission_metadata: {},
      },
      { op_id: 'create-s2', lamport: '3' },
    );
    const state = reduceRoom([...storyBase(), reuse]);
    expect(state.stories.has('s2')).toBe(false);
    expect(state.stories.get('s1')?.threadId).toBe('t1');
    expect(state.rejected.some((r) => r.reason === 'thread_already_in_use')).toBe(true);
  });

  it('rejects a contribution.create for a thread that does not exist (orphan thread)', () => {
    const orphan = mkOp(
      {
        type: 'contribution.create',
        contribution_id: 'c1',
        thread_id: 't-missing',
        contribution_type: 'comment',
        body_markdown_lite: 'hi',
        citations: [],
        metadata: {},
        client_draft_id: 'd1',
      },
      { lamport: '2', parents: ['genesis'] },
    );
    const state = reduceRoom([genesis(), orphan]);
    expect(state.contributions.has('c1')).toBe(false);
    expect(state.rejected.some((r) => r.reason === 'thread_missing')).toBe(true);
  });

  it('enforces the per-type body cap on edit, against the type recorded in state', () => {
    const create = mkOp(
      {
        type: 'contribution.create',
        contribution_id: 'c1',
        thread_id: 't1',
        contribution_type: 'question', // cap 2000
        body_markdown_lite: 'short question?',
        citations: [],
        metadata: {},
        client_draft_id: 'd1',
      },
      { op_id: 'cc1', lamport: '3', parents: ['create-s1'] },
    );
    // The edit op schema permits up to comment's 5000-char cap; the reducer must
    // reject against question's 2000-char cap (the type is not on the edit op).
    const oversized = mkOp(
      { type: 'contribution.edit', contribution_id: 'c1', body_markdown_lite: 'x'.repeat(3_000) },
      { op_id: 'ce1', lamport: '4' },
    );
    const state = reduceRoom([...storyBase(), create, oversized]);
    expect(state.contributions.get('c1')?.bodyMarkdownLite).toBe('short question?');
    expect(state.contributions.get('c1')?.editCount).toBe(0);
    expect(state.rejected.some((r) => r.reason === 'body_too_long')).toBe(true);
  });

  it('applies a within-cap edit of the same type', () => {
    const create = mkOp(
      {
        type: 'contribution.create',
        contribution_id: 'c1',
        thread_id: 't1',
        contribution_type: 'question',
        body_markdown_lite: 'q',
        citations: [],
        metadata: {},
        client_draft_id: 'd1',
      },
      { op_id: 'cc1', lamport: '3', parents: ['create-s1'] },
    );
    const okEdit = mkOp(
      { type: 'contribution.edit', contribution_id: 'c1', body_markdown_lite: 'y'.repeat(1_999) },
      { op_id: 'ce1', lamport: '4' },
    );
    const state = reduceRoom([...storyBase(), create, okEdit]);
    expect(state.contributions.get('c1')?.bodyMarkdownLite).toBe('y'.repeat(1_999));
    expect(state.contributions.get('c1')?.editCount).toBe(1);
  });

  it('re-admits a previously-removed member (clears removed, restores caps)', () => {
    const addBob = mkOp(
      {
        type: 'member.add',
        member_id: 'bob',
        device_id: 'bob-dev',
        signing_public_key: KEY,
        hpke_public_key: KEY,
        mls_key_package: KEY,
        granted_role: 'member',
      },
      { op_id: 'add-bob', lamport: '2', parents: ['genesis'] },
    );
    const removeBob = mkOp(
      { type: 'member.remove', member_id: 'bob' },
      { op_id: 'rm-bob', lamport: '3' },
    );
    const readd = mkOp(
      {
        type: 'member.add',
        member_id: 'bob',
        device_id: 'bob-dev-2',
        signing_public_key: KEY,
        hpke_public_key: KEY,
        mls_key_package: KEY,
        granted_role: 'member',
      },
      { op_id: 'readd-bob', lamport: '4' },
    );
    const bobPosts = mkOp(
      {
        type: 'story.create',
        story_id: 'sb',
        thread_id: 'tb',
        title: 'back',
        submission_type: 'original_brief',
        topic_ids: [],
        submission_metadata: {},
      },
      {
        op_id: 'bob-story',
        author_member_id: 'bob',
        author_device_id: 'bob-dev-2',
        author_seq: 0,
        lamport: '5',
      },
    );
    const state = reduceRoom([genesis(), addBob, removeBob, readd, bobPosts]);
    expect(state.members.get('bob')?.removed).toBe(false);
    expect(state.devices.get('bob-dev-2')?.removed).toBe(false);
    expect(state.stories.has('sb')).toBe(true); // the re-admitted member can post again
  });
});

describe('§14.3.3 / §26.1 determinism — byte-identical state across shuffled orders', () => {
  function buildDag(): PrivateRoomOp[] {
    const ops: PrivateRoomOp[] = [genesis()];
    ops.push(
      mkOp(
        {
          type: 'member.add',
          member_id: 'bob',
          device_id: 'bob-dev',
          signing_public_key: KEY,
          hpke_public_key: KEY,
          mls_key_package: KEY,
          granted_role: 'moderator',
        },
        { op_id: 'add-bob', lamport: '2', parents: ['genesis'] },
      ),
    );
    ops.push(
      mkOp(
        {
          type: 'story.create',
          story_id: 's1',
          thread_id: 't1',
          title: 'v1',
          submission_type: 'original_brief',
          topic_ids: ['topic-a'],
          submission_metadata: {},
        },
        { op_id: 'cs1', lamport: '3', parents: ['add-bob'] },
      ),
    );
    // concurrent edits (same lamport) by different authors — ties broken by order
    ops.push(
      mkOp(
        { type: 'story.edit', story_id: 's1', title: 'from-founder' },
        { op_id: 'e-f', lamport: '5', parents: ['cs1'] },
      ),
    );
    ops.push(
      mkOp(
        { type: 'story.edit', story_id: 's1', title: 'from-bob' },
        {
          op_id: 'e-b',
          author_member_id: 'bob',
          author_device_id: 'bob-dev',
          lamport: '5',
          parents: ['cs1'],
        },
      ),
    );
    ops.push(
      mkOp(
        {
          type: 'contribution.create',
          contribution_id: 'c1',
          thread_id: 't1',
          contribution_type: 'comment',
          body_markdown_lite: 'nice',
          citations: [],
          metadata: {},
          client_draft_id: 'd1',
        },
        {
          op_id: 'cc1',
          author_member_id: 'bob',
          author_device_id: 'bob-dev',
          lamport: '6',
          parents: ['cs1'],
        },
      ),
    );
    ops.push(
      mkOp(
        { type: 'story.tombstone', story_id: 's1' },
        {
          op_id: 'ts',
          author_member_id: 'bob',
          author_device_id: 'bob-dev',
          lamport: '7',
          parents: ['e-f', 'e-b'],
        },
      ),
    );
    return ops;
  }

  function shuffle<T>(arr: T[], seed: number): T[] {
    const out = arr.slice();
    let s = seed;
    for (let i = out.length - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const j = s % (i + 1);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }

  it('produces a byte-identical commitment across many shuffles', () => {
    const ops = buildDag();
    const canonicalCommitment = toHex(roomStateCommitment(reduceRoom(ops)));
    for (let seed = 1; seed <= 25; seed++) {
      const shuffled = shuffle(ops, seed);
      expect(toHex(roomStateCommitment(reduceRoom(shuffled)))).toBe(canonicalCommitment);
    }
  });

  it('the concurrent-edit tie is resolved deterministically (by op_id)', () => {
    // e-b and e-f share lamport 5 + bucket; the tiebreak is author_device_id then
    // op_id. "bob-dev" < "founder-dev", so e-b (bob) sorts BEFORE e-f (founder) →
    // founder's edit is later → "from-founder" wins.
    const state = reduceRoom(buildDag());
    expect(state.stories.get('s1')?.title).toBe('from-founder');
    expect(state.stories.get('s1')?.tombstoned).toBe(true);
  });
});
