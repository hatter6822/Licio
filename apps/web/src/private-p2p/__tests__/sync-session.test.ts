// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.4.3 (orchestration) — PrivateSyncSession message-loop tests.  These isolate
// the EVENT-DRIVEN orchestration (announce → want → serve → ingest → re-announce,
// the DAG walk, chunking, termination, fail-closed decode) with a fake string-DAG
// engine + a fake JSON codec + an in-memory paired channel.  The REAL crypto
// convergence (byte-identical reduced state) is proven in `@licio/private-p2p`'s
// op-exchange test; here we prove the loop converges, terminates, and stays robust.

import { describe, expect, it } from 'vitest';
import {
  type PeerChannel,
  PrivateSyncSession,
  type SyncCodec,
  type SyncEngineSurface,
} from '../sync-session.js';

// --- a fake string-DAG engine surface ---------------------------------------------
type FakeEnvelope = { __opId: string; __parents: string[] };

function computeHeads(ops: ReadonlyMap<string, readonly string[]>): string[] {
  const referenced = new Set<string>();
  for (const parents of ops.values()) for (const p of parents) referenced.add(p);
  return [...ops.keys()].filter((id) => !referenced.has(id)).sort();
}

class FakeEngine implements SyncEngineSurface {
  readonly ops = new Map<string, string[]>(); // opId → parents
  seed(opId: string, parents: string[] = []): void {
    this.ops.set(opId, parents);
  }
  headAnnouncement() {
    return {
      schema: 'licio.private.head_announcement.v1' as const,
      heads: computeHeads(this.ops),
      op_count_bucket: 0,
    };
  }
  wantedFrom(announcement: { heads: string[] }): string[] {
    return announcement.heads.filter((h) => !this.ops.has(h)).sort();
  }
  async serveOps(opIds: readonly string[]) {
    const out: FakeEnvelope[] = [];
    for (const id of opIds) {
      const parents = this.ops.get(id);
      if (parents) out.push({ __opId: id, __parents: parents });
    }
    // Cast at the fake boundary: the session treats envelopes as opaque pass-through.
    return out as unknown as import('@licio/private-p2p').PrivateEncryptedEnvelope[];
  }
  async ingest(envelopes: readonly import('@licio/private-p2p').PrivateEncryptedEnvelope[]) {
    const accepted: string[] = [];
    for (const raw of envelopes) {
      const env = raw as unknown as FakeEnvelope;
      if (!this.ops.has(env.__opId)) {
        this.ops.set(env.__opId, env.__parents);
        accepted.push(env.__opId);
      }
    }
    return { accepted, quarantined: [] };
  }
  missingDependencies(): string[] {
    const missing = new Set<string>();
    for (const parents of this.ops.values()) {
      for (const p of parents) if (!this.ops.has(p)) missing.add(p);
    }
    return [...missing].sort();
  }
}

// --- a fake JSON codec (the real codec is tested in the package) -------------------
const fakeCodec: SyncCodec = {
  encodeSyncMessage: (m) => new TextEncoder().encode(JSON.stringify(m)),
  decodeSyncMessage: (b) =>
    JSON.parse(new TextDecoder().decode(b)) as import('@licio/private-p2p').SyncMessage,
};

// --- an in-memory paired channel with a delivery counter ---------------------------
function pairedChannels() {
  const stats = { delivered: 0 };
  let aMsg: ((f: Uint8Array) => void) | null = null;
  let bMsg: ((f: Uint8Array) => void) | null = null;
  const mk = (peer: () => ((f: Uint8Array) => void) | null): PeerChannel => ({
    send: (frame) => {
      stats.delivered++;
      const copy = frame.slice();
      queueMicrotask(() => peer()?.(copy));
    },
    onMessage: () => {},
    onClose: () => {},
    close: () => {},
  });
  const a = mk(() => bMsg);
  const b = mk(() => aMsg);
  a.onMessage = (l) => {
    aMsg = l;
  };
  b.onMessage = (l) => {
    bMsg = l;
  };
  return { a, b, stats };
}

/** Run microtasks/macrotasks until the channel goes quiescent (no new deliveries). */
async function settle(stats: { delivered: number }): Promise<void> {
  let last = -1;
  for (let i = 0; i < 200 && last !== stats.delivered; i++) {
    last = stats.delivered;
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('WS-S.4.3 PrivateSyncSession orchestration', () => {
  it('reconciles a fresh peer over a duplex channel, walking the multi-hop DAG', async () => {
    const alice = new FakeEngine();
    alice.seed('g');
    alice.seed('a', ['g']);
    alice.seed('b', ['a']);
    alice.seed('c', ['b']); // head
    const bob = new FakeEngine();
    const { a, b, stats } = pairedChannels();
    new PrivateSyncSession(alice, a, fakeCodec).start();
    new PrivateSyncSession(bob, b, fakeCodec).start();
    await settle(stats);
    expect([...bob.ops.keys()].sort()).toEqual(['a', 'b', 'c', 'g']);
    expect(computeHeads(bob.ops)).toEqual(['c']);
    expect(bob.missingDependencies()).toEqual([]);
  });

  it('converges two peers to the UNION of disjoint DAGs (bidirectional)', async () => {
    const alice = new FakeEngine();
    alice.seed('g');
    alice.seed('x', ['g']);
    const bob = new FakeEngine();
    bob.seed('g');
    bob.seed('y', ['g']);
    const { a, b, stats } = pairedChannels();
    new PrivateSyncSession(alice, a, fakeCodec).start();
    new PrivateSyncSession(bob, b, fakeCodec).start();
    await settle(stats);
    expect([...alice.ops.keys()].sort()).toEqual(['g', 'x', 'y']);
    expect([...bob.ops.keys()].sort()).toEqual(['g', 'x', 'y']);
  });

  it('chunks a large want set into bounded requests and still converges', async () => {
    const alice = new FakeEngine();
    alice.seed('g');
    for (let i = 0; i < 5; i++) alice.seed(`h${i}`, ['g']); // 5 heads
    const bob = new FakeEngine();
    const { a, b, stats } = pairedChannels();
    new PrivateSyncSession(alice, a, fakeCodec, { maxOpIdsPerRequest: 2 }).start();
    new PrivateSyncSession(bob, b, fakeCodec, { maxOpIdsPerRequest: 2 }).start();
    await settle(stats);
    expect([...bob.ops.keys()].sort()).toEqual(['g', 'h0', 'h1', 'h2', 'h3', 'h4']);
  });

  it('fails closed on a garbage frame (no crash; onError observes it)', async () => {
    const engine = new FakeEngine();
    engine.seed('g');
    const errors: unknown[] = [];
    const ref: { handler: ((f: Uint8Array) => void) | null } = { handler: null };
    const channel: PeerChannel = {
      send: () => {},
      onMessage: (l) => {
        ref.handler = l;
      },
      onClose: () => {},
      close: () => {},
    };
    const session = new PrivateSyncSession(engine, channel, fakeCodec, {
      onError: (e) => errors.push(e),
    });
    session.start();
    ref.handler?.(new TextEncoder().encode('}{ not json'));
    await new Promise((r) => setTimeout(r, 0));
    expect(errors.length).toBeGreaterThan(0);
    expect(engine.ops.has('g')).toBe(true); // engine intact
  });
});
