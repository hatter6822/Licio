// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `validate(record)` — the §18.3 validation pipeline and the SINGLE entry point
// both client and server call (WS-R.8.2a/b/c, WS-R.8.3).  It runs three stages:
//   1. integrity + proof (steps 1-5): CID, strict schema, ≥1 detached proof;
//   2. authority chain (steps 6-10): the WS-R.1.5 cert+capability chain verbatim;
//   3. consensus (steps 11-15): revocation, device/checkpoint fork, checkpoint
//      inclusion/consistency, witness, server receipts.
// The result is the least-upper-bound trust state plus the precise missing
// dependencies; nothing upgrades past missing evidence.  No transport trust:
// `validate` takes no "source" — a record from a hostile relay and from a
// trusted friend yield the identical state (WS-R.8.3).

import { verifyConsistencyProof } from '../checkpoint/consistency.js';
import { verifyInclusionProof } from '../checkpoint/inclusion.js';
import { cidFor } from '../cid/index.js';
import type { DetachedProofV2 } from '../cose/sign1.js';
import { verifyDetached } from '../cose/sign1.js';
import {
  type ChainRejection,
  type IdentityChainDeps,
  validateIdentityChain,
} from '../identity/chain.js';
import type {
  ConsistencyProofRecordV2,
  InclusionProofRecordV2,
  RoomCheckpointRecordV2,
} from '../schemas/checkpoint.js';
import { decodeAndRouteRecord, type LcapRecordV2 } from '../schemas/codec.js';
import { maxPositive, type PositiveState, type TrustState } from './states.js';

export type RejectionCode =
  | 'rejected_bad_cid'
  | 'rejected_bad_schema'
  | 'rejected_bad_signature'
  | 'rejected_high_s_signature'
  | 'rejected_policy_denied'
  | 'rejected_capability_expired'
  | 'rejected_quota';

export interface ValidationFacts {
  recordCid?: string;
  recordKind?: LcapRecordV2['kind'];
  signerKeyId?: string;
  capabilityId?: string;
  roomId?: string;
}

export type ConflictKind = 'device_fork' | 'checkpoint_fork';

export interface ValidationResult {
  readonly state: TrustState;
  readonly missingCids: readonly string[];
  readonly facts: ValidationFacts;
  readonly rejection?: RejectionCode;
  readonly revoked?: { readonly kind: string; readonly id: string };
  readonly conflict?: ConflictKind;
}

/** Optional consensus inputs (steps 11-15), available when known. */
export interface ConsensusInput {
  /** A device-sequence fork was observed for this record (WS-R.2.4). */
  readonly deviceForkDetected?: boolean;
  /** Server receipt status for this record (WS-R.10). */
  readonly serverReceipt?: 'stored' | 'accepted';
  /** A checkpoint inclusion proof + its checkpoint (WS-R.9.3a). */
  readonly inclusion?: {
    readonly proof: InclusionProofRecordV2;
    readonly checkpoint: RoomCheckpointRecordV2;
  };
  /** A consistency proof + its two checkpoints (WS-R.9.3b). */
  readonly consistency?: {
    readonly proof: ConsistencyProofRecordV2;
    readonly oldCheckpoint: RoomCheckpointRecordV2;
    readonly newCheckpoint: RoomCheckpointRecordV2;
  };
  /** A verified witness statement is present (WS-R.9.4). */
  readonly witnessVerified?: boolean;
}

export interface ValidationInput {
  /** The claimed `record_cid` (step 2 verifies the body hashes to it). */
  readonly recordCid: string;
  /** The deterministic record body bytes. */
  readonly body: Uint8Array;
  /** The detached proofs the caller holds for this record. */
  readonly proofs: readonly DetachedProofV2[];
  /** Resolve the public key for a proof's `signer_key_id` (from a device cert). */
  readonly resolveSignerPublicKey: (signerKeyId: string) => Promise<CryptoKey | undefined>;
  /** The identity-chain dependency resolvers (steps 6-11). */
  readonly identityDeps: IdentityChainDeps;
  readonly consensus?: ConsensusInput;
  readonly ctx: {
    readonly networkId: string;
    readonly nowMs: number;
    readonly minAccountEpoch?: number;
  };
}

function reject(code: RejectionCode, facts: ValidationFacts): ValidationResult {
  return { state: 'rejected', rejection: code, facts, missingCids: [] };
}

/** Validate a record through the full §18.3 pipeline; returns its trust state. */
export async function validate(input: ValidationInput): Promise<ValidationResult> {
  const facts: ValidationFacts = {};
  const missing = new Set<string>();

  // --- Stage 1: integrity + proof (steps 1-5) ---------------------------
  const computedCid = await cidFor('record', input.body);
  if (computedCid !== input.recordCid) return reject('rejected_bad_cid', facts);
  facts.recordCid = computedCid;

  let record: LcapRecordV2;
  try {
    record = decodeAndRouteRecord(input.body);
  } catch {
    return reject('rejected_bad_schema', facts);
  }
  facts.recordKind = record.kind;

  // A contribution's device proof MUST be signed by the key the record claims as its
  // author (§18.3 step 5): otherwise any registered device could sign a body naming a
  // VICTIM's `author_device_key_id` + sequence and have it accepted as the victim's
  // record (impersonation + sequence consumption).  Non-contribution records are signed
  // by their issuing authority, so the author binding does not apply to them.
  const authorDeviceKeyId =
    record.kind === 'contribution_event' ? record.author_device_key_id : undefined;
  const applicable = input.proofs.filter(
    (p) =>
      p.record_cid === computedCid &&
      (authorDeviceKeyId === undefined || p.signer_key_id === authorDeviceKeyId),
  );
  if (applicable.length === 0) missing.add(`proof_for:${computedCid}`);

  let proofVerified = false;
  let keysSeen = 0;
  let sawHighS = false;
  let sawBadSignature = false;
  for (const proof of applicable) {
    const key = await input.resolveSignerPublicKey(proof.signer_key_id);
    if (!key) {
      missing.add(`signer_key:${proof.signer_key_id}`);
      continue;
    }
    keysSeen += 1;
    const verified = await verifyDetached(proof, input.body, key, {
      networkId: input.ctx.networkId,
      expectedRecordKind: record.kind,
    });
    if (verified.ok) {
      proofVerified = true;
      facts.signerKeyId = proof.signer_key_id;
      break;
    }
    if (verified.status === 'rejected_high_s_signature') sawHighS = true;
    else sawBadSignature = true;
  }
  // Keys were present and every applicable proof failed cryptographically → reject.
  if (!proofVerified && keysSeen > 0 && (sawBadSignature || sawHighS)) {
    return reject(sawHighS ? 'rejected_high_s_signature' : 'rejected_bad_signature', facts);
  }

  const base: PositiveState = proofVerified ? 'proof_verified' : 'integrity_verified';

  // --- Stage 2: authority chain (steps 6-10) ----------------------------
  let authorized = false;
  let stale = false;
  if (proofVerified && record.kind === 'contribution_event') {
    const chain = await validateIdentityChain(record, input.identityDeps, {
      networkId: input.ctx.networkId,
      nowMs: input.ctx.nowMs,
      // Pass the signed record's byte size so the capability's `max_single_event_bytes`
      // quota is actually enforced (it is a no-op when `eventBytes` is absent) — a valid
      // capability must not let an oversized offline event through (WS-R.1 §18.3 step 9).
      eventBytes: input.body.length,
      ...(input.ctx.minAccountEpoch !== undefined
        ? { minAccountEpoch: input.ctx.minAccountEpoch }
        : {}),
    });
    switch (chain.status) {
      case 'rejected':
        return reject(mapChainRejection(chain.reason), facts);
      case 'revoked':
        return { state: 'revoked', revoked: chain.target, facts, missingCids: [...missing] };
      case 'quarantined':
        for (const dep of chain.missing) {
          if (dep.kind === 'capability') missing.add(dep.cid);
          else if (dep.kind === 'device_certificate')
            missing.add(`device_certificate:${dep.deviceKeyId}`);
          else if (dep.kind === 'account_authority_key')
            missing.add(`account_authority_key:${dep.accountId}:${dep.accountEpoch}`);
          else missing.add(`room_authority_key:${dep.roomId}:${dep.policyEpoch}`);
        }
        break;
      case 'authorized':
        authorized = true;
        stale = chain.revocationFrontierStale;
        facts.capabilityId = chain.facts.capabilityId;
        facts.roomId = chain.facts.roomId;
        break;
    }
  }

  // --- Stage 3: consensus (steps 11-15) ---------------------------------
  let conflict: ConflictKind | undefined;
  let achieved: PositiveState = authorized
    ? stale
      ? 'stale_authorized'
      : 'authorized_provisional'
    : base;

  if (authorized) {
    const consensus = input.consensus;
    if (consensus?.deviceForkDetected) conflict = 'device_fork';

    if (consensus?.serverReceipt === 'accepted')
      achieved = maxPositive(achieved, 'server_accepted');
    else if (consensus?.serverReceipt === 'stored')
      achieved = maxPositive(achieved, 'server_stored');

    if (consensus?.inclusion) {
      const included = await verifyInclusionProof(
        consensus.inclusion.proof,
        consensus.inclusion.checkpoint,
        input.ctx.networkId,
      );
      if (included.ok) achieved = maxPositive(achieved, 'checkpointed');
    }

    if (consensus?.consistency) {
      const consistent = await verifyConsistencyProof(
        consensus.consistency.proof,
        consensus.consistency.oldCheckpoint,
        consensus.consistency.newCheckpoint,
      );
      if (!consistent.ok) conflict = 'checkpoint_fork';
    }

    if (consensus?.witnessVerified) achieved = maxPositive(achieved, 'witnessed');
  }

  // --- Fold: override states win ----------------------------------------
  if (conflict) return { state: 'conflicting', conflict, facts, missingCids: [...missing] };
  return { state: achieved, facts, missingCids: [...missing] };
}

function mapChainRejection(reason: ChainRejection): RejectionCode {
  switch (reason.stage) {
    case 'capability':
      return reason.status === 'rejected_expired'
        ? 'rejected_capability_expired'
        : 'rejected_policy_denied';
    case 'authorization':
      return 'rejected_policy_denied';
    case 'policy':
      return reason.detail === 'single_event_quota_exceeded'
        ? 'rejected_quota'
        : 'rejected_policy_denied';
    default:
      return 'rejected_policy_denied';
  }
}
