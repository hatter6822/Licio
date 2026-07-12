// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.12.2 — LCAP server-ingestion durable state (the `LcapServerStore` backend).
// The content-addressed object store, the per-room canonical acceptance log, the
// device-sequence claimant index (authoritative fork detection), and append-only
// fork evidence.  No FK edges into user/content data: LCAP records are
// self-authenticating (COSE proofs the engine verifies), addressed by CID — this is
// the offline-availability data plane, isolated from the core relational model.

import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea } from './_custom.js';
import { takedownTargetTypeEnum } from './takedown.js';
import { users } from './user.js';

/** Content-addressed objects (records / proofs / blocks / chunks), keyed by CID. */
export const lcapObjects = pgTable('lcap_objects', {
  cid: text('cid').primaryKey(),
  kind: text('kind').notNull(), // 'record' | 'proof' | 'block' | 'chunk'
  bytes: bytea('bytes').notNull(),
});

/** Per-room canonical acceptance log: one row per accepted record, ordered by seq. */
export const lcapAcceptance = pgTable(
  'lcap_acceptance',
  {
    roomId: text('room_id').notNull(),
    seq: integer('seq').notNull(),
    cid: text('cid').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.roomId, t.seq] }),
    // A record is accepted exactly once (idempotency) → globally unique CID.
    uniqueIndex('lcap_acceptance_cid_uq').on(t.cid),
  ],
);

/**
 * Per-capability aggregate usage (§11.3 / §18.3 step 9): the running event count, total
 * payload bytes, and media bytes a capability has spent, so the server enforces
 * `max_offline_events`, `max_total_payload_bytes`, and `max_media_bytes` across a device's
 * offline events.  Incremented atomically as part of acceptance (the increment is tied to a
 * freshly-accepted record, so it is idempotent by `record_cid` and a re-submit never
 * double-debits).  `media_bytes` is the summed stored size of the media blocks each accepted
 * contribution ships (its referenced blocks present at accept).  Keyed by the stable grant id
 * (`capability_id`), not the content CID.
 */
export const lcapCapabilityUsage = pgTable('lcap_capability_usage', {
  capabilityId: text('capability_id').primaryKey(),
  eventCount: integer('event_count').notNull().default(0),
  totalBytes: bigint('total_bytes', { mode: 'number' }).notNull().default(0),
  mediaBytes: bigint('media_bytes', { mode: 'number' }).notNull().default(0),
});

/** The device-sequence claimant index: the first record to claim a (key, seq) wins. */
export const lcapDeviceSeq = pgTable(
  'lcap_device_seq',
  {
    deviceKeyId: text('device_key_id').notNull(),
    deviceSeq: integer('device_seq').notNull(),
    cid: text('cid').notNull(),
  },
  (t) => [primaryKey({ columns: [t.deviceKeyId, t.deviceSeq] })],
);

/** Append-only fork evidence (§24.3): two distinct CIDs at one (device key, seq). */
export const lcapForkEvidence = pgTable('lcap_fork_evidence', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  authorDeviceKeyId: text('author_device_key_id').notNull(),
  deviceSeq: integer('device_seq').notNull(),
  existingCid: text('existing_cid').notNull(),
  conflictingCid: text('conflicting_cid').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Record-export closure edges (WS-R.12.4 §29.8): record→proof + record→block edges
 * captured at import, so a room export can gather each record's trust + media closure
 * without scanning the whole CAS.  CID-addressed (no FK edges; the offline plane).
 *
 * The REVERSE index `(related_cid, relation)` (migration 0050) supports the §29 public-serve
 * visibility gate (`recordsReferencing`): resolving a wanted block/proof CID to its owning
 * record(s) to decide public-servability, on the serve hot path, without a full-table scan.
 */
export const lcapRecordClosure = pgTable(
  'lcap_record_closure',
  {
    recordCid: text('record_cid').notNull(),
    relatedCid: text('related_cid').notNull(),
    relation: text('relation').notNull(), // 'proof' | 'block' | 'identity'
  },
  (t) => [
    primaryKey({ columns: [t.recordCid, t.relatedCid, t.relation] }),
    index('lcap_record_closure_related_idx').on(t.relatedCid, t.relation),
  ],
);

/**
 * Gate-19 (WS-R.15.7 / WS-S.4.4) — the `block_cid` ⇄ content-entity provenance map.
 *
 * A public LCAP `block_cid` (`CIDv1(raw, sha2-256)` over plaintext) carries no inherent
 * pointer back to the WS-F content entity (a story / source) it was
 * derived from — yet a WS-J takedown targets exactly such an entity by
 * `(target_type, target_id)` (see `takedown_requests`).  Without a linkage, the IPFS
 * public-block bridge cannot answer the only question the §22.7 republication halt needs:
 * "is THIS block's source content currently taken down?"  This table is that linkage: one
 * row per `(block_cid, target_type, target_id)` so the `DrizzleTakedownOracle` joins a
 * block CID to its content entity and then to the live `takedown_requests` status.
 *
 * `target_type` REUSES the `takedown_requests` enum (story / source) so the
 * oracle's join is type-aligned (same enum, same uuid id) — a block's provenance target and
 * a takedown's target are the same coordinate.  A block may derive from more than one
 * entity (e.g. a block deriving from more than one story), so the PK spans all three columns and
 * the same `block_cid` may appear with multiple targets; ANY in-force takedown over ANY of
 * its targets halts (re)publication (fail-closed union).  No FK into the content tables: the
 * offline plane is CID-addressed and isolated from the relational model (matching the rest
 * of `lcap.*`), and a content row's hard purge must never cascade-delete the provenance the
 * takedown halt relies on — the entity id is the durable coordinate the takedown also keys.
 */
export const lcapBlockProvenance = pgTable(
  'lcap_block_provenance',
  {
    blockCid: text('block_cid').notNull(),
    targetType: takedownTargetTypeEnum('target_type').notNull(),
    /** The content entity id (story/source) — the same coordinate a takedown targets. */
    targetId: text('target_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.blockCid, t.targetType, t.targetId] }),
    // The oracle's hot path: resolve a block CID to its targets, then join the takedowns.
    index('lcap_block_provenance_block_idx').on(t.blockCid),
    // The reverse direction: when a takedown is actioned, find every block it taints.
    index('lcap_block_provenance_target_idx').on(t.targetType, t.targetId),
  ],
);

/**
 * Gate-19 (WS-R.15.7b, OFFLINE_SPEC §22.7) — the privacy/moderation/abuse-review decision per
 * content entity for PUBLIC-DHT publication.
 *
 * §22.7 requires a "required privacy/moderation/abuse-review gate before any block reaches the
 * public DHT".  The takedown oracle answers "was this REMOVED?"; this table answers the prior,
 * affirmative question "was this content REVIEWED and APPROVED for public-DHT egress?".  A
 * public block is publishable only when its source content entity has an `approved` row here.
 * Keyed by exactly the `(target_type, target_id)` coordinate the takedown / provenance use, so
 * one durable review state covers a content entity regardless of how many blocks derive from
 * it (PK = the coordinate; the latest decision replaces the prior via upsert).
 *
 * `state`: 'pending' (under review — refuses) / 'approved' (the ONLY publishable state) /
 * 'rejected' (refuses).  `reviewer_user_id` is the steward who decided (kept for audit; the
 * users FK `set null` on a hard purge so the decision row stays — accountability outlives the
 * account, like `takedown_requests.actioned_by`).  No FK into the content tables: the offline
 * plane is CID/coordinate-addressed and isolated from the relational model.
 */
export const lcapBlockPublishReview = pgTable(
  'lcap_block_publish_review',
  {
    targetType: takedownTargetTypeEnum('target_type').notNull(),
    targetId: text('target_id').notNull(),
    state: text('state').notNull(), // 'pending' | 'approved' | 'rejected'
    reviewerUserId: uuid('reviewer_user_id').references(() => users.userId, {
      onDelete: 'set null',
    }),
    note: text('note'),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.targetType, t.targetId] }),
    index('lcap_block_publish_review_state_idx').on(t.state),
  ],
);

/**
 * Gate-19 (WS-R.15.7b) — the append-only audit of every public-DHT (re)publish DECISION.
 *
 * §22.7 requires "auditable provenance"; the acceptance criterion is "the gate decision is
 * audited".  One row per publish/republish ATTEMPT (pinned OR refused), capturing the actor,
 * the block, the resolved content target, the §22.7 review-gate verdict, the takedown
 * re-check verdict, and the final outcome — the durable, queryable trail the
 * `PublishOutcome.reason` HTTP response cannot provide.  Append-only: migration 0049 grants
 * INSERT/SELECT only (no UPDATE/DELETE), mirroring the WS-J moderation append-only posture.
 * `actor_user_id` is the steward who initiated it (users FK `set null` on a hard purge, so the
 * decision record outlives the account, like the moderation audit).
 */
export const lcapPublishAudit = pgTable(
  'lcap_publish_audit',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    action: text('action').notNull(), // 'publish' | 'republish'
    blockCid: text('block_cid').notNull(),
    targetType: takedownTargetTypeEnum('target_type'),
    targetId: text('target_id'),
    actorUserId: uuid('actor_user_id').references(() => users.userId, { onDelete: 'set null' }),
    reviewVerdict: text('review_verdict').notNull(), // 'approved' | 'review_required' | 'skipped' | 'error'
    takedownVerdict: text('takedown_verdict').notNull(), // 'clear' | 'halt' | 'unreadable'
    published: boolean('published').notNull(),
    outcomeReason: text('outcome_reason').notNull(),
    ipfsCid: text('ipfs_cid'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('lcap_publish_audit_block_idx').on(t.blockCid),
    index('lcap_publish_audit_created_idx').on(t.createdAt),
  ],
);

export type LcapObjectRow = typeof lcapObjects.$inferSelect;
export type LcapAcceptanceRow = typeof lcapAcceptance.$inferSelect;
export type LcapCapabilityUsageRow = typeof lcapCapabilityUsage.$inferSelect;
export type LcapDeviceSeqRow = typeof lcapDeviceSeq.$inferSelect;
export type LcapForkEvidenceRow = typeof lcapForkEvidence.$inferSelect;
export type LcapRecordClosureRow = typeof lcapRecordClosure.$inferSelect;
export type LcapBlockProvenanceRow = typeof lcapBlockProvenance.$inferSelect;
export type LcapBlockProvenanceInsert = typeof lcapBlockProvenance.$inferInsert;
export type LcapBlockPublishReviewRow = typeof lcapBlockPublishReview.$inferSelect;
export type LcapBlockPublishReviewInsert = typeof lcapBlockPublishReview.$inferInsert;
export type LcapPublishAuditRow = typeof lcapPublishAudit.$inferSelect;
export type LcapPublishAuditInsert = typeof lcapPublishAudit.$inferInsert;
