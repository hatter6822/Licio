// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.5.4b + WS-S.5.5 — the deterministic reducer: a PURE fold over the accepted
// ops in the §14.3.2 canonical total order.  Two devices with the same accepted
// op set produce byte-identical state (§14.3.3), regardless of op-delivery order.
// Authority is enforced HERE, against the EVOLVING room capability state (never a
// platform role, §11.4): an op applies only if its author is a current,
// non-removed device whose member holds the required capability AT that point in
// the order.  The §14.4 conflict policy is resolved by total-order position
// ("latest valid author edit wins"), the moderator-tombstone-hides rule, the
// removed-member rejection, and the per-author-device `client_draft_id` dedup.
//
// Genesis: the FIRST op in canonical order must be a `member.add` whose member +
// device are the author's own (the founder's self-add, §12.1) — the one
// self-authorizing op; every later op is capability-checked.

import {
  CONTRIBUTION_BODY_LIMITS,
  type ContributionType,
  MAX_CONTRIBUTION_DEPTH,
} from '@licio/shared';
import type { PrivateOpBody, PrivateRoomOp } from '../schemas/ops.js';
import { capabilitiesForRole, OP_REQUIRED_CAPABILITY } from './capabilities.js';
import { canonicalOpOrder } from './order.js';
import {
  cloneRoomState,
  emptyRoomState,
  type MemberState,
  type RoomReducerState,
} from './state.js';

type OpOf<T extends PrivateOpBody['type']> = Extract<PrivateOpBody, { type: T }>;

function reject(state: RoomReducerState, opId: string, reason: string): void {
  state.rejected.push({ opId, reason });
}

/** Whether `member` may apply `op` (capability + the §14.4 creator-or-moderate
 *  rule for edits/tombstones), against the current state. */
function authorMayApply(state: RoomReducerState, op: PrivateRoomOp, member: MemberState): boolean {
  const body = op.body;
  if (body.type === 'story.edit' || body.type === 'story.tombstone') {
    if (member.capabilities.has('moderate')) return true;
    const story = state.stories.get(body.story_id);
    return (
      story !== undefined &&
      story.authorMemberId === op.author_member_id &&
      member.capabilities.has('post')
    );
  }
  if (body.type === 'contribution.edit' || body.type === 'contribution.tombstone') {
    if (member.capabilities.has('moderate')) return true;
    const contribution = state.contributions.get(body.contribution_id);
    return (
      contribution !== undefined &&
      contribution.authorMemberId === op.author_member_id &&
      member.capabilities.has('post')
    );
  }
  return member.capabilities.has(OP_REQUIRED_CAPABILITY[body.type]);
}

function applyMemberAdd(state: RoomReducerState, body: OpOf<'member.add'>, epoch: number): void {
  const existing = state.members.get(body.member_id);
  if (!existing) {
    state.members.set(body.member_id, {
      memberId: body.member_id,
      role: body.granted_role,
      capabilities: capabilitiesForRole(body.granted_role),
      removed: false,
      // Non-cryptographic display name (never affects authority, §11.4).
      ...(body.display_name !== undefined ? { displayName: body.display_name } : {}),
    });
  } else if (existing.removed) {
    // Re-admit a previously-removed member (e.g. the §12.6.1 threshold-recovery
    // re-add of a `recovering_member_id`): clear the tombstone and restore the
    // granted role's capabilities, otherwise every later op from the member stays
    // rejected as `author_member_removed` even though a new device is added below.
    existing.removed = false;
    existing.role = body.granted_role;
    existing.capabilities = capabilitiesForRole(body.granted_role);
    if (body.display_name !== undefined) existing.displayName = body.display_name;
  }
  // An existing, non-removed member is left untouched (idempotent — preserving any
  // role.grant/role.revoke deltas applied since the original add).
  if (!state.devices.has(body.device_id)) {
    state.devices.set(body.device_id, {
      deviceId: body.device_id,
      memberId: body.member_id,
      addedAtEpoch: epoch,
      removed: false,
      signingPublicKey: body.signing_public_key,
    });
  }
}

function applyMemberRemove(state: RoomReducerState, body: OpOf<'member.remove'>): void {
  const member = state.members.get(body.member_id);
  if (member) member.removed = true;
  for (const device of state.devices.values()) {
    if (device.memberId === body.member_id) device.removed = true;
  }
}

function applyDeviceRemove(state: RoomReducerState, body: OpOf<'device.remove'>): void {
  const device = state.devices.get(body.device_id);
  if (device && device.memberId === body.member_id) device.removed = true;
}

function applyRoleGrant(state: RoomReducerState, body: OpOf<'role.grant'>): void {
  const member = state.members.get(body.member_id);
  if (!member) return;
  if (body.role !== undefined) {
    member.role = body.role;
    member.capabilities = capabilitiesForRole(body.role);
  }
  if (body.capability !== undefined) member.capabilities.add(body.capability);
}

function applyRoleRevoke(state: RoomReducerState, body: OpOf<'role.revoke'>): void {
  const member = state.members.get(body.member_id);
  if (!member) return;
  if (body.role !== undefined && member.role === body.role) {
    member.role = 'member';
    member.capabilities = capabilitiesForRole('member');
  }
  if (body.capability !== undefined) member.capabilities.delete(body.capability);
}

function applyRecoveryAuthorize(
  state: RoomReducerState,
  op: PrivateRoomOp,
  body: OpOf<'recovery.authorize'>,
): void {
  let request = state.recoveryRequests.get(body.recovery_request_id);
  if (!request) {
    request = {
      recoveryRequestId: body.recovery_request_id,
      recoveringMemberId: body.recovering_member_id,
      authorizingDeviceIds: new Set(),
    };
    state.recoveryRequests.set(body.recovery_request_id, request);
  }
  request.authorizingDeviceIds.add(op.author_device_id);
}

function applyStoryCreate(
  state: RoomReducerState,
  op: PrivateRoomOp,
  body: OpOf<'story.create'>,
): void {
  if (state.stories.has(body.story_id)) return; // idempotent
  // One story per thread: reject a story that reuses a thread already owned by
  // another story.  The private-room UI renders comments by `threadId`, so sharing
  // a thread would conflate two stories' conversation streams.
  for (const existing of state.stories.values()) {
    if (existing.threadId === body.thread_id) {
      reject(state, op.op_id, 'thread_already_in_use');
      return;
    }
  }
  state.stories.set(body.story_id, {
    storyId: body.story_id,
    threadId: body.thread_id,
    authorMemberId: op.author_member_id,
    title: body.title,
    bodyMarkdownLite: body.body_markdown_lite ?? '',
    submissionType: body.submission_type,
    topicIds: [...body.topic_ids],
    tombstoned: false,
    editCount: 0,
  });
  if (!state.threads.has(body.thread_id)) {
    state.threads.set(body.thread_id, {
      threadId: body.thread_id,
      conversationState: 'active',
      safetyState: 'normal',
    });
  }
}

function applyStoryEdit(
  state: RoomReducerState,
  op: PrivateRoomOp,
  body: OpOf<'story.edit'>,
): void {
  const story = state.stories.get(body.story_id);
  if (!story) {
    reject(state, op.op_id, 'story_missing');
    return;
  }
  // Latest valid edit wins by total-order position; the body is overwritten,
  // but a moderator tombstone (if any) keeps the display hidden.
  if (body.title !== undefined) story.title = body.title;
  if (body.body_markdown_lite !== undefined) story.bodyMarkdownLite = body.body_markdown_lite;
  if (body.topic_ids !== undefined) story.topicIds = [...body.topic_ids];
  story.editCount += 1;
}

function applyStoryTombstone(
  state: RoomReducerState,
  op: PrivateRoomOp,
  body: OpOf<'story.tombstone'>,
): void {
  const story = state.stories.get(body.story_id);
  if (!story) {
    reject(state, op.op_id, 'story_missing');
    return;
  }
  story.tombstoned = true; // hides display; edit history (editCount) retained
}

function applyThreadState(state: RoomReducerState, body: OpOf<'thread.state'>): void {
  const thread = state.threads.get(body.thread_id);
  if (thread) {
    thread.conversationState = body.conversation_state;
    thread.safetyState = body.safety_state;
  } else {
    state.threads.set(body.thread_id, {
      threadId: body.thread_id,
      conversationState: body.conversation_state,
      safetyState: body.safety_state,
    });
  }
}

function applyContributionCreate(
  state: RoomReducerState,
  op: PrivateRoomOp,
  body: OpOf<'contribution.create'>,
): void {
  const draftKey = `${op.author_device_id}:${body.client_draft_id}`;
  if (state.seenClientDrafts.has(draftKey)) return; // §14.4 idempotent dedup
  if (state.contributions.has(body.contribution_id)) {
    state.seenClientDrafts.add(draftKey);
    return;
  }
  // The target thread must already exist (created by its story.create or a
  // thread.state).  An orphan contribution would otherwise persist + be searchable
  // and could later surface under a story that reuses the id, despite never
  // causally depending on it.
  if (!state.threads.has(body.thread_id)) {
    reject(state, op.op_id, 'thread_missing');
    return;
  }
  if (body.parent_contribution_id !== undefined) {
    const parent = state.contributions.get(body.parent_contribution_id);
    if (parent === undefined) {
      reject(state, op.op_id, 'parent_contribution_missing');
      return;
    }
    // A reply must live in the SAME thread as its parent (WS-G.1.2d-1 parity):
    // a cross-thread parent would orphan the node under another thread's tree.
    if (parent.threadId !== body.thread_id) {
      reject(state, op.op_id, 'parent_thread_mismatch');
      return;
    }
    // Enforce the max nesting depth (roots are depth 0) by walking the ancestor
    // chain.  `parentContributionId` is part of the converged state, so every
    // device counts the same depth ⇒ the same accept/reject ⇒ convergence — no
    // extra state field or commitment-format change is needed.
    let depth = 1;
    let ancestorId = parent.parentContributionId;
    while (ancestorId !== undefined) {
      depth += 1;
      ancestorId = state.contributions.get(ancestorId)?.parentContributionId;
    }
    if (depth > MAX_CONTRIBUTION_DEPTH) {
      reject(state, op.op_id, 'max_depth_exceeded');
      return;
    }
  }
  state.seenClientDrafts.add(draftKey);
  state.contributions.set(body.contribution_id, {
    contributionId: body.contribution_id,
    threadId: body.thread_id,
    authorMemberId: op.author_member_id,
    contributionType: body.contribution_type,
    bodyMarkdownLite: body.body_markdown_lite,
    parentContributionId: body.parent_contribution_id,
    tombstoned: false,
    editCount: 0,
  });
}

function applyContributionEdit(
  state: RoomReducerState,
  op: PrivateRoomOp,
  body: OpOf<'contribution.edit'>,
): void {
  const contribution = state.contributions.get(body.contribution_id);
  if (!contribution) {
    reject(state, op.op_id, 'contribution_missing');
    return;
  }
  if (body.body_markdown_lite !== undefined) {
    // The edit op carries no `contribution_type`, so enforce the per-type body cap
    // (WS-S.5.3c) against the type recorded in state — otherwise an edit could grow
    // a capped type (e.g. a correction's 2000 chars) up to the comment-sized schema max.
    const cap = CONTRIBUTION_BODY_LIMITS[contribution.contributionType as ContributionType];
    if (cap !== undefined && body.body_markdown_lite.trim().length > cap) {
      reject(state, op.op_id, 'body_too_long');
      return;
    }
    contribution.bodyMarkdownLite = body.body_markdown_lite;
  }
  contribution.editCount += 1;
}

function applyContributionTombstone(
  state: RoomReducerState,
  op: PrivateRoomOp,
  body: OpOf<'contribution.tombstone'>,
): void {
  const contribution = state.contributions.get(body.contribution_id);
  if (!contribution) {
    reject(state, op.op_id, 'contribution_missing');
    return;
  }
  contribution.tombstoned = true;
}

function applySummaryCreate(
  state: RoomReducerState,
  op: PrivateRoomOp,
  body: OpOf<'summary.create'>,
): void {
  if (state.summaries.has(body.summary_id)) return;
  state.summaries.set(body.summary_id, {
    summaryId: body.summary_id,
    threadId: body.thread_id,
    authorMemberId: op.author_member_id,
    bodyMarkdownLite: body.body_markdown_lite,
    citedContributionIds: [...body.cited_contribution_ids],
  });
}

function applyAttachmentAdd(
  state: RoomReducerState,
  body: OpOf<'attachment.add'>,
  epoch: number,
): void {
  if (!state.attachments.has(body.attachment_id)) {
    state.attachments.set(body.attachment_id, {
      attachmentId: body.attachment_id,
      manifestCid: body.manifest_cid,
      wrappedObjectKey: body.wrapped_object_key,
      epoch,
    });
  }
}

function applyOp(state: RoomReducerState, op: PrivateRoomOp): void {
  if (op.epoch > state.epoch) state.epoch = op.epoch;
  const body = op.body;

  // Genesis: the founder's self-add is the one self-authorizing op (§12.1).
  if (state.members.size === 0) {
    if (
      body.type === 'member.add' &&
      body.member_id === op.author_member_id &&
      body.device_id === op.author_device_id
    ) {
      applyMemberAdd(state, body, op.epoch);
      return;
    }
    reject(state, op.op_id, 'no_genesis_member_add');
    return;
  }

  // Author must be a current, non-removed device whose member is not removed.
  const device = state.devices.get(op.author_device_id);
  if (!device || device.removed || device.memberId !== op.author_member_id) {
    reject(state, op.op_id, 'author_device_not_active');
    return;
  }
  const member = state.members.get(op.author_member_id);
  if (!member || member.removed) {
    reject(state, op.op_id, 'author_member_removed');
    return;
  }
  if (!authorMayApply(state, op, member)) {
    reject(state, op.op_id, 'not_authorized');
    return;
  }

  switch (body.type) {
    case 'member.add':
      applyMemberAdd(state, body, op.epoch);
      return;
    case 'member.remove':
      applyMemberRemove(state, body);
      return;
    case 'device.remove':
      applyDeviceRemove(state, body);
      return;
    case 'role.grant':
      applyRoleGrant(state, body);
      return;
    case 'role.revoke':
      applyRoleRevoke(state, body);
      return;
    case 'member.invite.create':
      return; // an authorized invite op carries no content-state change
    case 'recovery.authorize':
      applyRecoveryAuthorize(state, op, body);
      return;
    case 'story.create':
      applyStoryCreate(state, op, body);
      return;
    case 'story.edit':
      applyStoryEdit(state, op, body);
      return;
    case 'story.tombstone':
      applyStoryTombstone(state, op, body);
      return;
    case 'thread.state':
      applyThreadState(state, body);
      return;
    case 'contribution.create':
      applyContributionCreate(state, op, body);
      return;
    case 'contribution.edit':
      applyContributionEdit(state, op, body);
      return;
    case 'contribution.tombstone':
      applyContributionTombstone(state, op, body);
      return;
    case 'summary.create':
      applySummaryCreate(state, op, body);
      return;
    case 'attachment.add':
      applyAttachmentAdd(state, body, op.epoch);
      return;
    case 'snapshot.commit':
      state.snapshots.push(body.snapshot_id);
      return;
    case 'rendezvous.request':
      applyRendezvousRequest(state, op, body);
      return;
    case 'rendezvous.issue':
      // Reached ONLY after `authorMayApply` confirmed the author is `admin` (the §11 issue
      // capability) — so this records an AUTHORIZED issuance.  The engine installs credentials
      // from THIS reduced list, never from raw accepted ops (where a non-admin's crypto-valid
      // issue op would otherwise sit before the reducer rejects it).
      state.rendezvousIssuances.push({
        targetEpoch: body.target_epoch,
        issuerPublicKey: body.issuer_public_key,
        credentials: body.credentials,
      });
      return;
  }
}

/** Tier-2 rendezvous cap: the author device records its OWN blind credential commitment
 *  (`read`-capable, validated active in applyOp). An admin re-signs it per epoch (§6.2). */
function applyRendezvousRequest(
  state: RoomReducerState,
  op: PrivateRoomOp,
  body: OpOf<'rendezvous.request'>,
): void {
  const device = state.devices.get(op.author_device_id);
  if (device) device.rendezvousCommitment = body.commitment_with_proof;
}

/**
 * Reduce a set of ACCEPTED ops (validated per §14.2) to room state via a pure
 * fold in the §14.3.2 canonical total order.  Deterministic: the output is a
 * function of the op SET only, never delivery order.
 *
 * `baseState` (§14.5) seeds the fold from a verified snapshot's state, so the
 * caller can fold only POST-snapshot ops after old ops are compacted; the result
 * equals a full fold of every op iff the snapshot covers a causally-closed
 * prefix (which `PrivateRoomEngine` guarantees — it snapshots at its own heads).
 * The base is cloned, never mutated.
 */
export function reduceRoom(
  acceptedOps: readonly PrivateRoomOp[],
  baseState?: RoomReducerState,
): RoomReducerState {
  const state = baseState ? cloneRoomState(baseState) : emptyRoomState();
  for (const op of canonicalOpOrder(acceptedOps)) {
    applyOp(state, op);
  }
  return state;
}
