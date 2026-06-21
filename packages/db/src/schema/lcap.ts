// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.12.2 — LCAP server-ingestion durable state (the `LcapServerStore` backend).
// The content-addressed object store, the per-room canonical acceptance log, the
// device-sequence claimant index (authoritative fork detection), and append-only
// fork evidence.  No FK edges into user/content data: LCAP records are
// self-authenticating (COSE proofs the engine verifies), addressed by CID — this is
// the offline-availability data plane, isolated from the core relational model.

import {
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

export type LcapObjectRow = typeof lcapObjects.$inferSelect;
export type LcapAcceptanceRow = typeof lcapAcceptance.$inferSelect;
export type LcapDeviceSeqRow = typeof lcapDeviceSeq.$inferSelect;
export type LcapForkEvidenceRow = typeof lcapForkEvidence.$inferSelect;
