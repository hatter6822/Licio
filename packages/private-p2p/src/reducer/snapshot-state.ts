// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.5.9 — full reducer-state (de)serialization for §14.5 snapshots.  A
// snapshot body must restore the COMPLETE reduced state (so post-snapshot ops can
// fold on top after old ops are compacted), unlike `roomStateCommitment` which
// canonical-encodes only the commitment subset for the state root.  Capabilities
// are NOT serialized — they are re-derived from each member's role on load (the
// fold always sets `capabilities = capabilitiesForRole(role)`), so the snapshot
// can never carry a capability set inconsistent with the role.  The body is sealed
// before it leaves the device; its integrity on load is the §14.5 verify-before-
// use root check, so a plain JSON encoding is sufficient here.

import { z } from 'zod';
import { fromUtf8, utf8 } from '../crypto/runtime.js';
import { privateRoleSchema } from '../schemas/common.js';
import { capabilitiesForRole } from './capabilities.js';
import { emptyRoomState, type RoomReducerState } from './state.js';

const snapshotStateSchema = z
  .object({
    schema: z.literal('licio.private.reducer-state.v1'),
    epoch: z.number().int().min(0),
    members: z.array(
      z.object({ memberId: z.string(), role: privateRoleSchema, removed: z.boolean() }).strict(),
    ),
    devices: z.array(
      z
        .object({
          deviceId: z.string(),
          memberId: z.string(),
          addedAtEpoch: z.number().int().min(0),
          removed: z.boolean(),
          signingPublicKey: z.string(),
        })
        .strict(),
    ),
    stories: z.array(
      z
        .object({
          storyId: z.string(),
          threadId: z.string(),
          authorMemberId: z.string(),
          title: z.string(),
          submissionType: z.string(),
          topicIds: z.array(z.string()),
          tombstoned: z.boolean(),
          editCount: z.number().int().min(0),
        })
        .strict(),
    ),
    threads: z.array(
      z
        .object({
          threadId: z.string(),
          conversationState: z.string(),
          safetyState: z.string(),
        })
        .strict(),
    ),
    contributions: z.array(
      z
        .object({
          contributionId: z.string(),
          threadId: z.string(),
          authorMemberId: z.string(),
          contributionType: z.string(),
          bodyMarkdownLite: z.string(),
          parentContributionId: z.string().optional(),
          tombstoned: z.boolean(),
          editCount: z.number().int().min(0),
        })
        .strict(),
    ),
    summaries: z.array(
      z
        .object({
          summaryId: z.string(),
          threadId: z.string(),
          authorMemberId: z.string(),
          bodyMarkdownLite: z.string(),
          citedContributionIds: z.array(z.string()),
        })
        .strict(),
    ),
    attachments: z.array(z.object({ attachmentId: z.string(), manifestCid: z.string() }).strict()),
    recoveryRequests: z.array(
      z
        .object({
          recoveryRequestId: z.string(),
          recoveringMemberId: z.string(),
          authorizingDeviceIds: z.array(z.string()),
        })
        .strict(),
    ),
    seenClientDrafts: z.array(z.string()),
    snapshots: z.array(z.string()),
  })
  .strict();

/** Serialize the COMPLETE reduced state into a snapshot body (the transient
 *  `rejected` list is excluded — re-derived when post-snapshot ops fold). */
export function serializeReducerState(state: RoomReducerState): Uint8Array {
  const body: z.infer<typeof snapshotStateSchema> = {
    schema: 'licio.private.reducer-state.v1',
    epoch: state.epoch,
    members: [...state.members.values()].map((m) => ({
      memberId: m.memberId,
      role: m.role,
      removed: m.removed,
    })),
    devices: [...state.devices.values()].map((d) => ({
      deviceId: d.deviceId,
      memberId: d.memberId,
      addedAtEpoch: d.addedAtEpoch,
      removed: d.removed,
      signingPublicKey: d.signingPublicKey,
    })),
    stories: [...state.stories.values()].map((s) => ({
      storyId: s.storyId,
      threadId: s.threadId,
      authorMemberId: s.authorMemberId,
      title: s.title,
      submissionType: s.submissionType,
      topicIds: [...s.topicIds],
      tombstoned: s.tombstoned,
      editCount: s.editCount,
    })),
    threads: [...state.threads.values()].map((t) => ({
      threadId: t.threadId,
      conversationState: t.conversationState,
      safetyState: t.safetyState,
    })),
    contributions: [...state.contributions.values()].map((c) => ({
      contributionId: c.contributionId,
      threadId: c.threadId,
      authorMemberId: c.authorMemberId,
      contributionType: c.contributionType,
      bodyMarkdownLite: c.bodyMarkdownLite,
      ...(c.parentContributionId === undefined
        ? {}
        : { parentContributionId: c.parentContributionId }),
      tombstoned: c.tombstoned,
      editCount: c.editCount,
    })),
    summaries: [...state.summaries.values()].map((s) => ({
      summaryId: s.summaryId,
      threadId: s.threadId,
      authorMemberId: s.authorMemberId,
      bodyMarkdownLite: s.bodyMarkdownLite,
      citedContributionIds: [...s.citedContributionIds],
    })),
    attachments: [...state.attachments.values()].map((a) => ({
      attachmentId: a.attachmentId,
      manifestCid: a.manifestCid,
    })),
    recoveryRequests: [...state.recoveryRequests.values()].map((r) => ({
      recoveryRequestId: r.recoveryRequestId,
      recoveringMemberId: r.recoveringMemberId,
      authorizingDeviceIds: [...r.authorizingDeviceIds],
    })),
    seenClientDrafts: [...state.seenClientDrafts],
    snapshots: [...state.snapshots],
  };
  return utf8(JSON.stringify(body));
}

/** Restore a `RoomReducerState` from a snapshot body (fail-closed via zod; caps
 *  re-derived from each member's role). */
export function deserializeReducerState(bytes: Uint8Array): RoomReducerState {
  const parsed: unknown = JSON.parse(fromUtf8(bytes));
  const body = snapshotStateSchema.parse(parsed);
  const state = emptyRoomState();
  state.epoch = body.epoch;
  for (const m of body.members) {
    state.members.set(m.memberId, {
      memberId: m.memberId,
      role: m.role,
      capabilities: capabilitiesForRole(m.role),
      removed: m.removed,
    });
  }
  for (const d of body.devices) {
    state.devices.set(d.deviceId, {
      deviceId: d.deviceId,
      memberId: d.memberId,
      addedAtEpoch: d.addedAtEpoch,
      removed: d.removed,
      signingPublicKey: d.signingPublicKey,
    });
  }
  for (const s of body.stories) {
    state.stories.set(s.storyId, {
      storyId: s.storyId,
      threadId: s.threadId,
      authorMemberId: s.authorMemberId,
      title: s.title,
      submissionType: s.submissionType,
      topicIds: [...s.topicIds],
      tombstoned: s.tombstoned,
      editCount: s.editCount,
    });
  }
  for (const t of body.threads) {
    state.threads.set(t.threadId, {
      threadId: t.threadId,
      conversationState: t.conversationState,
      safetyState: t.safetyState,
    });
  }
  for (const c of body.contributions) {
    state.contributions.set(c.contributionId, {
      contributionId: c.contributionId,
      threadId: c.threadId,
      authorMemberId: c.authorMemberId,
      contributionType: c.contributionType,
      bodyMarkdownLite: c.bodyMarkdownLite,
      parentContributionId: c.parentContributionId,
      tombstoned: c.tombstoned,
      editCount: c.editCount,
    });
  }
  for (const s of body.summaries) {
    state.summaries.set(s.summaryId, {
      summaryId: s.summaryId,
      threadId: s.threadId,
      authorMemberId: s.authorMemberId,
      bodyMarkdownLite: s.bodyMarkdownLite,
      citedContributionIds: [...s.citedContributionIds],
    });
  }
  for (const a of body.attachments) {
    state.attachments.set(a.attachmentId, {
      attachmentId: a.attachmentId,
      manifestCid: a.manifestCid,
    });
  }
  for (const r of body.recoveryRequests) {
    state.recoveryRequests.set(r.recoveryRequestId, {
      recoveryRequestId: r.recoveryRequestId,
      recoveringMemberId: r.recoveringMemberId,
      authorizingDeviceIds: new Set(r.authorizingDeviceIds),
    });
  }
  for (const draft of body.seenClientDrafts) state.seenClientDrafts.add(draft);
  state.snapshots = [...body.snapshots];
  return state;
}
