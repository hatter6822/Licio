// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The §17.5 minimal dependency closure (WS-R.7.2): the trust/render closure of a
// renderable contribution, sufficient for authorized_provisional WITHOUT media,
// excluding old ancestors by default, and feeding the WS-R.5.2a scheduler.

import { describe, expect, it } from 'vitest';
import {
  assembleCandidates,
  isClosureComplete,
  type ScheduledCandidate,
} from '../scheduler/index.js';
import {
  type ClosureGraph,
  type ClosureRefs,
  minimalClosure,
  minimalClosureEdges,
  requiresOfFromGraph,
} from '../sync/index.js';

const contributionRefs: ClosureRefs = {
  deviceCertificateCid: 'cert',
  capabilityCid: 'cap',
  proofCids: ['contrib-proof', 'cert-proof', 'cap-proof'],
  bodyBlockCid: 'body',
  mediaBlockCids: ['media1', 'media2'],
  parentCid: 'parent',
  rootCid: 'root',
  checkpointSummaryCid: 'ckpt',
};

describe('minimalClosureEdges (§17.5)', () => {
  it('includes trust + body + checkpoint by default, excludes media and ancestors', () => {
    const edges = minimalClosureEdges(contributionRefs);
    expect(edges).toEqual([
      'cert',
      'cap',
      'contrib-proof',
      'cert-proof',
      'cap-proof',
      'body',
      'ckpt',
    ]);
    expect(edges).not.toContain('media1');
    expect(edges).not.toContain('parent');
    expect(edges).not.toContain('root');
  });

  it('adds media only with includeMedia', () => {
    const edges = minimalClosureEdges(contributionRefs, { includeMedia: true });
    expect(edges).toContain('media1');
    expect(edges).toContain('media2');
  });

  it('adds parent/root only with includeContext', () => {
    const edges = minimalClosureEdges(contributionRefs, { includeContext: true });
    expect(edges).toContain('parent');
    expect(edges).toContain('root');
  });

  it('drops the checkpoint summary with includeCheckpointSummary: false', () => {
    expect(
      minimalClosureEdges(contributionRefs, { includeCheckpointSummary: false }),
    ).not.toContain('ckpt');
  });

  it('de-duplicates while preserving trust-first order', () => {
    const edges = minimalClosureEdges({
      deviceCertificateCid: 'x',
      capabilityCid: 'x',
      bodyBlockCid: 'x',
    });
    expect(edges).toEqual(['x']);
  });
});

// The cert and capability each carry their own authority proof, so the closure
// walks transitively through them.
const graph: ClosureGraph = {
  refsOf: (cid) => {
    if (cid === 'post') return contributionRefs;
    if (cid === 'cert') return { proofCids: ['cert-proof'] };
    if (cid === 'cap') return { proofCids: ['cap-proof'] };
    return undefined; // proofs / blocks are leaves
  },
};

describe('minimalClosure (transitive, §17.5)', () => {
  it('reaches every authorized_provisional input without media or ancestors', () => {
    const closure = new Set(minimalClosure('post', graph));
    for (const need of [
      'post',
      'cert',
      'cap',
      'contrib-proof',
      'cert-proof',
      'cap-proof',
      'body',
    ]) {
      expect(closure.has(need)).toBe(true);
    }
    expect(closure.has('media1')).toBe(false);
    expect(closure.has('parent')).toBe(false);
    expect(closure.has('root')).toBe(false);
  });

  it('is cycle-safe (a parent/child cycle terminates)', () => {
    const cyclic: ClosureGraph = {
      refsOf: (cid) =>
        cid === 'a' ? { parentCid: 'b' } : cid === 'b' ? { parentCid: 'a' } : undefined,
    };
    expect(() => minimalClosure('a', cyclic, { includeContext: true })).not.toThrow();
    expect(new Set(minimalClosure('a', cyclic, { includeContext: true }))).toEqual(
      new Set(['a', 'b']),
    );
  });
});

describe('requiresOfFromGraph feeds the scheduler (WS-R.5.2a)', () => {
  it('yields a closure-complete candidate set', () => {
    const cids = [
      'post',
      'cert',
      'cap',
      'contrib-proof',
      'cert-proof',
      'cap-proof',
      'body',
      'ckpt',
    ];
    const objects = new Map<string, Omit<ScheduledCandidate, 'requires'>>(
      cids.map((cid) => [
        cid,
        {
          cid,
          lane: cid === 'post' ? 'T1' : 'C0',
          priority: cid === 'post' ? 1 : 0,
          bytes: 100,
          reason: 'closure',
        },
      ]),
    );
    const candidates = assembleCandidates({
      objects,
      seeds: ['post'],
      forbidden: () => false,
      requiresOf: requiresOfFromGraph(graph),
    });
    expect(isClosureComplete(candidates)).toBe(true);
    const placed = candidates.map((c) => c.cid);
    expect(placed).toContain('cert');
    expect(placed).toContain('cap');
    expect(placed).not.toContain('media1');
  });
});
