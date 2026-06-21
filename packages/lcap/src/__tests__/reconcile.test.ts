// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Frontier-first reconciliation order (§17.1, WS-R.7.1): trust/liveness wants
// (revocations, checkpoints) are always ordered ahead of content wants.

import { describe, expect, it } from 'vitest';
import type { WantRequestV2 } from '../schemas/index.js';
import {
  orderWants,
  RECONCILIATION_ORDER,
  reconciliationRank,
  wantCategory,
} from '../sync/index.js';

const want = (
  cid: string,
  reason: WantRequestV2['reason'],
  over: Omit<WantRequestV2, 'cid' | 'cid_kind' | 'reason'> = {},
): WantRequestV2 => ({ cid, cid_kind: 'record', reason, ...over });

describe('reconciliation order (§17.1)', () => {
  it('lists the seven categories in the canonical order', () => {
    expect(RECONCILIATION_ORDER).toHaveLength(7);
    expect(RECONCILIATION_ORDER[0]).toBe('revocation_frontier');
    expect(RECONCILIATION_ORDER[1]).toBe('checkpoint_frontier');
    expect(RECONCILIATION_ORDER[6]).toBe('optional_filters');
    expect(reconciliationRank('revocation_frontier')).toBeLessThan(
      reconciliationRank('checkpoint_frontier'),
    );
    expect(reconciliationRank('checkpoint_frontier')).toBeLessThan(
      reconciliationRank('missing_dependency_wants'),
    );
  });

  it('maps want reasons to reconciliation categories', () => {
    expect(wantCategory('revocation_gap')).toBe('revocation_frontier');
    expect(wantCategory('checkpoint_gap')).toBe('checkpoint_frontier');
    expect(wantCategory('missing_dependency')).toBe('missing_dependency_wants');
    expect(wantCategory('explicit_user_request')).toBe('recent_object_summaries');
    expect(wantCategory('scarce_replica')).toBe('recent_object_summaries');
  });
});

describe('orderWants (§17.1 / §17.3)', () => {
  it('orders revocations and checkpoints before content wants', () => {
    const ordered = orderWants([
      want('zzz', 'scarce_replica'),
      want('mmm', 'checkpoint_gap'),
      want('aaa', 'revocation_gap'),
      want('bbb', 'missing_dependency'),
    ]);
    expect(ordered.map((w) => w.reason)).toEqual([
      'revocation_gap',
      'checkpoint_gap',
      'missing_dependency',
      'scarce_replica',
    ]);
  });

  it('breaks ties by priority override then CID', () => {
    const ordered = orderWants([
      want('b', 'room_interest', { priority_override: 3 }),
      want('a', 'room_interest', { priority_override: 1 }),
      want('c', 'room_interest', { priority_override: 1 }),
    ]);
    expect(ordered.map((w) => w.cid)).toEqual(['a', 'c', 'b']);
  });

  it('does not mutate its input', () => {
    const input = [want('y', 'checkpoint_gap'), want('x', 'revocation_gap')];
    const snapshot = input.map((w) => w.cid);
    orderWants(input);
    expect(input.map((w) => w.cid)).toEqual(snapshot);
  });
});
