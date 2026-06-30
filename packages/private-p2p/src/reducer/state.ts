// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.5.4b — the deterministic reducer's room-state model (PRIVATE_SPEC §14.3).
// The reducer is a pure fold over the accepted ops in the §14.3.2 canonical
// order; two devices with the same accepted set MUST produce byte-identical
// state.  `roomStateCommitment` canonical-encodes the state (with sorted keys)
// so that property can be asserted directly (§14.3.3 / §26.1).

import { type CanonicalValue, canonical } from '../crypto/canonical.js';
import type { PrivateCapability, PrivateRole } from '../schemas/common.js';

export interface MemberState {
  readonly memberId: string;
  role: PrivateRole;
  capabilities: Set<PrivateCapability>;
  removed: boolean;
  /**
   * A NON-cryptographic, admin-chosen display name carried in the signed
   * `member.add` op (§12.3 / §14.3.3).  It converges across devices (it folds
   * from the same signed op everywhere) but NEVER participates in authority —
   * capability checks read `role`/`capabilities` keyed by `memberId` only.
   * `undefined` when no name was provided (e.g. the founder genesis).
   */
  displayName?: string;
}

export interface DeviceState {
  readonly deviceId: string;
  readonly memberId: string;
  readonly addedAtEpoch: number;
  removed: boolean;
  signingPublicKey: string;
  /** Tier-2 rendezvous-cap: the device's blind credential commitment (set by a
   *  `rendezvous.request` op; an admin re-signs it per epoch to issue, §6.2). */
  rendezvousCommitment?: string;
}

export interface StoryState {
  readonly storyId: string;
  readonly threadId: string;
  readonly authorMemberId: string;
  title: string;
  /** The story's UGC body (markdown-lite); `''` for a link/media story with no text. */
  bodyMarkdownLite: string;
  submissionType: string;
  topicIds: string[];
  tombstoned: boolean;
  editCount: number;
}

export interface ThreadState {
  readonly threadId: string;
  conversationState: string;
  safetyState: string;
}

export interface ContributionState {
  readonly contributionId: string;
  readonly threadId: string;
  readonly authorMemberId: string;
  contributionType: string;
  bodyMarkdownLite: string;
  parentContributionId: string | undefined;
  tombstoned: boolean;
  editCount: number;
}

export interface SummaryState {
  readonly summaryId: string;
  readonly threadId: string;
  readonly authorMemberId: string;
  bodyMarkdownLite: string;
  citedContributionIds: string[];
}

export interface AttachmentState {
  readonly attachmentId: string;
  readonly manifestCid: string;
  /** The object key wrapped under the epoch `content_wrap_key` (§10.5) — the key
   *  material a member unwraps to open the sealed manifest + chunks. */
  readonly wrappedObjectKey: string;
  /** The epoch the `attachment.add` op was authored under — i.e. the epoch whose
   *  `content_wrap_key` the object key is wrapped under (§10.5).  A fetcher needs it
   *  to unwrap the key + open the manifest/chunks (part of the §14.3.3 converged state,
   *  so it is committed + snapshot-serialized like every other field). */
  readonly epoch: number;
}

/** A recovery request's accumulated distinct admin authorizations (WS-S.3.6c). */
export interface RecoveryRequestState {
  readonly recoveryRequestId: string;
  readonly recoveringMemberId: string;
  /** The distinct admin DEVICE ids that have authorized (counted for the M-of-N). */
  authorizingDeviceIds: Set<string>;
}

/** A rejected op + the §14.2/§14.4 reason (quarantined; never rendered). */
export interface RejectedOp {
  readonly opId: string;
  readonly reason: string;
}

/** Tier-2 (§11): an AUTHORIZED `rendezvous.issue` — the per-epoch BBS issuer key + the per-device
 *  blind-credential signatures.  Recorded by the authority-enforcing fold ONLY when the issuer is
 *  `admin`-capable, so a non-admin's crypto-valid issue op (which `openOp` stores in `acceptedOps`
 *  before the reducer rejects it) NEVER reaches this — the engine sources installable issuances
 *  from here, not from raw accepted ops. */
export interface RendezvousIssuanceState {
  readonly targetEpoch: number;
  readonly issuerPublicKey: string;
  readonly credentials: ReadonlyArray<{ readonly device_id: string; readonly signature: string }>;
}

export interface RoomReducerState {
  members: Map<string, MemberState>;
  devices: Map<string, DeviceState>;
  stories: Map<string, StoryState>;
  threads: Map<string, ThreadState>;
  contributions: Map<string, ContributionState>;
  summaries: Map<string, SummaryState>;
  attachments: Map<string, AttachmentState>;
  recoveryRequests: Map<string, RecoveryRequestState>;
  /** Tier-2 admin-authorized issuances in canonical fold order (latest-wins downstream). */
  rendezvousIssuances: RendezvousIssuanceState[];
  /** `${deviceId}:${client_draft_id}` seen, for the §14.4 idempotent dedup. */
  seenClientDrafts: Set<string>;
  /** Accepted snapshot-commit op ids (optimization hints, §14.5). */
  snapshots: string[];
  rejected: RejectedOp[];
  epoch: number;
}

/**
 * §11.3 (PRIV-CRYPTO-1): whether `deviceId` may authorize a MEMBERSHIP CHANGE in `state` — it must be
 * a CURRENT, non-removed device whose member holds the `admin` capability (the capability that
 * `member.add` / `member.remove` / `device.remove` / `role.*` all require).  The room-manager gates an
 * incoming MLS commit on this BEFORE installing its new epoch keys, so a non-admin member's forged
 * Add (a ghost reader device) or Remove (an admin eviction) can never advance an honest member's epoch
 * — RFC 9420 has no admin role, so this room-layer rule is the §11.3 authority MLS itself lacks.
 * `undefined` (an unresolved committer leaf) ⇒ false (fail-closed).
 */
export function deviceMayManageMembership(
  state: Pick<RoomReducerState, 'devices' | 'members'>,
  deviceId: string | undefined,
): boolean {
  if (deviceId === undefined) return false;
  const device = state.devices.get(deviceId);
  if (!device || device.removed) return false;
  const member = state.members.get(device.memberId);
  return member !== undefined && !member.removed && member.capabilities.has('admin');
}

/** A fresh, empty room state. */
export function emptyRoomState(): RoomReducerState {
  return {
    members: new Map(),
    devices: new Map(),
    stories: new Map(),
    threads: new Map(),
    contributions: new Map(),
    summaries: new Map(),
    attachments: new Map(),
    recoveryRequests: new Map(),
    rendezvousIssuances: [],
    seenClientDrafts: new Set(),
    snapshots: [],
    rejected: [],
    epoch: 0,
  };
}

/** A deep clone of the reducer state (so a §14.5 snapshot base is never mutated
 *  by a seeded fold).  Mirrors every container in `RoomReducerState`. */
export function cloneRoomState(state: RoomReducerState): RoomReducerState {
  return {
    members: new Map(
      [...state.members].map(([k, v]) => [k, { ...v, capabilities: new Set(v.capabilities) }]),
    ),
    devices: new Map([...state.devices].map(([k, v]) => [k, { ...v }])),
    stories: new Map([...state.stories].map(([k, v]) => [k, { ...v, topicIds: [...v.topicIds] }])),
    threads: new Map([...state.threads].map(([k, v]) => [k, { ...v }])),
    contributions: new Map([...state.contributions].map(([k, v]) => [k, { ...v }])),
    summaries: new Map(
      [...state.summaries].map(([k, v]) => [
        k,
        { ...v, citedContributionIds: [...v.citedContributionIds] },
      ]),
    ),
    attachments: new Map([...state.attachments].map(([k, v]) => [k, { ...v }])),
    recoveryRequests: new Map(
      [...state.recoveryRequests].map(([k, v]) => [
        k,
        { ...v, authorizingDeviceIds: new Set(v.authorizingDeviceIds) },
      ]),
    ),
    rendezvousIssuances: state.rendezvousIssuances.map((i) => ({
      ...i,
      credentials: i.credentials.map((c) => ({ ...c })),
    })),
    seenClientDrafts: new Set(state.seenClientDrafts),
    snapshots: [...state.snapshots],
    rejected: [...state.rejected],
    epoch: state.epoch,
  };
}

/** Sort an iterable of [key, value] entries by key (UTF-8 bytewise via `<`). */
function sortedEntries<V>(map: ReadonlyMap<string, V>): Array<[string, V]> {
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function sortedStrings(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Canonical-encode the room state into a single byte string (sorted keys, sorted
 * sets) so equal logical state ⇒ equal bytes.  This is the §14.3.3 device-
 * convergence commitment: two devices with the same accepted op set produce a
 * byte-identical commitment regardless of op-delivery order.
 */
export function roomStateCommitment(state: RoomReducerState): Uint8Array {
  const value: CanonicalValue = {
    epoch: state.epoch,
    members: sortedEntries(state.members).map(([id, m]) => ({
      memberId: id,
      role: m.role,
      capabilities: sortedStrings(m.capabilities),
      removed: m.removed,
      displayName: m.displayName ?? null,
    })),
    devices: sortedEntries(state.devices).map(([id, d]) => ({
      deviceId: id,
      memberId: d.memberId,
      addedAtEpoch: d.addedAtEpoch,
      removed: d.removed,
      signingPublicKey: d.signingPublicKey,
    })),
    stories: sortedEntries(state.stories).map(([id, s]) => ({
      storyId: id,
      threadId: s.threadId,
      authorMemberId: s.authorMemberId,
      title: s.title,
      bodyMarkdownLite: s.bodyMarkdownLite,
      submissionType: s.submissionType,
      topicIds: s.topicIds,
      tombstoned: s.tombstoned,
      editCount: s.editCount,
    })),
    threads: sortedEntries(state.threads).map(([id, t]) => ({
      threadId: id,
      conversationState: t.conversationState,
      safetyState: t.safetyState,
    })),
    contributions: sortedEntries(state.contributions).map(([id, c]) => ({
      contributionId: id,
      threadId: c.threadId,
      authorMemberId: c.authorMemberId,
      contributionType: c.contributionType,
      bodyMarkdownLite: c.bodyMarkdownLite,
      parentContributionId: c.parentContributionId ?? null,
      tombstoned: c.tombstoned,
      editCount: c.editCount,
    })),
    summaries: sortedEntries(state.summaries).map(([id, s]) => ({
      summaryId: id,
      threadId: s.threadId,
      authorMemberId: s.authorMemberId,
      bodyMarkdownLite: s.bodyMarkdownLite,
      citedContributionIds: s.citedContributionIds,
    })),
    attachments: sortedEntries(state.attachments).map(([id, a]) => ({
      attachmentId: id,
      manifestCid: a.manifestCid,
      wrappedObjectKey: a.wrappedObjectKey,
      epoch: a.epoch,
    })),
    recoveryRequests: sortedEntries(state.recoveryRequests).map(([id, r]) => ({
      recoveryRequestId: id,
      recoveringMemberId: r.recoveringMemberId,
      authorizingDeviceIds: sortedStrings(r.authorizingDeviceIds),
    })),
    // Tier-2 issuances in fold order — so issuance divergence (a missing/extra authorized issue
    // op) is reflected in the commitment, not just the DAG frontier.
    rendezvousIssuances: state.rendezvousIssuances.map((i) => ({
      targetEpoch: i.targetEpoch,
      issuerPublicKey: i.issuerPublicKey,
      credentials: i.credentials.map((c) => ({ deviceId: c.device_id, signature: c.signature })),
    })),
    snapshots: sortedStrings(state.snapshots),
  };
  return canonical(value);
}
