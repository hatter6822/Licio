// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sync pulse build/apply (OFFLINE_SPEC §16.1, §16.2, §5.3, WS-R.6.1).  The pulse
// is logically FIRST in every exchange so that a session dying after the pulse
// has still moved trust/liveness data (frontiers).  `buildPulse` assembles and
// fail-closed-validates a `SyncPulseV2`; `applyPulse` diffs the remote pulse
// against local frontiers to produce the frontier-derived wants (what we request)
// and offers (what the remote asked for that we have).  Pure functions.

import { type CidKind, parseCid } from '../cid/index.js';
import type { CryptoSuiteId } from '../cose/index.js';
import {
  type CapabilityFrontierV2,
  type CheckpointFrontierV2,
  type ExchangeBudgetV2,
  type LaneSummaryV2,
  type PulseResponseV2,
  pulseResponseV2Schema,
  type RevocationFrontierV2,
  type SyncPrivacyMode,
  type SyncPulseV2,
  type SyncTransportProfile,
  syncPulseV2Schema,
  type WantRequestV2,
} from '../schemas/sync.js';
import { compareRevocationFrontiers, diffCheckpointFrontiers } from './frontiers.js';

/** Structured inputs for {@link buildPulse} (optional fields are omitted when absent). */
export interface PulseInputs {
  readonly nodeId: string;
  readonly sessionNonce: Uint8Array;
  readonly transportProfile: SyncTransportProfile;
  readonly privacyMode: SyncPrivacyMode;
  readonly budgets: ExchangeBudgetV2;
  readonly supportedSuites: readonly CryptoSuiteId[];
  readonly supportedCompression: readonly ('none' | 'gzip' | 'deflate' | 'zstd')[];
  readonly supportedPackVersions: readonly number[];
  readonly checkpointFrontier: readonly CheckpointFrontierV2[];
  readonly revocationFrontier: readonly RevocationFrontierV2[];
  readonly capabilityFrontier?: readonly CapabilityFrontierV2[];
  readonly criticalHave?: readonly string[];
  readonly criticalWant?: readonly string[];
  readonly laneSummary?: readonly LaneSummaryV2[];
}

/**
 * Assemble + fail-closed-validate a `SyncPulseV2`.  Carries ONLY frontier /
 * critical material (no bulk content), so it is emitted before any pack.
 */
export function buildPulse(inputs: PulseInputs): SyncPulseV2 {
  const pulse: Record<string, unknown> = {
    lcap_version: 2,
    node_id: inputs.nodeId,
    session_nonce: inputs.sessionNonce,
    transport_profile: inputs.transportProfile,
    privacy_mode: inputs.privacyMode,
    budgets: inputs.budgets,
    supported_suites: [...inputs.supportedSuites],
    supported_compression: [...inputs.supportedCompression],
    supported_pack_versions: [...inputs.supportedPackVersions],
    checkpoint_frontier: [...inputs.checkpointFrontier],
    revocation_frontier: [...inputs.revocationFrontier],
  };
  if (inputs.capabilityFrontier !== undefined) {
    pulse['capability_frontier'] = [...inputs.capabilityFrontier];
  }
  if (inputs.criticalHave !== undefined) pulse['critical_have'] = [...inputs.criticalHave];
  if (inputs.criticalWant !== undefined) pulse['critical_want'] = [...inputs.criticalWant];
  if (inputs.laneSummary !== undefined) pulse['lane_summary'] = [...inputs.laneSummary];
  // Fail closed: a malformed pulse throws here rather than going on the wire.
  return syncPulseV2Schema.parse(pulse);
}

/**
 * Assemble + fail-closed-validate a §29.1 `PulseResponseV2` — the server's pulse
 * plus an optional inline critical pack (the C0 one-round-trip case) and a back-off
 * hint.  Absent optionals are omitted (never `null`), so the envelope stays minimal.
 */
export function buildPulseResponse(params: {
  readonly pulse: SyncPulseV2;
  readonly criticalPack?: Uint8Array;
  readonly retryAfterMs?: number;
}): PulseResponseV2 {
  const response: Record<string, unknown> = { pulse: params.pulse };
  if (params.criticalPack !== undefined) response['critical_pack'] = params.criticalPack;
  if (params.retryAfterMs !== undefined) response['retry_after_ms'] = params.retryAfterMs;
  return pulseResponseV2Schema.parse(response);
}

/** The reaction to a remote pulse: what we want, what we can offer, and posture. */
export interface PulseReaction {
  /** Frontier-derived wants (revocation gaps, then checkpoint gaps, then critical). */
  readonly wants: WantRequestV2[];
  /** CIDs the remote explicitly wants (`critical_want`) that we have — offer/push. */
  readonly offerToRemote: string[];
  /** The remote is behind on revocations — prioritize feeding it revocations (§17.3). */
  readonly remoteBehindRevocation: boolean;
}

/** Best-effort `cid_kind` from a (schema-validated) CID; `undefined` if malformed. */
function kindOf(cid: string): CidKind | undefined {
  try {
    return parseCid(cid).kind;
  } catch {
    return undefined;
  }
}

/**
 * Diff a remote pulse against local frontiers to produce wants + offers (§16.2).
 * Wants are ordered revocation-gap → checkpoint-gap → critical (the §17.1
 * frontiers-before-content order) and de-duplicated by CID.
 */
export function applyPulse(params: {
  readonly remote: SyncPulseV2;
  readonly localCheckpointFrontier: readonly CheckpointFrontierV2[];
  readonly localRevocationFrontier: readonly RevocationFrontierV2[];
  readonly locallyHave: (cid: string) => boolean;
}): PulseReaction {
  const wants: WantRequestV2[] = [];
  const wantedCids = new Set<string>();
  const pushWant = (cid: string, reason: WantRequestV2['reason']): void => {
    if (wantedCids.has(cid) || params.locallyHave(cid)) return;
    const cid_kind = kindOf(cid);
    if (cid_kind === undefined) return; // never want a malformed CID
    wantedCids.add(cid);
    wants.push({ cid, cid_kind, reason });
  };

  // 1) Revocation gaps first (§17.1 / §17.3).
  const revocation = compareRevocationFrontiers(
    params.localRevocationFrontier,
    params.remote.revocation_frontier,
  );
  for (const behind of revocation.weAreBehind) {
    if (behind.latest_revocation_checkpoint_cid !== undefined) {
      pushWant(behind.latest_revocation_checkpoint_cid, 'revocation_gap');
    }
  }

  // 2) Room checkpoint gaps.
  const checkpointBehind = diffCheckpointFrontiers(
    params.localCheckpointFrontier,
    params.remote.checkpoint_frontier,
  );
  for (const behind of checkpointBehind) {
    if (behind.latest_checkpoint_cid !== undefined) {
      pushWant(behind.latest_checkpoint_cid, 'checkpoint_gap');
    }
  }

  // 3) Any remaining critical objects the remote advertises that we lack.
  for (const cid of params.remote.critical_have ?? []) pushWant(cid, 'missing_dependency');

  // Offers: critical objects the remote wants that we hold.
  const offerToRemote: string[] = [];
  for (const cid of params.remote.critical_want ?? []) {
    if (params.locallyHave(cid)) offerToRemote.push(cid);
  }

  return { wants, offerToRemote, remoteBehindRevocation: revocation.remoteIsBehind.length > 0 };
}
