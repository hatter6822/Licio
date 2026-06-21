// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.12.1b — the pure ingestion stage-2 dependency resolver: §24.4 topological
// validation order with class priority, transitively-absent missing-dependency
// detection (the §24.1 wants), and cycle isolation.

import { describe, expect, it } from 'vitest';
import { type IngestionNode, resolveIngestionOrder } from '../sync/ingest-order.js';

const none = () => false;
const node = (
  cid: string,
  requires: readonly string[] = [],
  cls: IngestionNode['cls'] = 'record',
): IngestionNode => ({ cid, cls, requires });

describe('resolveIngestionOrder (§24.4 topological validation order)', () => {
  it('orders a linear prerequisite chain parents-before-children', () => {
    const res = resolveIngestionOrder([node('C', ['B']), node('B', ['A']), node('A')], none);
    expect(res.order).toEqual(['A', 'B', 'C']);
    expect(res.quarantined.size).toBe(0);
    expect(res.cyclic).toEqual([]);
  });

  it('breaks ties by §24.4 class priority (certs/caps/revocations/checkpoints/moderation before records)', () => {
    const res = resolveIngestionOrder(
      [
        node('rec', [], 'record'),
        node('mod', [], 'moderation'),
        node('chk', [], 'checkpoint'),
        node('rev', [], 'revocation'),
        node('cap', [], 'capability'),
        node('crt', [], 'cert'),
      ],
      none,
    );
    expect(res.order).toEqual(['crt', 'cap', 'rev', 'chk', 'mod', 'rec']);
  });

  it('preserves stable batch order among same-class ready nodes', () => {
    const res = resolveIngestionOrder([node('a'), node('b'), node('c')], none);
    expect(res.order).toEqual(['a', 'b', 'c']);
  });

  it('treats a prerequisite the receiver already holds as satisfied', () => {
    const res = resolveIngestionOrder([node('B', ['A'])], (cid) => cid === 'A');
    expect(res.order).toEqual(['B']);
    expect(res.quarantined.size).toBe(0);
  });

  it('quarantines an object whose prerequisite is absent, surfacing it as a want', () => {
    const res = resolveIngestionOrder([node('B', ['A'])], none);
    expect(res.order).toEqual([]);
    expect([...res.quarantined]).toEqual([['B', ['A']]]);
    expect(res.cyclic).toEqual([]);
  });

  it('propagates a transitively-absent root to every downstream object', () => {
    // C → B → A, with A neither held nor in the batch.
    const res = resolveIngestionOrder([node('C', ['B']), node('B', ['A'])], none);
    expect(res.order).toEqual([]);
    expect(res.quarantined.get('B')).toEqual(['A']);
    expect(res.quarantined.get('C')).toEqual(['A']);
  });

  it('orders the satisfiable part and quarantines only the unsatisfiable part', () => {
    // X requires a held cert; Y requires an absent block.
    const res = resolveIngestionOrder(
      [node('cert', [], 'cert'), node('X', ['cert']), node('Y', ['missing-block'])],
      none,
    );
    expect(res.order).toEqual(['cert', 'X']);
    expect(res.quarantined.get('Y')).toEqual(['missing-block']);
  });

  it('collects multiple distinct absent roots in deterministic first-seen order', () => {
    const res = resolveIngestionOrder([node('R', ['dep-1', 'dep-2'])], none);
    expect(res.quarantined.get('R')).toEqual(['dep-1', 'dep-2']);
  });

  it('isolates a pure dependency cycle as cyclic (not quarantined)', () => {
    const res = resolveIngestionOrder([node('A', ['B']), node('B', ['A'])], none);
    expect(res.order).toEqual([]);
    expect(res.quarantined.size).toBe(0);
    expect([...res.cyclic].sort()).toEqual(['A', 'B']);
  });

  it('quarantines (does not reject) a node that has both an absent root and a cycle branch', () => {
    // P depends on a cycle {A↔B} and on an absent root; the actionable verdict wins.
    const res = resolveIngestionOrder(
      [node('A', ['B']), node('B', ['A']), node('P', ['A', 'absent'])],
      none,
    );
    expect(res.quarantined.get('P')).toEqual(['absent']);
    expect([...res.cyclic].sort()).toEqual(['A', 'B']);
  });

  it('de-duplicates a repeated cid (first occurrence wins)', () => {
    const res = resolveIngestionOrder(
      [node('A'), node('A', ['nope'])], // the second A is ignored
      none,
    );
    expect(res.order).toEqual(['A']);
    expect(res.quarantined.size).toBe(0);
  });

  it('returns empty results for an empty batch', () => {
    const res = resolveIngestionOrder([], none);
    expect(res.order).toEqual([]);
    expect(res.quarantined.size).toBe(0);
    expect(res.cyclic).toEqual([]);
  });

  it('is a total partition: every input cid lands in exactly one of order/quarantined/cyclic', () => {
    const batch = [
      node('crt', [], 'cert'),
      node('ok', ['crt']),
      node('miss', ['gone']),
      node('cyc1', ['cyc2']),
      node('cyc2', ['cyc1']),
    ];
    const res = resolveIngestionOrder(batch, none);
    const seen = new Set<string>([...res.order, ...res.quarantined.keys(), ...res.cyclic]);
    expect(seen.size).toBe(batch.length);
    expect(res.order.length + res.quarantined.size + res.cyclic.length).toBe(batch.length);
  });
});
