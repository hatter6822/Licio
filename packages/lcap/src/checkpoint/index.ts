// SPDX-License-Identifier: AGPL-3.0-or-later
export {
  type ConsistencyFailedSignal,
  type ConsistencyVerification,
  type ConsistencyVerifyStatus,
  checkCheckpointConsistency,
  verifyConsistencyProof,
} from './consistency.js';
export {
  type InclusionVerification,
  type InclusionVerifyStatus,
  verifyInclusionProof,
} from './inclusion.js';
export { RoomLog } from './log.js';
export {
  bytesEqual,
  consistencyProofFromLeafHashes,
  emptyTreeHash,
  inclusionProofFromLeafHashes,
  leafHash,
  merkleRootFromLeafHashes,
  nodeHash,
  type TreeAlgorithm,
  verifyConsistency,
  verifyInclusion,
} from './merkle.js';
export {
  type BuildCheckpointParams,
  buildCheckpoint,
  type CheckpointBundle,
  type CheckpointVerification,
  type CheckpointVerifyStatus,
  checkpointRootMatchesLog,
  signCheckpoint,
  verifyCheckpoint,
} from './record.js';
export {
  type BuildCheckpointForkEvidenceParams,
  buildCheckpointForkEvidence,
  CheckpointForkDetector,
  type CheckpointForkObservation,
  checkpointForkPriority,
  signWitnessStatement,
  verifyWitnessStatement,
  type WitnessBundle,
  type WitnessVerification,
  type WitnessVerifyStatus,
} from './witness.js';
