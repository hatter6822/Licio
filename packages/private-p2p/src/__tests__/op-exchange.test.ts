// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6.4 — `op_response` frame bounding (PRIV-OP-RESPONSE-FRAME-BOUND).  The `op_response` count
// cap alone does NOT bound its encoded bytes, so a large retained-op set (many §25.4-padded
// envelopes) could encode above the §27 sync frame cap and be dropped at fragment/decode, stalling
// convergence.  `chunkOpResponseEnvelopes` splits the served envelopes into frame-fitting batches,
// delivering ALL of them across several frames (no loss, no reliance on a re-request).
import { describe, expect, it } from 'vitest';
import { InMemoryPrivateRoomStorage, PrivateRoomEngine } from '../engine/room-engine.js';
import {
  buildRoomOp,
  createPrivateRoom,
  type PrivateOpBodyInput,
} from '../engine/room-lifecycle.js';
import type { PrivateEncryptedEnvelope } from '../schemas/envelope.js';
import { chunkOpResponseEnvelopes, encodeSyncMessage } from '../sync/op-exchange.js';

const PROFILE = { name: 'Quiet Room', room_type: 'global_topic' } as const;

/** Author `genesis + n` story ops in a room and return their real sealed envelopes (via serveOps). */
async function realEnvelopes(n: number): Promise<PrivateEncryptedEnvelope[]> {
  const room = await createPrivateRoom({
    roomId: 'r',
    founderMemberId: 'alice',
    founderDeviceId: 'alice-dev',
    profile: PROFILE,
    createdAt: '2026-06-22T00:00:00Z',
  });
  const engine = await PrivateRoomEngine.load({
    ...room.engineParams,
    storage: new InMemoryPrivateRoomStorage(),
  });
  await engine.applyLocalOp(room.genesisOp, room.sealParams);
  const opIds: string[] = [room.genesisOp.op_id];
  for (let i = 0; i < n; i++) {
    const body: PrivateOpBodyInput = {
      type: 'story.create',
      story_id: `s${i}`,
      thread_id: `t${i}`,
      title: `Story ${i}`,
      submission_type: 'original_brief',
      topic_ids: [],
      submission_metadata: {},
    };
    const { op, sealParams } = await buildRoomOp(
      {
        roomId: room.roomId,
        roomIdCommitment: room.roomIdCommitment,
        epochState: room.epochState,
        author: {
          memberId: 'alice',
          deviceId: 'alice-dev',
          signingKey: room.founder.signingKeyPair.privateKey,
          seq: engine.nextAuthorSeq('alice-dev'),
        },
        parents: engine.heads(),
        lamport: engine.nextLamport(),
        createdAt: '2026-06-22T00:00:00Z',
      },
      body,
    );
    await engine.applyLocalOp(op, sealParams);
    opIds.push(op.op_id);
  }
  return engine.serveOps(opIds);
}

const encode = (envelopes: readonly PrivateEncryptedEnvelope[]): Uint8Array =>
  encodeSyncMessage({ schema: 'licio.private.op_response.v1', envelopes: [...envelopes] });

describe('chunkOpResponseEnvelopes (PRIV-OP-RESPONSE-FRAME-BOUND)', () => {
  it('returns a single EMPTY batch for no envelopes (preserves the empty-response signal)', () => {
    expect(chunkOpResponseEnvelopes([])).toEqual([[]]);
  });

  it('keeps everything in ONE batch when it fits the (default 16 MiB) frame cap', async () => {
    const envs = await realEnvelopes(4);
    expect(chunkOpResponseEnvelopes(envs)).toEqual([envs]);
  });

  it('splits a set that exceeds the frame cap, delivering ALL envelopes in order + each frame fits', async () => {
    const envs = await realEnvelopes(4); // genesis + 4 = 5 envelopes
    const full = encode(envs);
    const maxBytes = Math.floor(full.length * 0.45); // fits ~2 of 5 ⇒ forces ≥ 2 batches
    const batches = chunkOpResponseEnvelopes(envs, maxBytes);
    expect(batches.length).toBeGreaterThanOrEqual(2);
    for (const batch of batches) {
      expect(batch.length).toBeGreaterThan(0); // never an empty batch
      expect(encode(batch).length).toBeLessThanOrEqual(maxBytes); // each encoded frame fits the cap
    }
    // ALL envelopes are delivered across the batches, in order — no loss, no re-request dependency.
    expect(batches.flat()).toEqual(envs);
  });
});
