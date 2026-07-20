// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S security regressions — the two §14 authority holes closed by the
// 2026-07 audit:
//
//   1. op-id squatting.  op_id used to be a free author-chosen string, so a member
//      could mint an envelope whose op_id equalled ANOTHER member's op and displace
//      it via the device-fork resolver (bytewise-smaller signature wins).  §14.3.2
//      requires op_id to be "fully determined by op content"; `openOp` now binds it
//      to `deriveOpId(author_device_id, author_seq)`, so a cross-author collision is
//      structurally impossible — the squatting envelope is rejected `op_id_mismatch`.
//
//   2. genesis hijack.  The genesis rule accepted WHOEVER's self-add sorted first on
//      an empty fold, so a member could seal a `member.add` self-grant with
//      `lamport:'0'` (sorts first), become the genesis, and orphan the real founder's
//      whole subtree.  `reduceRoom` now pins the genesis to the manifest-committed
//      founder device, so a forged competing genesis is rejected on every device.

import { describe, expect, it } from 'vitest';
import { randomBytes } from '../crypto/runtime.js';
import { generateDeviceSigningKeyPair } from '../crypto/signatures.js';
import { deriveOpId } from '../reducer/op-id.js';
import { reduceRoom } from '../reducer/reduce.js';
import { validateStructure } from '../reducer/validate.js';
import { openOp, sealOp } from '../reducer/validate-op.js';
import { type PrivateOpBody, type PrivateRoomOp, privateRoomOpSchema } from '../schemas/ops.js';

const KEY = 'AAAA';

const selfAdd = (memberId: string, deviceId: string): PrivateOpBody => ({
  type: 'member.add',
  member_id: memberId,
  device_id: deviceId,
  signing_public_key: KEY,
  hpke_public_key: KEY,
  mls_key_package: KEY,
  granted_role: 'admin',
});

async function op(
  body: PrivateOpBody,
  fields: {
    author_member_id: string;
    author_device_id: string;
    author_seq?: number;
    lamport?: string;
    parents?: string[];
    op_id?: string;
  },
): Promise<PrivateRoomOp> {
  const seq = fields.author_seq ?? 0;
  return privateRoomOpSchema.parse({
    schema: 'licio.private.op.v1',
    room_id: 'room-1',
    epoch: 0,
    op_id: fields.op_id ?? (await deriveOpId(fields.author_device_id, seq)),
    author_member_id: fields.author_member_id,
    author_device_id: fields.author_device_id,
    author_seq: seq,
    created_at: '2026-06-22T00:00:00Z',
    created_at_bucket: '2026-06-22T00',
    lamport: fields.lamport ?? '1',
    parents: fields.parents ?? [],
    body,
  });
}

describe('§14.3.2 op-id binding — op-id squatting is rejected', () => {
  it('openOp rejects an op whose op_id is not derived from its (device, seq)', async () => {
    const device = await generateDeviceSigningKeyPair();
    const roomIdCommitment = randomBytes(32);
    const contentWrapKey = randomBytes(32);
    const blind = 'blind-1';
    const ctx = {
      roomIdCommitment,
      contentWrapKeyForEpoch: (e: number) => (e === 0 ? contentWrapKey : undefined),
      deviceSigningKey: (b: string) => (b === blind ? device.publicKey : undefined),
      deviceIdForBlind: (b: string) => (b === blind ? 'attacker-dev' : undefined),
    };
    // The attacker seals a VALID op (their own device, their own seq) but stamps it
    // with a FREE op_id (here, another member's derived id) to squat that slot.
    const squatId = await deriveOpId('victim-dev', 3);
    const squat = await op(selfAdd('attacker', 'attacker-dev'), {
      author_member_id: 'attacker',
      author_device_id: 'attacker-dev',
      op_id: squatId,
    });
    const envelope = await sealOp(squat, {
      roomIdCommitment,
      contentWrapKey,
      deviceSigningKey: device.privateKey,
      authorDeviceIdBlind: blind,
      capabilityRootAtSeq: randomBytes(16),
    });
    expect(await openOp(envelope, ctx)).toMatchObject({ ok: false, reason: 'op_id_mismatch' });
  });

  it('a genuine op (op_id = deriveOpId(device, seq)) opens', async () => {
    const device = await generateDeviceSigningKeyPair();
    const roomIdCommitment = randomBytes(32);
    const contentWrapKey = randomBytes(32);
    const blind = 'blind-1';
    const ctx = {
      roomIdCommitment,
      contentWrapKeyForEpoch: (e: number) => (e === 0 ? contentWrapKey : undefined),
      deviceSigningKey: (b: string) => (b === blind ? device.publicKey : undefined),
      deviceIdForBlind: (b: string) => (b === blind ? 'founder-dev' : undefined),
    };
    const genuine = await op(selfAdd('founder', 'founder-dev'), {
      author_member_id: 'founder',
      author_device_id: 'founder-dev',
    });
    const envelope = await sealOp(genuine, {
      roomIdCommitment,
      contentWrapKey,
      deviceSigningKey: device.privateKey,
      authorDeviceIdBlind: blind,
      capabilityRootAtSeq: randomBytes(16),
    });
    expect(await openOp(envelope, ctx)).toMatchObject({ ok: true });
  });
});

describe('§14.2 genesis founder pin — a forged competing genesis cannot hijack the room', () => {
  it('with the pin, a lower-lamport non-founder genesis is rejected and the founder wins', async () => {
    // The attacker seals a self-add admin genesis at lamport 0 (sorts FIRST); the real
    // founder genesis is at lamport 1.  Both are self-adds off an empty room.
    const forged = await op(selfAdd('attacker', 'attacker-dev'), {
      author_member_id: 'attacker',
      author_device_id: 'attacker-dev',
      lamport: '0',
    });
    const founder = await op(selfAdd('founder', 'founder-dev'), {
      author_member_id: 'founder',
      author_device_id: 'founder-dev',
      lamport: '1',
    });

    const pinned = reduceRoom([forged, founder], undefined, 'founder-dev');
    // The forged genesis is rejected; the founder bootstraps the room.
    expect(pinned.members.get('founder')?.role).toBe('admin');
    expect(pinned.members.has('attacker')).toBe(false);
    expect(pinned.rejected.some((r) => r.opId === forged.op_id)).toBe(true);
  });

  it('WITHOUT the pin the same forgery WOULD hijack (documents what the pin closes)', async () => {
    const forged = await op(selfAdd('attacker', 'attacker-dev'), {
      author_member_id: 'attacker',
      author_device_id: 'attacker-dev',
      lamport: '0',
    });
    const founder = await op(selfAdd('founder', 'founder-dev'), {
      author_member_id: 'founder',
      author_device_id: 'founder-dev',
      lamport: '1',
    });

    // Unpinned (legacy): the lamport-0 forgery sorts first, becomes genesis, and the
    // real founder is orphaned — the exact hijack the pin prevents.
    const unpinned = reduceRoom([forged, founder]);
    expect(unpinned.members.get('attacker')?.role).toBe('admin');
    expect(unpinned.members.has('founder')).toBe(false);
  });
});

describe('§14.3.1 anti-DoS — a near-cap Lamport op cannot freeze authoring', () => {
  it('quarantines an op whose lamport jumps beyond runningMax + 1', async () => {
    const genesis = await op(selfAdd('founder', 'founder-dev'), {
      author_member_id: 'founder',
      author_device_id: 'founder-dev',
      lamport: '1',
    });
    // A member seals a valid op with a 40-digit lamport (the schema cap): unbounded,
    // this poisons nextLamport (max+1 → 41 digits → schema reject → permanent freeze).
    const poison = await op(selfAdd('attacker', 'attacker-dev'), {
      author_member_id: 'attacker',
      author_device_id: 'attacker-dev',
      author_seq: 1,
      lamport: '9'.repeat(40),
    });
    const { accepted, quarantined } = validateStructure([genesis, poison], 'room-1');
    expect(accepted.map((o) => o.op_id)).toContain(genesis.op_id);
    expect(quarantined.some((q) => q.reason === 'lamport_jump_exceeded')).toBe(true);
    // Because the poison op is quarantined, the running ceiling stays at 1 — the next
    // legitimate stamp is 2, not a 41-digit value.
    expect(accepted.map((o) => o.op_id)).not.toContain(poison.op_id);
  });
});
