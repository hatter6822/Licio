// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The §27.1 fan-out cap helper shared by the commit / share / export paths (#3): it must bound a
// body's block references WITHOUT ever spreading/iterating the full source_snapshot_cids array past
// the cap, and report `overCap` on the server's exact criterion (body + attachment + snapshots).

import { describe, expect, it } from 'vitest';
import { cappedBodyBlockCids } from './body-deps.js';

describe('cappedBodyBlockCids (§27.1 fan-out helper, #3)', () => {
  it('returns all refs in order for a within-cap body, overCap=false', () => {
    const { cids, overCap } = cappedBodyBlockCids(
      {
        body_block_cid: 'b',
        attachment_manifest_cid: 'a',
        source_snapshot_cids: ['s1', 's2'],
        target_source_snapshot_cid: 't',
      },
      64,
    );
    expect(cids).toEqual(['b', 'a', 's1', 's2', 't']); // declaration order, all included
    expect(overCap).toBe(false);
  });

  it('omits undefined refs and reports overCap=false when none exceed the cap', () => {
    const { cids, overCap } = cappedBodyBlockCids({ source_snapshot_cids: ['s1'] }, 64);
    expect(cids).toEqual(['s1']);
    expect(overCap).toBe(false);
  });

  it('bounds cids at maxFanOut and reports overCap=true for an over-cap snapshot array', () => {
    const snapshots = Array.from({ length: 200 }, (_, i) => `s${i}`);
    const { cids, overCap } = cappedBodyBlockCids({ source_snapshot_cids: snapshots }, 64);
    expect(overCap).toBe(true);
    expect(cids.length).toBe(64); // bounded — never the full 200
    expect(cids).toEqual(snapshots.slice(0, 64)); // the first 64 only
  });

  it('counts the overCap criterion exactly like the server (target excluded from the count)', () => {
    // Exactly maxFanOut snapshots + a target: the server accepts (target is a separate edge), so the
    // client must NOT report overCap here — only when body+attachment+snapshots exceed the cap.
    const atCap = Array.from({ length: 64 }, (_, i) => `s${i}`);
    const exact = cappedBodyBlockCids(
      { source_snapshot_cids: atCap, target_source_snapshot_cid: 't' },
      64,
    );
    expect(exact.overCap).toBe(false); // 64 snapshots (target not counted) == cap, not over

    // body + attachment + 63 snapshots == 65 > 64 ⇒ overCap.
    const over = cappedBodyBlockCids(
      {
        body_block_cid: 'b',
        attachment_manifest_cid: 'a',
        source_snapshot_cids: Array.from({ length: 63 }, (_, i) => `s${i}`),
      },
      64,
    );
    expect(over.overCap).toBe(true);
  });

  it('ALWAYS preserves the target snapshot (a separate edge) — even when source snapshots fill the cap', () => {
    // Regression (#1): the target snapshot must NOT compete for a fan-out slot, or an ACCEPTED record
    // whose source snapshots exactly fill the cap silently loses its target block dep.
    const atCap = Array.from({ length: 64 }, (_, i) => `s${i}`);
    const result = cappedBodyBlockCids(
      { source_snapshot_cids: atCap, target_source_snapshot_cid: 't' },
      64,
    );
    expect(result.overCap).toBe(false); // accepted
    expect(result.cids).toContain('t'); // the target is preserved despite the snapshots filling the cap
    expect(result.cids.length).toBe(65); // 64 capped snapshots + the always-included target
  });

  it('handles an empty body (no refs)', () => {
    const { cids, overCap } = cappedBodyBlockCids({}, 64);
    expect(cids).toEqual([]);
    expect(overCap).toBe(false);
  });
});
