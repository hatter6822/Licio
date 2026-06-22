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
}

export interface DeviceState {
  readonly deviceId: string;
  readonly memberId: string;
  readonly addedAtEpoch: number;
  removed: boolean;
  signingPublicKey: string;
}

export interface StoryState {
  readonly storyId: string;
  readonly threadId: string;
  readonly authorMemberId: string;
  title: string;
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

export interface RoomReducerState {
  members: Map<string, MemberState>;
  devices: Map<string, DeviceState>;
  stories: Map<string, StoryState>;
  threads: Map<string, ThreadState>;
  contributions: Map<string, ContributionState>;
  summaries: Map<string, SummaryState>;
  attachments: Map<string, AttachmentState>;
  recoveryRequests: Map<string, RecoveryRequestState>;
  /** `${deviceId}:${client_draft_id}` seen, for the §14.4 idempotent dedup. */
  seenClientDrafts: Set<string>;
  /** Accepted snapshot-commit op ids (optimization hints, §14.5). */
  snapshots: string[];
  rejected: RejectedOp[];
  epoch: number;
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
    seenClientDrafts: new Set(),
    snapshots: [],
    rejected: [],
    epoch: 0,
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
    })),
    recoveryRequests: sortedEntries(state.recoveryRequests).map(([id, r]) => ({
      recoveryRequestId: id,
      recoveringMemberId: r.recoveringMemberId,
      authorizingDeviceIds: sortedStrings(r.authorizingDeviceIds),
    })),
    snapshots: sortedStrings(state.snapshots),
  };
  return canonical(value);
}
