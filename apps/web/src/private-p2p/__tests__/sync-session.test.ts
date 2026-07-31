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
    return { accepted, quarantined: [], duplicate: 0, pending: 0, pendingPoolSize: 0 };
  }
  missingDependencies(): string[] {
    const missing = new Set<string>();
    for (const parents of this.ops.values()) {
      for (const p of parents) if (!this.ops.has(p)) missing.add(p);
    }
    return [...missing].sort();
  }
  /** Held-pending envelope count (settable by tests to drive PRIV-SESSION-SNAPSHOT-STUCK). */
  pending = 0;
  pendingCount(): number {
    return this.pending;
  }
}

/** A block-capable fake engine: `blockWants` are the CIDs it wants, and it ALWAYS refuses to
 *  serve (the §13.6 oversized/never-held case the spin guard must not loop on). */
class FakeBlockEngine extends FakeEngine {
  blockWants: string[] = [];
  async wantedBlockCids(): Promise<string[]> {
    return this.blockWants;
  }
  async serveBlocks(cids: readonly string[]) {
    return { served: [] as { cid: string; bytes: Uint8Array }[], refused: [...cids] };
  }
  async ingestBlocks(): Promise<{ accepted: string[]; rejected: string[] }> {
    return { accepted: [], rejected: [] }; // never reached in these refusal tests
  }
}

/** A fake that CAN import a snapshot archive (so `maybeRequestSnapshot` does not bail on the
 *  `!importArchive` guard) — used to drive the held-pending → snapshot-request stuck path. */
class FakeStuckEngine extends FakeEngine {
  async importArchive() {
    return {
      accepted: [] as string[],
      quarantined: [],
      duplicate: 0,
      pending: 0,
      pendingPoolSize: 0,
    };
  }
}

// --- a fake JSON codec (the real codec is tested in the package) -------------------
const fakeCodec: SyncCodec = {
  encodeSyncMessage: (m) => new TextEncoder().encode(JSON.stringify(m)),
  decodeSyncMessage: (b) =>
    JSON.parse(new TextDecoder().decode(b)) as import('@licio/private-p2p').SyncMessage,
  // Tests drive tiny envelope sets, so a single batch suffices (the real chunker's byte budget is
  // exercised by the package unit test); a copy keeps the return type mutable.
  chunkOpResponse: (envelopes) => [[...envelopes]],
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

  it('chunks media block-requests by the 1024-CID block cap, not the larger op-id cap', async () => {
    // 1025 wanted block CIDs MUST split into ≤1024-CID requests; a single 1025-CID block_request
    // would exceed the schema cap and throw before sending (media sync would stall).
    const engine = new FakeBlockEngine();
    engine.blockWants = Array.from({ length: 1025 }, (_, i) => `blk-${i}`);
    const sent: import('@licio/private-p2p').SyncMessage[] = [];
    const ref: { handler: ((f: Uint8Array) => void) | null } = { handler: null };
    const channel: PeerChannel = {
      send: (frame) => {
        sent.push(fakeCodec.decodeSyncMessage(frame.slice()));
      },
      onMessage: (l) => {
        ref.handler = l;
      },
      onClose: () => {},
      close: () => {},
    };
    new PrivateSyncSession(engine, channel, fakeCodec).start();
    // A peer head-announcement drives requestBlocks().
    ref.handler?.(
      fakeCodec.encodeSyncMessage({
        schema: 'licio.private.head_announcement.v1',
        heads: [],
        op_count_bucket: 0,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const reqs = sent.filter(
      (m): m is Extract<typeof m, { schema: 'licio.private.block_request.v1' }> =>
        m.schema === 'licio.private.block_request.v1',
    );
    expect(reqs.length).toBe(2); // 1024 + 1, never one 1025-CID request
    for (const r of reqs) expect(r.cids.length).toBeLessThanOrEqual(1024);
    expect(new Set(reqs.flatMap((r) => r.cids)).size).toBe(1025); // every want covered
  });

  it('does NOT spin on a refused-only block response (bounded, no livelock)', async () => {
    // Alice wants a block Bob will only ever REFUSE.  The old code re-drove requestBlocks() on the
    // non-empty refused list, spinning block_request/block_response forever; now a refused-only
    // response makes no progress and the exchange goes quiescent.
    const alice = new FakeBlockEngine();
    alice.blockWants = ['blk-x'];
    const bob = new FakeBlockEngine(); // serveBlocks refuses everything
    const { a, b, stats } = pairedChannels();
    new PrivateSyncSession(alice, a, fakeCodec).start();
    new PrivateSyncSession(bob, b, fakeCodec).start();
    await settle(stats);
    // A spin would never quiesce (settle would cap at 200 rounds with deliveries still climbing);
    // the fix bounds it to a tiny handshake.
    expect(stats.delivered).toBeLessThan(20);
  });

  it('requests the peer §14.5 snapshot when ops are held PENDING behind a pruned prefix (PRIV-SESSION-SNAPSHOT-STUCK)', async () => {
    // A compacted peer serves its retained post-snapshot ops but omits the PRUNED ancestors, so an op
    // stays held PENDING (missingDependencies() is empty, pendingCount() > 0).  `isStuck()` must read
    // the real pending count — the surface exposes `pendingCount` (once omitted, defeating this) — so
    // the session bootstraps via the peer's snapshot instead of quiescing incomplete.
    const engine = new FakeStuckEngine();
    engine.seed('op-1'); // already held ⇒ wantedFrom({heads:['op-1']}) is empty ⇒ requestedFresh 0
    engine.pending = 1; // an op awaiting a key/cert that lives in the peer's pruned prefix
    const sent: import('@licio/private-p2p').SyncMessage[] = [];
    const ref: { handler: ((f: Uint8Array) => void) | null } = { handler: null };
    const channel: PeerChannel = {
      send: (frame) => {
        sent.push(fakeCodec.decodeSyncMessage(frame.slice()));
      },
      onMessage: (l) => {
        ref.handler = l;
      },
      onClose: () => {},
      close: () => {},
    };
    new PrivateSyncSession(engine, channel, fakeCodec).start();
    // The peer announces it HOLDS a §14.5 snapshot we lack.
    ref.handler?.(
      fakeCodec.encodeSyncMessage({
        schema: 'licio.private.head_announcement.v1',
        heads: ['op-1'],
        op_count_bucket: 0,
        latest_snapshot_id: 'snap-x',
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    // A NON-empty op_response that yields NO new op and NO fresh want (so requestedFresh === 0) while
    // the engine is still stuck (pending 1) ⇒ the session must request the peer's snapshot.
    ref.handler?.(
      fakeCodec.encodeSyncMessage({
        schema: 'licio.private.op_response.v1',
        envelopes: [
          {
            __opId: 'op-1',
            __parents: [],
          } as unknown as import('@licio/private-p2p').PrivateEncryptedEnvelope,
        ],
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.some((m) => m.schema === 'licio.private.snapshot_request.v1')).toBe(true);
  });
});

describe('PrivateSyncSession terminal teardown (PRIV-WEB-SESSION-1)', () => {
  function closableChannel(): { channel: PeerChannel; drop: () => void } {
    let onClose: (() => void) | null = null;
    const channel: PeerChannel = {
      send: () => {},
      onMessage: () => {},
      onClose: (l) => {
        onClose = l;
      },
      close: () => {},
    };
    return { channel, drop: () => onClose?.() };
  }

  it('fires onTerminate exactly once on a local close() (which suppresses onClose)', () => {
    const { channel } = closableChannel();
    let terminated = 0;
    let onCloseCalls = 0;
    const s = new PrivateSyncSession(new FakeEngine(), channel, fakeCodec, {
      onClose: () => {
        onCloseCalls += 1;
      },
      onTerminate: () => {
        terminated += 1;
      },
    });
    s.start();
    s.close();
    s.close(); // idempotent
    expect(terminated).toBe(1);
    expect(onCloseCalls).toBe(0); // a local close() deliberately does NOT fire onClose
    expect(s.isClosed()).toBe(true);
  });

  it('fires onTerminate exactly once on an external channel drop', () => {
    const { channel, drop } = closableChannel();
    let terminated = 0;
    const s = new PrivateSyncSession(new FakeEngine(), channel, fakeCodec, {
      onTerminate: () => {
        terminated += 1;
      },
    });
    s.start();
    drop();
    drop(); // a second drop event must not double-fire
    expect(terminated).toBe(1);
  });

  it('fires onTerminate exactly once even when close() AND a later drop both occur', () => {
    const { channel, drop } = closableChannel();
    let terminated = 0;
    const s = new PrivateSyncSession(new FakeEngine(), channel, fakeCodec, {
      onTerminate: () => {
        terminated += 1;
      },
    });
    s.start();
    s.close();
    drop();
    expect(terminated).toBe(1);
  });
});
