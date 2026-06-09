// SPDX-License-Identifier: AGPL-3.0-or-later
//
// IndexedDB record schemas (WS-C.2.2c). Every record carries a `schemaVersion`
// and is validated on read AND write, so corrupted, tampered, or wrongly-migrated
// data can never enter application state — the same zod-on-the-boundary defense
// as zod-on-response (SPEC §6.12.7), applied at the storage trust boundary.
import {
  branchDepthBucketSchema,
  branchIdSchema,
  contributionTypeSchema,
  dwellBucketSchema,
  returnVisitBucketSchema,
} from '@licio/shared';
import { z } from 'zod';

/** Current per-store record schema version (bump with a db.ts migration). */
export const RECORD_SCHEMA_VERSION = 1;
const schemaVersion = z.literal(RECORD_SCHEMA_VERSION);

/** A story saved for offline reading (key: storyId). Timestamps are epoch ms. */
export const savedStoryRecordSchema = z.object({
  schemaVersion,
  storyId: z.string().uuid(),
  title: z.string().min(1),
  source: z.string().min(1),
  url: z.string().url().nullable(),
  roomId: z.string().uuid().nullable(),
  savedAt: z.number().int().nonnegative(),
});
export type SavedStoryRecord = z.infer<typeof savedStoryRecordSchema>;

/** An autosaved composer draft (key: draftId). Body lives in `values`. */
export const draftContributionRecordSchema = z.object({
  schemaVersion,
  draftId: z.string().min(1),
  storyId: z.string().uuid().nullable(),
  threadId: z.string().uuid().nullable(),
  branch: branchIdSchema.nullable(),
  contributionType: contributionTypeSchema,
  values: z.record(z.string(), z.string()),
  updatedAt: z.number().int().nonnegative(),
  /** True when the draft is encrypted at rest (cross-device sync on, §6.8). */
  encrypted: z.boolean(),
});
export type DraftContributionRecord = z.infer<typeof draftContributionRecordSchema>;

/** A cached thread summary for offline reading (key: threadId). */
export const threadSnapshotRecordSchema = z.object({
  schemaVersion,
  threadId: z.string().uuid(),
  title: z.string().min(1),
  summary: z.string(),
  cachedAt: z.number().int().nonnegative(),
});
export type ThreadSnapshotRecord = z.infer<typeof threadSnapshotRecordSchema>;

/** A private Signal-Ledger snapshot row (key: itemId). */
export const signalLedgerRecordSchema = z.object({
  schemaVersion,
  itemId: z.string().uuid(),
  storyTitle: z.string().min(1),
  recordedAt: z.number().int().nonnegative(),
  activeDwellBucket: dwellBucketSchema,
  sourceOpened: z.boolean(),
  contextOpened: z.boolean(),
  branchDepthBucket: branchDepthBucketSchema,
  returnVisitCountBucket: returnVisitBucketSchema,
  capReached: z.boolean(),
});
export type SignalLedgerRecord = z.infer<typeof signalLedgerRecordSchema>;

/** Operation kinds the background-sync queue carries (WS-C.2.3 queue table). */
export const OPERATION_TYPES = [
  'contribution',
  'report',
  'attention-aggregate',
  'draft-sync',
] as const;
export const operationTypeSchema = z.enum(OPERATION_TYPES);
export type OperationType = (typeof OPERATION_TYPES)[number];

export const operationStatusSchema = z.enum(['pending', 'in-flight', 'failed']);
export type OperationStatus = z.infer<typeof operationStatusSchema>;

/**
 * A queued operation (key: operationId). `payload` is opaque here and validated
 * against its operation-specific schema when dequeued for send. The queue is the
 * single source of truth for unsynced writes (WS-C.2.2a edge case).
 */
export const pendingOperationRecordSchema = z.object({
  schemaVersion,
  operationId: z.string().min(1),
  operationType: operationTypeSchema,
  status: operationStatusSchema,
  createdAt: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  /** Last terminal/transient failure reason, for surfacing manual retry. */
  lastError: z.string().nullable(),
  payload: z.unknown(),
});
export type PendingOperationRecord = z.infer<typeof pendingOperationRecordSchema>;
