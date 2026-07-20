// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.9.2b/9.3a/9.3b/9.4 — checkpoint record + inclusion/consistency proofs +
// witness statements + checkpoint-fork evidence, over the pure RoomLog.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildCheckpoint,
  buildCheckpointForkEvidence,
  type CheckpointBundle,
  CheckpointForkDetector,
  checkCheckpointConsistency,
  checkpointForkPriority,
  checkpointRootMatchesLog,
  RoomLog,
  signCheckpoint,
  signWitnessStatement,
  verifyCheckpoint,
  verifyConsistencyProof,
  verifyInclusionProof,
  verifyWitnessStatement,
} from '../checkpoint/index.js';
import { cidFor } from '../cid/index.js';
import { type DeviceKeyPair, generateDeviceKey } from '../cose/keys.js';
import { defaultLane } from '../priority.js';
import {
  consistencyProofRecordV2Schema,
  inclusionProofRecordV2Schema,
  witnessStatementRecordV2Schema,
} from '../schemas/checkpoint.js';

const NET = 'prod';

let authority: DeviceKeyPair;
let log: RoomLog;
let recordCids: string[];
let bundle3: CheckpointBundle;
let bundle5: CheckpointBundle;
let cid3: string;
let cid5: string;

function tamper(hash: Uint8Array): Uint8Array {
  const copy = Uint8Array.from(hash);
  copy[0] = (copy[0] ?? 0) ^ 0xff;
  return copy;
}

beforeAll(async () => {
  authority = await generateDeviceKey();
  log = new RoomLog('RFC9162_SHA256', NET);
  recordCids = [];
  for (let i = 0; i < 5; i++) {
    const cid = await cidFor('record', Uint8Array.of(i, i + 1, i + 2, i + 3));
    recordCids.push(cid);
    await log.append(cid);
  }
  const sign = (checkpoint: Awaited<ReturnType<typeof buildCheckpoint>>) =>
    signCheckpoint({
      authorityPrivateKey: authority.privateKey,
      authoritySignerKeyId: 'auth-key',
      checkpoint,
      networkId: NET,
    });
  bundle3 = await sign(
    await buildCheckpoint(log, {
      roomId: 'room-1',
      treeSize: 3,
      policyEpoch: 1,
      revocationEpoch: 0,
      issuedAtMs: 1000,
      signerAuthorityId: 'auth-1',
    }),
  );
  bundle5 = await sign(
    await buildCheckpoint(log, {
      roomId: 'room-1',
      treeSize: 5,
      policyEpoch: 1,
      revocationEpoch: 0,
      issuedAtMs: 2000,
      signerAuthorityId: 'auth-1',
    }),
  );
  cid3 = await cidFor('record', bundle3.body);
  cid5 = await cidFor('record', bundle5.body);
});

describe('checkpoint record (WS-R.9.2b)', () => {
  it('verifies the authority proof and matches the log root', async () => {
    expect((await verifyCheckpoint(bundle5, authority.publicKey, { networkId: NET })).ok).toBe(
      true,
    );
    const forged = await generateDeviceKey();
    expect(await verifyCheckpoint(bundle5, forged.publicKey, { networkId: NET })).toEqual({
      ok: false,
      status: 'rejected_bad_authority_proof',
    });
    expect(await checkpointRootMatchesLog(bundle5.checkpoint, log)).toBe(true);
    expect(
      await checkpointRootMatchesLog(
        { ...bundle5.checkpoint, merkle_root: tamper(bundle5.checkpoint.merkle_root) },
        log,
      ),
    ).toBe(false);
  });

  it('rejects a genuine body/proof paired with a FORGED checkpoint (chosen merkle_root)', async () => {
    // The authority proof covers `body`, not `bundle.checkpoint`.  Pair the genuine
    // signed body + proof with a `checkpoint` carrying a chosen merkle_root: the proof
    // still verifies, but the checkpoint must be bound to the signed bytes and rejected.
    const forgedBundle = {
      ...bundle5,
      checkpoint: { ...bundle5.checkpoint, merkle_root: tamper(bundle5.checkpoint.merkle_root) },
    };
    expect(await verifyCheckpoint(forgedBundle, authority.publicKey, { networkId: NET })).toEqual({
      ok: false,
      status: 'rejected_checkpoint_body_mismatch',
    });
  });
});

describe('inclusion proof (WS-R.9.3a)', () => {
  it('verifies membership and rejects the four tamper cases', async () => {
    const leafIndex = 2;
    const proof = inclusionProofRecordV2Schema.parse({
      record_version: 2,
      kind: 'inclusion_proof',
      room_id: 'room-1',
      checkpoint_cid: cid5,
      target_record_cid: recordCids[leafIndex],
      leaf_index: leafIndex,
      tree_size: 5,
      proof_hashes: await log.inclusionProof(leafIndex, 5),
    });
    expect(await verifyInclusionProof(proof, bundle5.checkpoint, NET)).toEqual({ ok: true });
    // Wrong leaf (different target_record_cid), wrong index, wrong size.
    expect(
      (
        await verifyInclusionProof(
          { ...proof, target_record_cid: recordCids[0] as string },
          bundle5.checkpoint,
          NET,
        )
      ).ok,
    ).toBe(false);
    expect(
      await verifyInclusionProof({ ...proof, leaf_index: 5 }, bundle5.checkpoint, NET),
    ).toEqual({ ok: false, status: 'leaf_index_out_of_range' });
    expect(await verifyInclusionProof({ ...proof, tree_size: 4 }, bundle5.checkpoint, NET)).toEqual(
      { ok: false, status: 'tree_size_mismatch' },
    );
    // Tampered proof hash.
    const proofHashes = proof.proof_hashes.map((h, i) => (i === 0 ? tamper(h) : h));
    expect(
      (await verifyInclusionProof({ ...proof, proof_hashes: proofHashes }, bundle5.checkpoint, NET))
        .ok,
    ).toBe(false);
  });
});

describe('consistency proof (WS-R.9.3b)', () => {
  it('links successive checkpoints and signals equivocation on a rewrite', async () => {
    const proof = consistencyProofRecordV2Schema.parse({
      record_version: 2,
      kind: 'consistency_proof',
      room_id: 'room-1',
      old_checkpoint_cid: cid3,
      new_checkpoint_cid: cid5,
      old_tree_size: 3,
      new_tree_size: 5,
      proof_hashes: await log.consistencyProof(3, 5),
    });
    expect(await verifyConsistencyProof(proof, bundle3.checkpoint, bundle5.checkpoint)).toEqual({
      ok: true,
    });
    expect(await checkCheckpointConsistency(proof, bundle3, bundle5)).toEqual({ ok: true });

    // A new checkpoint with a rewritten root cannot be reconciled → fork signal.
    const rewritten: CheckpointBundle = {
      ...bundle5,
      checkpoint: { ...bundle5.checkpoint, merkle_root: tamper(bundle5.checkpoint.merkle_root) },
    };
    const signal = await checkCheckpointConsistency(proof, bundle3, rewritten);
    expect(signal).toMatchObject({ kind: 'consistency_failed', status: 'inconsistent' });
  });
});

describe('witness + checkpoint fork (WS-R.9.4)', () => {
  it('verifies a witness statement', async () => {
    const witness = await generateDeviceKey();
    const statement = witnessStatementRecordV2Schema.parse({
      record_version: 2,
      kind: 'witness_statement',
      witness_id: 'w-1',
      observed_checkpoint_cid: cid5,
      observed_tree_size: 5,
      observed_merkle_root: bundle5.checkpoint.merkle_root,
      gossip_context: 'https',
    });
    const bundle = await signWitnessStatement({
      witnessPrivateKey: witness.privateKey,
      witnessSignerKeyId: 'w-key',
      statement,
      networkId: NET,
    });
    expect((await verifyWitnessStatement(bundle, witness.publicKey, { networkId: NET })).ok).toBe(
      true,
    );
    const other = await generateDeviceKey();
    expect((await verifyWitnessStatement(bundle, other.publicKey, { networkId: NET })).ok).toBe(
      false,
    );
  });

  it('detects a checkpoint fork and builds P0/C0 evidence', async () => {
    const detector = new CheckpointForkDetector();
    const rootA = bundle5.checkpoint.merkle_root;
    const rootB = tamper(rootA);
    expect(detector.observe('room-1', 5, rootA, cid5)).toBeUndefined();
    expect(detector.observe('room-1', 5, rootA, cid5)).toBeUndefined(); // idempotent
    const fork = detector.observe('room-1', 5, rootB, cid3);
    if (!fork) throw new Error('expected a checkpoint fork');
    const evidence = buildCheckpointForkEvidence({ observation: fork, observedContext: 'https' });
    expect(evidence).toMatchObject({
      kind: 'fork_evidence',
      fork_kind: 'checkpoint',
      room_id: 'room-1',
      tree_size: 5,
    });
    expect(defaultLane(checkpointForkPriority())).toBe('C0');
  });
});
