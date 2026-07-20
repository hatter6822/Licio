// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.4.3 — integration: the apps/web `PrivateSyncSession` orchestration driving the
// REAL `@licio/private-p2p` engine through the REAL op-exchange codec, converging two
// engines over a paired in-memory `PeerChannel` (no live transport).  This joins the
// seam the unit tests left apart: the package proves the convergence MATH by calling
// the op-exchange functions directly; here the event-driven session loop + the real
// canonical codec drive two real engines to byte-identical state.

import type { PrivateOpBodyInput } from '@licio/private-p2p';
import { describe, expect, it } from 'vitest';
import { type PeerChannel, PrivateSyncSession, type SyncCodec } from '../sync-session.js';

const PROFILE = { name: 'Sync Integration', room_type: 'global_topic' } as const;

function pairedChannels(): {
  a: PeerChannel;
  b: PeerChannel;
  stats: { delivered: number };
} {
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

/**
 * Drive the event loop until the exchange QUIESCES.  A single op-exchange round spans
 * several `await`s (crypto-backed `ingest`), so `delivered` can be momentarily stable
 * mid-round; we therefore require it unchanged for many CONSECUTIVE macrotask ticks
 * (each tick also drains the microtask queue, where the crypto promises resolve)
 * before declaring quiescence — avoiding a premature exit while work is in flight.
 */
async function settle(stats: { delivered: number }): Promise<void> {
  let last = -1;
  let stableTicks = 0;
  for (let i = 0; i < 2_000; i++) {
    if (stats.delivered === last) {
      if (++stableTicks >= 25) return;
    } else {
      stableTicks = 0;
      last = stats.delivered;
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('WS-S.4.3 PrivateSyncSession × real engine × real codec', () => {
  it('converges a fresh peer to byte-identical state through the live op-exchange loop', async () => {
    const p2p = await import('@licio/private-p2p');
    const roomId = 'room-sync-int';
    const created = await p2p.createPrivateRoom({
      roomId,
      founderMemberId: 'founder',
      founderDeviceId: 'founder-dev',
      profile: PROFILE,
    });
    const codec: SyncCodec = {
      encodeSyncMessage: p2p.encodeSyncMessage,
      decodeSyncMessage: p2p.decodeSyncMessage,
      chunkOpResponse: p2p.chunkOpResponseEnvelopes,
    };

    // Alice: genesis (founder self-add) + a story + a comment.
    const alice = await p2p.PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new p2p.InMemoryPrivateRoomStorage(),
    });
    await alice.applyLocalOp(created.genesisOp, created.sealParams);
    const author = async (body: PrivateOpBodyInput): Promise<void> => {
      const { op, sealParams } = await p2p.buildRoomOp(
        {
          roomId,
          roomIdCommitment: created.roomIdCommitment,
          epochState: created.epochState,
          author: {
            memberId: 'founder',
            deviceId: 'founder-dev',
            signingKey: created.founder.signingKeyPair.privateKey,
            seq: alice.nextAuthorSeq('founder-dev'),
          },
          parents: alice.heads(),
          lamport: alice.nextLamport(),
        },
        body,
      );
      await alice.applyLocalOp(op, sealParams);
    };
    await author({
      type: 'story.create',
      story_id: 's1',
      thread_id: 't1',
      title: 'Sync me',
      submission_type: 'original_brief',
      topic_ids: [],
      submission_metadata: {},
    });
    await author({
      type: 'contribution.create',
      contribution_id: 'c1',
      thread_id: 't1',
      contribution_type: 'comment',
      body_markdown_lite: 'hi from alice',
      client_draft_id: globalThis.crypto.randomUUID(),
    });

    // Bob: a fresh engine over the SAME room keys + bootstrap, so it can OPEN Alice's
    // envelopes (storage confers no trust — every block re-verifies via openOp).
    const bob = await p2p.PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new p2p.InMemoryPrivateRoomStorage(),
    });
    expect(bob.state().stories.size).toBe(0);

    // Live, bidirectional §15.7 op-exchange over the paired channel + real codec.
    const { a, b, stats } = pairedChannels();
    const errors: unknown[] = [];
    const onError = (e: unknown): void => {
      errors.push(e);
    };
    const sa = new PrivateSyncSession(alice, a, codec, { onError });
    const sb = new PrivateSyncSession(bob, b, codec, { onError });
    sa.start();
    sb.start();
    await settle(stats);
    expect(errors.map((e) => (e instanceof Error ? e.message : String(e)))).toEqual([]);

    // Bob converged to byte-identical reduced state, having WALKED the DAG (genesis ←
    // story ← comment) and re-verified every envelope through its own openOp.
    expect(bob.state().stories.get('s1')?.title).toBe('Sync me');
    expect(bob.state().contributions.get('c1')?.bodyMarkdownLite).toBe('hi from alice');
    expect(bob.state().members.get('founder')?.role).toBe('admin');
    expect(bob.heads()).toStrictEqual(alice.heads());
    expect(Array.from(p2p.roomStateCommitment(bob.state()))).toEqual(
      Array.from(p2p.roomStateCommitment(alice.state())),
    );
    sa.close();
    sb.close();
  });
});
