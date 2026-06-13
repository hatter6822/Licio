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
  storyVisibilitySchema,
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
  // WS-Q.5.5 — `roomId` is nullish so a pre-WS-Q saved record (no room) stays
  // readable (gracefully widened) rather than being quarantined on read.
  roomId: z.string().uuid().nullish(),
  savedAt: z.number().int().nonnegative(),
});
export type SavedStoryRecord = z.infer<typeof savedStoryRecordSchema>;

/** AES-GCM ciphertext envelope for an encrypted draft (base64 iv + data). */
export const draftCipherSchema = z.object({
  iv: z.string().min(1),
  data: z.string().min(1),
});
export type DraftCipherRecord = z.infer<typeof draftCipherSchema>;

/**
 * An autosaved composer draft (key: draftId). When `encrypted` is true the body
 * lives in `cipher` (AES-256-GCM at rest, §6.8) and `values` is empty; otherwise
 * the plaintext body is in `values` (the fallback where Web Crypto is absent).
 */
export const draftContributionRecordSchema = z
  .object({
    schemaVersion,
    draftId: z.string().min(1),
    storyId: z.string().uuid().nullable(),
    threadId: z.string().uuid().nullable(),
    branch: branchIdSchema.nullable(),
    contributionType: contributionTypeSchema,
    values: z.record(z.string(), z.string()),
    updatedAt: z.number().int().nonnegative(),
    /** True when the draft body is encrypted at rest in `cipher` (§6.8). */
    encrypted: z.boolean(),
    /** Present iff `encrypted`: the AES-GCM ciphertext of the draft values. */
    cipher: draftCipherSchema.optional(),
  })
  // Enforce the invariant: `cipher` present iff `encrypted`. A record claiming
  // encryption but missing the ciphertext (or vice versa) is corrupt — quarantine
  // it on read rather than silently loading an empty draft.
  .refine((record) => record.encrypted === (record.cipher !== undefined), {
    message: 'encrypted and cipher must agree (cipher present iff encrypted)',
  });
export type DraftContributionRecord = z.infer<typeof draftContributionRecordSchema>;

/**
 * The four story-composer modes (a subset of the §14.1 submission types: the
 * composer offers link/brief/image/video). This tuple is the single source of
 * truth for both the persisted draft and the component's `StoryComposerMode`.
 */
export const STORY_DRAFT_MODES = ['link', 'original_brief', 'image_post', 'video_post'] as const;
export const storyDraftModeSchema = z.enum(STORY_DRAFT_MODES);
export type StoryDraftMode = (typeof STORY_DRAFT_MODES)[number];

/**
 * An autosaved story-composer draft (key: draftId). Mirrors the contribution
 * draft: structural fields (mode, room, visibility) are plaintext metadata so
 * room + visibility round-trip on restore; the free-text body lives encrypted in
 * `cipher` (AES-256-GCM, §6.8) with `values` empty when Web Crypto is available,
 * else plaintext in `values`. Files are NOT persisted — a restored draft keeps
 * the text + room + visibility, and the user re-picks any media.
 */
export const draftStoryRecordSchema = z
  .object({
    schemaVersion,
    draftId: z.string().min(1),
    mode: storyDraftModeSchema,
    /** The chosen home room: COMMONS_ROOM_ID or a room UUID. */
    roomId: z.string().uuid(),
    visibility: storyVisibilitySchema,
    values: z.record(z.string(), z.string()),
    updatedAt: z.number().int().nonnegative(),
    /** True when the draft body is encrypted at rest in `cipher` (§6.8). */
    encrypted: z.boolean(),
    /** Present iff `encrypted`: the AES-GCM ciphertext of the draft values. */
    cipher: draftCipherSchema.optional(),
  })
  // Same invariant as the contribution draft: `cipher` present iff `encrypted`.
  .refine((record) => record.encrypted === (record.cipher !== undefined), {
    message: 'encrypted and cipher must agree (cipher present iff encrypted)',
  });
export type DraftStoryRecord = z.infer<typeof draftStoryRecordSchema>;

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
  // Optional since WS-E: cap status is client-known only; server-generated
  // ledger entries omit it (loosening only — older cached rows still parse).
  capReached: z.boolean().optional(),
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
