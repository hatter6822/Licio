// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.5.8 — local-only encrypted search tests (PRIVATE_SPEC §13.7, §18.1,
// §25.7): tokenization (lowercase, non-alphanumeric split, NFC fold, dedupe);
// the index built ENTIRELY over decrypted reduced state (titles + bodies);
// AND-semantics query with a deterministic sort; supplementary citation/alt-text
// indexing; and the at-rest shard AEAD (round-trip, wrong-key rejection, short-
// input rejection, and ciphertext ≠ plaintext — the index is encrypted at rest).
import { describe, expect, it } from 'vitest';
import { randomBytes } from '../crypto/runtime.js';
import { reduceRoom } from '../reducer/reduce.js';
import {
  buildSearchIndex,
  decryptSearchShard,
  encryptSearchShard,
  indexExtraText,
  SEARCH_INDEX_KINDS,
  searchLocal,
  tokenize,
} from '../reducer/search.js';
import { type PrivateOpBody, type PrivateRoomOp, privateRoomOpSchema } from '../schemas/ops.js';

const KEY = 'AAAA';
let n = 0;
function mkOp(
  body: PrivateOpBody,
  fields: {
    op_id?: string;
    author_member_id?: string;
    author_device_id?: string;
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
    author_seq: 0,
    created_at: '2026-06-22T00:00:00Z',
    created_at_bucket: '2026-06-22T00',
    lamport: fields.lamport ?? '1',
    parents: fields.parents ?? [],
    body,
  });
}

function buildState() {
  const ops: PrivateRoomOp[] = [
    mkOp(
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
    ),
    mkOp(
      {
        type: 'story.create',
        story_id: 's1',
        thread_id: 't1',
        title: 'Founder story',
        submission_type: 'original_brief',
        topic_ids: [],
        submission_metadata: {},
      },
      { op_id: 'cs1', lamport: '2', parents: ['genesis'] },
    ),
    mkOp(
      {
        type: 'story.create',
        story_id: 's2',
        thread_id: 't2',
        title: 'Bob story',
        submission_type: 'original_brief',
        topic_ids: [],
        submission_metadata: {},
      },
      { op_id: 'cs2', lamport: '3', parents: ['genesis'] },
    ),
    mkOp(
      {
        type: 'contribution.create',
        contribution_id: 'c1',
        thread_id: 't1',
        contribution_type: 'comment',
        body_markdown_lite: 'founder comment',
        citations: [],
        metadata: {},
        client_draft_id: 'd1',
      },
      { op_id: 'cc1', lamport: '4', parents: ['cs1'] },
    ),
    mkOp(
      {
        type: 'contribution.create',
        contribution_id: 'c2',
        thread_id: 't1',
        contribution_type: 'comment',
        body_markdown_lite: 'bob comment',
        citations: [],
        metadata: {},
        client_draft_id: 'd2',
      },
      { op_id: 'cc2', lamport: '5', parents: ['cs1'] },
    ),
  ];
  const state = reduceRoom(ops);
  expect(state.rejected).toHaveLength(0);
  return state;
}

describe('SEARCH_INDEX_KINDS', () => {
  it('pins the §13.7 index kinds', () => {
    expect(SEARCH_INDEX_KINDS).toStrictEqual(['title', 'body', 'citation', 'attachment_alt']);
  });
});

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumeric, and dedupes', () => {
    expect(tokenize('Hello, WORLD! hello')).toStrictEqual(['hello', 'world']);
  });

  it('keeps alphanumerics together (letters + digits)', () => {
    expect(tokenize('abc123 def-456')).toStrictEqual(['abc123', 'def', '456']);
  });

  it('NFC-folds composed/decomposed forms to one token', () => {
    // "cafe" + combining acute (decomposed) and the composed "CAFÉ" fold to one.
    expect(tokenize('café CAFÉ')).toStrictEqual(['café']);
  });

  it('returns no tokens for whitespace/punctuation only', () => {
    expect(tokenize('   ,.! ')).toStrictEqual([]);
  });
});

describe('buildSearchIndex — over decrypted reduced state', () => {
  it('indexes story titles (title) and contribution bodies (body)', () => {
    const index = buildSearchIndex(buildState());
    // "story" appears in both story titles.
    expect(searchLocal(index, 'story')).toStrictEqual([
      { kind: 'title', docId: 's1' },
      { kind: 'title', docId: 's2' },
    ]);
    // "comment" appears in both contribution bodies (sorted by docId).
    expect(searchLocal(index, 'comment')).toStrictEqual([
      { kind: 'body', docId: 'c1' },
      { kind: 'body', docId: 'c2' },
    ]);
  });

  it('excludes tombstoned content', () => {
    const state = buildState();
    const story = state.stories.get('s1');
    if (story) story.tombstoned = true;
    const contribution = state.contributions.get('c1');
    if (contribution) contribution.tombstoned = true;
    const index = buildSearchIndex(state);
    expect(searchLocal(index, 'story')).toStrictEqual([{ kind: 'title', docId: 's2' }]);
    expect(searchLocal(index, 'founder')).toStrictEqual([]); // s1 title + c1 body both gone
  });
});

describe('searchLocal — AND semantics, deterministic order', () => {
  it('requires ALL query tokens (intersection)', () => {
    const index = buildSearchIndex(buildState());
    // "bob" ∈ {title s2, body c2}; "story" ∈ {title s1, title s2} ⇒ {title s2}.
    expect(searchLocal(index, 'bob story')).toStrictEqual([{ kind: 'title', docId: 's2' }]);
    // "comment" (bodies) ∩ "story" (titles) = ∅.
    expect(searchLocal(index, 'comment story')).toStrictEqual([]);
  });

  it('sorts results by (docId, kind)', () => {
    const index = buildSearchIndex(buildState());
    // "founder" ∈ {title s1, body c1}; 'c1' < 's1' ⇒ body first.
    expect(searchLocal(index, 'founder')).toStrictEqual([
      { kind: 'body', docId: 'c1' },
      { kind: 'title', docId: 's1' },
    ]);
  });

  it('returns nothing for an empty query', () => {
    expect(searchLocal(buildSearchIndex(buildState()), '   ')).toStrictEqual([]);
  });
});

describe('indexExtraText — citation/attachment-alt indexing', () => {
  it('adds searchable text under a given kind without the reducer retaining it', () => {
    const index = buildSearchIndex(buildState());
    indexExtraText(index, 'citation', 'c1', 'a quoted excerpt about quantum mechanics');
    indexExtraText(index, 'attachment_alt', 'a1', 'a photo of a kitten');
    expect(searchLocal(index, 'quantum')).toStrictEqual([{ kind: 'citation', docId: 'c1' }]);
    expect(searchLocal(index, 'kitten')).toStrictEqual([{ kind: 'attachment_alt', docId: 'a1' }]);
  });

  it('does not duplicate a (kind, docId) posting for a repeated token', () => {
    const index = buildSearchIndex(buildState());
    indexExtraText(index, 'citation', 'c1', 'repeat repeat repeat');
    expect(searchLocal(index, 'repeat')).toStrictEqual([{ kind: 'citation', docId: 'c1' }]);
  });
});

describe('search shard AEAD — encrypted at rest (§25.7)', () => {
  const plaintext = new TextEncoder().encode('serialized inverted index shard');

  it('round-trips under the local key', async () => {
    const key = randomBytes(32);
    const sealed = await encryptSearchShard(plaintext, key);
    expect(await decryptSearchShard(sealed, key)).toStrictEqual(plaintext);
  });

  it('produces ciphertext distinct from the plaintext (encrypted at rest)', async () => {
    const key = randomBytes(32);
    const sealed = await encryptSearchShard(plaintext, key);
    // The sealed form is nonce || ciphertext, never the plaintext bytes.
    expect(sealed.length).toBeGreaterThan(plaintext.length);
    expect([...sealed.subarray(12)]).not.toStrictEqual([...plaintext]);
  });

  it('uses a fresh nonce per encryption (distinct sealed bytes)', async () => {
    const key = randomBytes(32);
    const a = await encryptSearchShard(plaintext, key);
    const b = await encryptSearchShard(plaintext, key);
    expect([...a]).not.toStrictEqual([...b]);
  });

  it('rejects decryption under the wrong key', async () => {
    const sealed = await encryptSearchShard(plaintext, randomBytes(32));
    await expect(decryptSearchShard(sealed, randomBytes(32))).rejects.toThrow();
  });

  it('rejects a too-short sealed blob', async () => {
    await expect(decryptSearchShard(new Uint8Array(5), randomBytes(32))).rejects.toThrow(
      /too short/,
    );
  });
});
