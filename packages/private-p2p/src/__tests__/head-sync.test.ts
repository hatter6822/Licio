// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6.4 — head-sync tests (PRIVATE_SPEC §15.6, §15.7, §15.8): head
// computation over the accepted DAG; the coarse op-count bucket; frontier-first
// reconciliation (wantedHeads → missingParents reaches the causal closure); the
// §15.8 fetch order; and the §15.7 block request/response + refuse-large/backoff
// policy.
import { describe, expect, it } from 'vitest';
import {
  backoffDelayMs,
  blockPriorityForCategory,
  blockRequestSchema,
  buildHeadAnnouncement,
  computeHeads,
  decideBlockServe,
  FETCH_ORDER,
  fetchOrderRank,
  missingParents,
  type OpHeadView,
  opCountBucket,
  orderByFetchPriority,
  wantedHeads,
} from '../sync/head-sync.js';

const op = (op_id: string, parents: string[] = []): OpHeadView => ({ op_id, parents });

describe('computeHeads', () => {
  it('a linear chain has a single head (the tip)', () => {
    expect(computeHeads([op('g'), op('a', ['g']), op('b', ['a']), op('c', ['b'])])).toStrictEqual([
      'c',
    ]);
  });

  it('a diamond merge has a single head', () => {
    // g → x, g → y, then m merges x + y.
    const ops = [op('g'), op('x', ['g']), op('y', ['g']), op('m', ['x', 'y'])];
    expect(computeHeads(ops)).toStrictEqual(['m']);
  });

  it('disconnected tips are all heads (sorted)', () => {
    expect(computeHeads([op('g'), op('b', ['g']), op('a', ['g'])])).toStrictEqual(['a', 'b']);
  });

  it('a lone genesis op is its own head', () => {
    expect(computeHeads([op('g')])).toStrictEqual(['g']);
  });
});

describe('opCountBucket', () => {
  it('reveals only the coarse bucket (floor(count / 64))', () => {
    expect(opCountBucket(0)).toBe(0);
    expect(opCountBucket(63)).toBe(0);
    expect(opCountBucket(64)).toBe(1);
    expect(opCountBucket(200)).toBe(3);
  });
  it('rejects an invalid count', () => {
    expect(() => opCountBucket(-1)).toThrow();
  });
});

describe('buildHeadAnnouncement', () => {
  it('announces heads + coarse op count, with an optional snapshot', () => {
    const ops = [op('g'), op('a', ['g'])];
    const noSnap = buildHeadAnnouncement({ acceptedOps: ops });
    expect(noSnap.heads).toStrictEqual(['a']);
    expect(noSnap.op_count_bucket).toBe(0);
    expect(noSnap.latest_snapshot_id).toBeUndefined();

    const withSnap = buildHeadAnnouncement({ acceptedOps: ops, latestSnapshotId: 'snap-1' });
    expect(withSnap.latest_snapshot_id).toBe('snap-1');
  });
});

describe('frontier-first reconciliation (§15.7)', () => {
  it('wantedHeads = announced heads not held', () => {
    const announcement = buildHeadAnnouncement({ acceptedOps: [op('g'), op('a', ['g'])] });
    expect(wantedHeads(new Set(), announcement)).toStrictEqual(['a']);
    expect(wantedHeads(new Set(['a']), announcement)).toStrictEqual([]);
  });

  it('missingParents = referenced parents neither known nor in the batch', () => {
    // Batch has c (parent b); b is unknown ⇒ missing.
    expect(missingParents(new Set(['g']), [op('c', ['b'])])).toStrictEqual(['b']);
    // If b is already known, nothing is missing.
    expect(missingParents(new Set(['g', 'b']), [op('c', ['b'])])).toStrictEqual([]);
    // A parent present in the same batch is not missing.
    expect(missingParents(new Set(), [op('c', ['b']), op('b', ['g']), op('g')])).toStrictEqual([]);
  });

  it('iterating wanted → fetch → missingParents reaches the causal closure', () => {
    // The peer holds a chain g → a → b → c; we start empty and walk it back.
    const peerOps = new Map<string, OpHeadView>([
      ['g', op('g')],
      ['a', op('a', ['g'])],
      ['b', op('b', ['a'])],
      ['c', op('c', ['b'])],
    ]);
    const announcement = buildHeadAnnouncement({ acceptedOps: [...peerOps.values()] });

    const known = new Set<string>();
    const fetched: OpHeadView[] = [];
    // Start from the announced heads we lack.
    let frontier = wantedHeads(known, announcement);
    let guard = 0;
    while (frontier.length > 0 && guard++ < 100) {
      const batch = frontier.map((id) => peerOps.get(id)).filter((v): v is OpHeadView => !!v);
      for (const o of batch) {
        known.add(o.op_id);
        fetched.push(o);
      }
      frontier = missingParents(known, batch);
    }
    expect(fetched.map((o) => o.op_id).sort()).toStrictEqual(['a', 'b', 'c', 'g']);
  });
});

describe('§15.8 fetch order', () => {
  it('ranks categories in the documented order', () => {
    expect(FETCH_ORDER[0]).toBe('manifest');
    expect(FETCH_ORDER[FETCH_ORDER.length - 1]).toBe('snapshot');
    expect(fetchOrderRank('manifest')).toBeLessThan(fetchOrderRank('media_chunk'));
    expect(fetchOrderRank('visible_text')).toBeLessThan(fetchOrderRank('media_manifest'));
  });

  it('orders items by fetch priority, stable within a category', () => {
    const items = [
      { category: 'media_chunk' as const, id: 1 },
      { category: 'manifest' as const, id: 2 },
      { category: 'visible_text' as const, id: 3 },
      { category: 'manifest' as const, id: 4 },
    ];
    expect(orderByFetchPriority(items).map((i) => i.id)).toStrictEqual([2, 4, 3, 1]);
  });

  it('maps fine categories to coarse wire priorities', () => {
    expect(blockPriorityForCategory('manifest')).toBe('manifest');
    expect(blockPriorityForCategory('membership')).toBe('ops');
    expect(blockPriorityForCategory('visible_text')).toBe('thread');
    expect(blockPriorityForCategory('media_chunk')).toBe('media');
    expect(blockPriorityForCategory('snapshot')).toBe('snapshot');
  });
});

describe('§15.7 block request/response + refuse-large/backoff', () => {
  const cid = `b${'a'.repeat(47)}`;
  const request = blockRequestSchema.parse({
    schema: 'licio.private.block_request.v1',
    cids: [cid],
    priority: 'ops',
    max_bytes: 1_000_000,
  });

  it('serves a request within limits', () => {
    expect(
      decideBlockServe(request, { maxBytesPerRequest: 2_000_000, maxCidsPerRequest: 10 }),
    ).toStrictEqual({ serve: true });
  });

  it('refuses too many CIDs', () => {
    const many = blockRequestSchema.parse({ ...request, cids: [cid, cid, cid] });
    expect(
      decideBlockServe(many, { maxBytesPerRequest: 2_000_000, maxCidsPerRequest: 2 }),
    ).toStrictEqual({ serve: false, reason: 'too_many_cids' });
  });

  it('refuses a max_bytes beyond capacity', () => {
    expect(
      decideBlockServe(request, { maxBytesPerRequest: 100, maxCidsPerRequest: 10 }),
    ).toStrictEqual({ serve: false, reason: 'max_bytes_exceeds_capacity' });
  });

  it('backs off exponentially with a cap', () => {
    expect(backoffDelayMs(0, 1_000, 60_000)).toBe(1_000);
    expect(backoffDelayMs(1, 1_000, 60_000)).toBe(2_000);
    expect(backoffDelayMs(4, 1_000, 60_000)).toBe(16_000);
    expect(backoffDelayMs(20, 1_000, 60_000)).toBe(60_000); // capped
    expect(() => backoffDelayMs(-1)).toThrow();
  });
});
