// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.14.2 — the §27.2 malicious-dependency-graph guard: structural detectors
// (node-count, fan-out, duplicate deps, cycle, depth) over the declared DAG plus
// the content detectors (private-in-public, unknown-critical-field), each mapped
// to its §16.11 wire rejection code.

import { describe, expect, it } from 'vitest';
import {
  checkDependencyGraph,
  type GraphGuardContext,
  type GraphGuardNode,
} from '../limits/graph-guard.js';

const RESTRICTED: GraphGuardContext = { audience: 'restricted' };
const node = (cid: string, requires: readonly string[] = []): GraphGuardNode => ({ cid, requires });

describe('checkDependencyGraph (§27.2 detectors)', () => {
  it('accepts a well-formed acyclic graph', () => {
    const res = checkDependencyGraph([node('C', ['B']), node('B', ['A']), node('A')], RESTRICTED);
    expect(res.ok).toBe(true);
  });

  it('accepts an empty batch', () => {
    expect(checkDependencyGraph([], RESTRICTED).ok).toBe(true);
  });

  it('rejects an over-large batch with rejected_resource_limit (node_count)', () => {
    const many = Array.from({ length: 5 }, (_, i) => node(`n${i}`));
    const res = checkDependencyGraph(many, {
      audience: 'restricted',
      limits: { maxNodes: 4, maxFanOut: 64, maxDepth: 64 },
    });
    expect(res).toMatchObject({
      ok: false,
      code: 'rejected_resource_limit',
      detector: 'node_count',
    });
  });

  it('rejects excessive fan-out with rejected_resource_limit', () => {
    const res = checkDependencyGraph([node('hub', ['a', 'b', 'c'])], {
      audience: 'restricted',
      limits: { maxNodes: 4096, maxFanOut: 2, maxDepth: 64 },
    });
    expect(res).toMatchObject({
      ok: false,
      code: 'rejected_resource_limit',
      detector: 'fan_out',
      cid: 'hub',
    });
  });

  it('rejects duplicate dependencies with rejected_bad_schema', () => {
    const res = checkDependencyGraph([node('R', ['dep', 'dep'])], RESTRICTED);
    expect(res).toMatchObject({
      ok: false,
      code: 'rejected_bad_schema',
      detector: 'duplicate_dependency',
      cid: 'R',
    });
  });

  it('rejects a dependency cycle with rejected_bad_schema', () => {
    const res = checkDependencyGraph([node('A', ['B']), node('B', ['A'])], RESTRICTED);
    expect(res).toMatchObject({ ok: false, code: 'rejected_bad_schema', detector: 'cycle' });
  });

  it('rejects a self-loop as a cycle', () => {
    const res = checkDependencyGraph([node('A', ['A'])], RESTRICTED);
    expect(res).toMatchObject({
      ok: false,
      code: 'rejected_bad_schema',
      detector: 'cycle',
      cid: 'A',
    });
  });

  it('rejects excessive dependency depth with rejected_resource_limit', () => {
    // A→B→C→D is depth 3; cap at 2.
    const res = checkDependencyGraph(
      [node('A', ['B']), node('B', ['C']), node('C', ['D']), node('D')],
      { audience: 'restricted', limits: { maxNodes: 4096, maxFanOut: 64, maxDepth: 2 } },
    );
    expect(res).toMatchObject({ ok: false, code: 'rejected_resource_limit', detector: 'depth' });
  });

  it('rejects a very long chain as depth without overflowing the call stack', () => {
    // A chain far deeper than maxDepth — and deep enough that a naive full recursion
    // would blow the JS stack.  The guard must stop short and reject as `depth`.
    const LEN = 20_000;
    const chain: GraphGuardNode[] = [];
    for (let i = 0; i < LEN; i++) {
      chain.push(node(`c${i}`, i + 1 < LEN ? [`c${i + 1}`] : []));
    }
    const res = checkDependencyGraph(chain, {
      audience: 'restricted',
      limits: { maxNodes: LEN + 1, maxFanOut: 64, maxDepth: 64 },
    });
    expect(res).toMatchObject({ ok: false, code: 'rejected_resource_limit', detector: 'depth' });
  });

  it('does not count external (out-of-batch) prerequisites toward depth', () => {
    // A→B→(external); the in-batch chain depth is 2, within the cap.
    const res = checkDependencyGraph([node('A', ['B']), node('B', ['external'])], {
      audience: 'restricted',
      limits: { maxNodes: 4096, maxFanOut: 64, maxDepth: 2 },
    });
    expect(res.ok).toBe(true);
  });

  it('rejects private metadata in a PUBLIC export with rejected_policy_denied', () => {
    const res = checkDependencyGraph([{ cid: 'P', requires: [], hasPrivateMetadata: true }], {
      audience: 'public',
    });
    expect(res).toMatchObject({
      ok: false,
      code: 'rejected_policy_denied',
      detector: 'private_in_public',
      cid: 'P',
    });
  });

  it('permits private metadata in a non-public export', () => {
    const res = checkDependencyGraph(
      [{ cid: 'P', requires: [], hasPrivateMetadata: true }],
      RESTRICTED,
    );
    expect(res.ok).toBe(true);
  });

  it('rejects an unknown critical field with rejected_bad_schema', () => {
    const res = checkDependencyGraph(
      [{ cid: 'U', requires: [], hasUnknownCriticalField: true }],
      RESTRICTED,
    );
    expect(res).toMatchObject({
      ok: false,
      code: 'rejected_bad_schema',
      detector: 'unknown_critical_field',
      cid: 'U',
    });
  });

  it('checks the node-count cap before any other pass', () => {
    // A cyclic, over-large batch reports node_count (the first/cheapest detector).
    const res = checkDependencyGraph([node('A', ['B']), node('B', ['A'])], {
      audience: 'restricted',
      limits: { maxNodes: 1, maxFanOut: 64, maxDepth: 64 },
    });
    expect(res).toMatchObject({ ok: false, detector: 'node_count' });
  });
});
