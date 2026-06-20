// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Contribution event record + the WS-G / WS-Q mapping (OFFLINE_SPEC §12.1,
// WS-R.2.1).  Two total translations bridge LCAP's own visibility enum
// (`public | in_room | private`) and the shipped WS-Q story model
// (`public | room_only`), so an accepted LCAP record round-trips into the WS-Q
// `stories` schema with no ad-hoc coercion or rejected value:
//
//   L → S:  public → public · in_room → room_only · private → (never a story)
//   S → L:  public → public · room_only → in_room
//
// `private` is reserved for WS-S `private_p2p` content that LCAP carries ONLY as
// ciphertext (WS-R.16.1) — it never becomes a server-visible story.  The
// `event_type → LcapOperation` map gates which capability operation a
// contribution requires (consumed by the identity-chain validator).

import type { StoryVisibility } from '@licio/shared';
import { encodeWithSchema } from '../schemas/codec.js';
import type { LcapOperation, LcapVisibilityScope } from '../schemas/common.js';
import {
  type ContributionEventRecordV2,
  contributionEventRecordV2Schema,
} from '../schemas/records.js';

type ContributionEventType = ContributionEventRecordV2['event_type'];

/** The §12.1 event types mapped onto the capability operation each one requires. */
const EVENT_TYPE_OPERATION: Readonly<Record<ContributionEventType, LcapOperation>> = {
  post: 'post',
  question: 'post',
  answer: 'reply',
  evidence: 'reply',
  correction: 'reply',
  synthesis: 'reply',
  counterexample: 'reply',
  clarification: 'reply',
  edit: 'edit',
  tombstone: 'tombstone',
  moderation_action: 'moderate',
  source_snapshot_ref: 'source_snapshot',
};

/** The capability `LcapOperation` a contribution of `eventType` requires. */
export function operationForEventType(eventType: ContributionEventType): LcapOperation {
  return EVENT_TYPE_OPERATION[eventType];
}

/**
 * Map an LCAP visibility scope to a WS-Q story visibility.  `private` returns
 * `null`: such a record is WS-S ciphertext only and is NEVER reconciled into a
 * server `stories` row.
 */
export function mapLcapVisibilityToStory(scope: LcapVisibilityScope): StoryVisibility | null {
  switch (scope) {
    case 'public':
      return 'public';
    case 'in_room':
      return 'room_only';
    case 'private':
      return null;
  }
}

/** Map a WS-Q story visibility back to an LCAP visibility scope (total). */
export function mapStoryVisibilityToLcap(visibility: StoryVisibility): LcapVisibilityScope {
  return visibility === 'public' ? 'public' : 'in_room';
}

/**
 * Encode a contribution event to its deterministic LDC body (the §9.2 CID
 * preimage).  Body text and attachments are block references, never inline, so
 * normalization of human text can never perturb `record_cid`.
 */
export function encodeContributionEvent(record: ContributionEventRecordV2): Uint8Array {
  return encodeWithSchema(contributionEventRecordV2Schema, record);
}
