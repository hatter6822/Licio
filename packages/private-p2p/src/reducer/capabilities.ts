// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.5.1 — the §11.3 capability model: room-LOCAL capabilities, signed into
// the op log, NEVER a platform role (§11.4 — no platform admin/steward/support/
// emergency key can authorize a private-room op; the reducer reads room
// capability state only).  The role→capability mapping is the §11.3 table.

import type { PrivateCapability, PrivateRole } from '../schemas/common.js';

/** The §11.3 suggested role → capability mapping (the SSOT the reducer derives). */
export const ROLE_CAPABILITIES: Readonly<Record<PrivateRole, readonly PrivateCapability[]>> = {
  member: ['read', 'post'],
  moderator: ['read', 'post', 'moderate', 'summarize'],
  admin: ['read', 'post', 'invite', 'moderate', 'summarize', 'admin', 'rotate_keys'],
  recovery_admin: ['rotate_keys', 'recover', 'invite', 'admin'],
};

/** The capability set granted by a role. */
export function capabilitiesForRole(role: PrivateRole): Set<PrivateCapability> {
  return new Set(ROLE_CAPABILITIES[role]);
}

/** The op-body `type` discriminator (the keys the reducer dispatches on). */
export type PrivateOpType =
  | 'member.add'
  | 'member.remove'
  | 'device.remove'
  | 'role.grant'
  | 'role.revoke'
  | 'member.invite.create'
  | 'recovery.authorize'
  | 'story.create'
  | 'story.edit'
  | 'story.tombstone'
  | 'thread.state'
  | 'contribution.create'
  | 'contribution.edit'
  | 'contribution.tombstone'
  | 'summary.create'
  | 'attachment.add'
  | 'snapshot.commit'
  | 'rendezvous.request'
  | 'rendezvous.issue';

/**
 * The capability an op type REQUIRES of its author (§11.3 / §14.2 step 11).
 * Edit/tombstone of one's OWN content additionally accepts the author being the
 * original creator (resolved in the fold, WS-S.5.4b); this is the baseline a
 * non-owner needs.
 */
export const OP_REQUIRED_CAPABILITY: Readonly<Record<PrivateOpType, PrivateCapability>> = {
  'member.add': 'admin',
  'member.remove': 'admin',
  'device.remove': 'admin',
  'role.grant': 'admin',
  'role.revoke': 'admin',
  'member.invite.create': 'invite',
  'recovery.authorize': 'recover',
  'story.create': 'post',
  // edit/tombstone baseline is `post` (the creator's bar); the fold additionally
  // allows a `moderate`-capable non-creator (§14.4 moderator tombstone).
  'story.edit': 'post',
  'story.tombstone': 'post',
  'thread.state': 'moderate',
  'contribution.create': 'post',
  'contribution.edit': 'post',
  'contribution.tombstone': 'post',
  'summary.create': 'summarize',
  'attachment.add': 'post',
  'snapshot.commit': 'admin',
  // A member self-publishes its rendezvous commitment; an admin issues credentials.
  'rendezvous.request': 'read',
  'rendezvous.issue': 'admin',
};
