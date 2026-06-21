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
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { bytea } from './_custom.js';

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
 * Per-capability aggregate usage (§11.3 / §18.3 step 9): the running event count + total
 * payload bytes a capability has spent, so the server enforces `max_offline_events` and
 * `max_total_payload_bytes` across a device's offline events.  Incremented atomically as
 * part of acceptance (the increment is tied to a freshly-accepted record, so it is
 * idempotent by `record_cid` and a re-submit never double-debits).  Keyed by the stable
 * grant id (`capability_id`), not the content CID.
 */
export const lcapCapabilityUsage = pgTable('lcap_capability_usage', {
  capabilityId: text('capability_id').primaryKey(),
  eventCount: integer('event_count').notNull().default(0),
  totalBytes: bigint('total_bytes', { mode: 'number' }).notNull().default(0),
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

export type LcapObjectRow = typeof lcapObjects.$inferSelect;
export type LcapAcceptanceRow = typeof lcapAcceptance.$inferSelect;
export type LcapCapabilityUsageRow = typeof lcapCapabilityUsage.$inferSelect;
export type LcapDeviceSeqRow = typeof lcapDeviceSeq.$inferSelect;
export type LcapForkEvidenceRow = typeof lcapForkEvidence.$inferSelect;
export type LcapRecordClosureRow = typeof lcapRecordClosure.$inferSelect;
