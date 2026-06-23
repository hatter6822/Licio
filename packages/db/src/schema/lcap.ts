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
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { bytea } from './_custom.js';
import { takedownTargetTypeEnum } from './takedown.js';

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
 */
export const lcapRecordClosure = pgTable(
  'lcap_record_closure',
  {
    recordCid: text('record_cid').notNull(),
    relatedCid: text('related_cid').notNull(),
    relation: text('relation').notNull(), // 'proof' | 'block'
  },
  (t) => [primaryKey({ columns: [t.recordCid, t.relatedCid, t.relation] })],
);

/**
 * Gate-19 (WS-R.15.7 / WS-S.4.4) — the `block_cid` ⇄ content-entity provenance map.
 *
 * A public LCAP `block_cid` (`CIDv1(raw, sha2-256)` over plaintext) carries no inherent
 * pointer back to the WS-F content entity (a story / source / evidence card) it was
 * derived from — yet a WS-J takedown targets exactly such an entity by
 * `(target_type, target_id)` (see `takedown_requests`).  Without a linkage, the IPFS
 * public-block bridge cannot answer the only question the §22.7 republication halt needs:
 * "is THIS block's source content currently taken down?"  This table is that linkage: one
 * row per `(block_cid, target_type, target_id)` so the `DrizzleTakedownOracle` joins a
 * block CID to its content entity and then to the live `takedown_requests` status.
 *
 * `target_type` REUSES the `takedown_requests` enum (story / source / evidence) so the
 * oracle's join is type-aligned (same enum, same uuid id) — a block's provenance target and
 * a takedown's target are the same coordinate.  A block may derive from more than one
 * entity (e.g. an evidence card embedded in a story), so the PK spans all three columns and
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
    /** The content entity id (story/source/evidence) — the same coordinate a takedown targets. */
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

export type LcapObjectRow = typeof lcapObjects.$inferSelect;
export type LcapAcceptanceRow = typeof lcapAcceptance.$inferSelect;
export type LcapCapabilityUsageRow = typeof lcapCapabilityUsage.$inferSelect;
export type LcapDeviceSeqRow = typeof lcapDeviceSeq.$inferSelect;
export type LcapForkEvidenceRow = typeof lcapForkEvidence.$inferSelect;
export type LcapRecordClosureRow = typeof lcapRecordClosure.$inferSelect;
export type LcapBlockProvenanceRow = typeof lcapBlockProvenance.$inferSelect;
export type LcapBlockProvenanceInsert = typeof lcapBlockProvenance.$inferInsert;
