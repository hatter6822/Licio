// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.6 sync-protocol message schemas (OFFLINE_SPEC §16).  These are transient
// wire messages — pulse (tiny trust/liveness frontier exchange), exchange
// (bidirectional pack exchange), and fetch (range/object fetch) — NOT
// content-addressed records: they carry no `record_cid` and are never hashed.
// But every one crosses the trust boundary, so each is a strict, closed zod
// schema validated on receipt (fail-closed; §9.1.4).  Frontiers (§16.2, §17.2,
// §17.3) summarize "how far along" a node is; exchanging them in the pulse lets
// trust/liveness deltas move before any bulk content (§16.1).

import { z } from 'zod';
import {
  anyCidSchema,
  bytesSchema,
  cidKindSchema,
  compressionIdSchema,
  lcapLaneSchema,
  lcapRecordKindSchema,
  prioritySchema,
  uintSchema,
  visibilityScopeSchema,
} from './common.js';
import { objectStatusV2Schema, receiptRecordV2Schema } from './receipt.js';

/**
 * The crypto-suite identifiers a node advertises (§16.2).  The matching type
 * lives in the zero-dependency `cose/suites.ts` (`CryptoSuiteId`); this is its
 * zod mirror for the schema layer (the cose core must not import zod, §31.1).
 */
export const cryptoSuiteIdSchema = z.enum(['ES256', 'Ed25519']);

/** The session transport mode carried in a pulse (§16.2). */
export const syncTransportProfileSchema = z.enum([
  'https',
  'relay',
  'courier',
  'manual_import',
  'qr',
]);
export type SyncTransportProfile = z.infer<typeof syncTransportProfileSchema>;

/** The privacy posture a node advertises for the session (§16.2, §26.1). */
export const syncPrivacyModeSchema = z.enum(['public', 'contacts_only', 'manual', 'stealth']);
export type SyncPrivacyMode = z.infer<typeof syncPrivacyModeSchema>;

/** §16.5 transfer budget; clients shrink it under resource/privacy pressure. */
export const exchangeBudgetV2Schema = z
  .object({
    max_request_bytes: uintSchema,
    max_response_bytes: uintSchema,
    max_pack_table_entries: uintSchema,
    max_frame_bytes: uintSchema,
    max_uncompressed_bytes: uintSchema,
    max_records: uintSchema,
    max_proofs: uintSchema,
    max_blocks: uintSchema,
    time_budget_ms: uintSchema.optional(),
    priority_floor: prioritySchema,
    allow_evidence: z.boolean(),
    allow_media: z.boolean(),
    allow_private_encrypted: z.boolean(),
    metered_connection: z.boolean().optional(),
    battery_saver: z.boolean().optional(),
    minimal_mode: z.boolean().optional(),
  })
  .strict();
export type ExchangeBudgetV2 = z.infer<typeof exchangeBudgetV2Schema>;

/** §17.2 room checkpoint frontier — how far a node has seen a room's log. */
export const checkpointFrontierV2Schema = z
  .object({
    room_id_hash: bytesSchema,
    latest_checkpoint_cid: anyCidSchema.optional(),
    latest_tree_size: uintSchema.optional(),
    latest_policy_epoch: uintSchema.optional(),
    latest_revocation_epoch: uintSchema.optional(),
  })
  .strict();
export type CheckpointFrontierV2 = z.infer<typeof checkpointFrontierV2Schema>;

/** §17.3 revocation frontier — how current a node's revocation knowledge is. */
export const revocationFrontierV2Schema = z
  .object({
    scope: z.enum(['global', 'room', 'account']),
    scope_hash: bytesSchema.optional(),
    revocation_epoch: uintSchema,
    latest_revocation_checkpoint_cid: anyCidSchema.optional(),
  })
  .strict();
export type RevocationFrontierV2 = z.infer<typeof revocationFrontierV2Schema>;

/** §16.2 capability frontier helper — capability-expiry awareness. */
export const capabilityFrontierV2Schema = z
  .object({
    room_id_hash: bytesSchema,
    capability_id: z.string().min(1),
    not_after_ms: uintSchema,
  })
  .strict();
export type CapabilityFrontierV2 = z.infer<typeof capabilityFrontierV2Schema>;

/** §16.2 lane summary helper — pending work per lane. */
export const laneSummaryV2Schema = z
  .object({
    lane: lcapLaneSchema,
    pending_count: uintSchema,
    pending_bytes: uintSchema,
  })
  .strict();
export type LaneSummaryV2 = z.infer<typeof laneSummaryV2Schema>;

/** §16.2 sync pulse — the tiny trust/liveness frontier exchange, logically first. */
export const syncPulseV2Schema = z
  .object({
    lcap_version: z.literal(2),
    node_id: z.string().min(1),
    session_nonce: bytesSchema,
    transport_profile: syncTransportProfileSchema,
    privacy_mode: syncPrivacyModeSchema,
    budgets: exchangeBudgetV2Schema,
    supported_suites: z.array(cryptoSuiteIdSchema),
    supported_compression: z.array(compressionIdSchema),
    supported_pack_versions: z.array(uintSchema),
    checkpoint_frontier: z.array(checkpointFrontierV2Schema),
    revocation_frontier: z.array(revocationFrontierV2Schema),
    capability_frontier: z.array(capabilityFrontierV2Schema).optional(),
    critical_have: z.array(anyCidSchema).optional(),
    critical_want: z.array(anyCidSchema).optional(),
    lane_summary: z.array(laneSummaryV2Schema).optional(),
  })
  .strict();
export type SyncPulseV2 = z.infer<typeof syncPulseV2Schema>;

/** §16.6 interest privacy level — gates what an interest may reveal. */
export const interestPrivacyLevelSchema = z.enum(['public', 'trusted_peer_only', 'manual_only']);
export type InterestPrivacyLevel = z.infer<typeof interestPrivacyLevelSchema>;

/** §16.6 interest descriptor — what a node wants, privacy-scoped. */
export const interestDescriptorV2Schema = z
  .object({
    interest_version: z.literal(2),
    room_id: z.string().min(1).optional(),
    room_id_hash: bytesSchema.optional(),
    visibility_scope: visibilityScopeSchema.optional(),
    record_kinds: z.array(lcapRecordKindSchema).optional(),
    lanes: z.array(lcapLaneSchema).optional(),
    min_priority: prioritySchema.optional(),
    since_checkpoint_cid: anyCidSchema.optional(),
    since_tree_size: uintSchema.optional(),
    include_dependencies: z.boolean(),
    include_proofs: z.boolean(),
    privacy_level: interestPrivacyLevelSchema,
  })
  .strict();
export type InterestDescriptorV2 = z.infer<typeof interestDescriptorV2Schema>;

/** §16.7 object summary — a hint only; the receiver MUST verify payloads. */
export const objectSummaryV2Schema = z
  .object({
    cid: anyCidSchema,
    cid_kind: cidKindSchema,
    record_kind: lcapRecordKindSchema.optional(),
    lane: lcapLaneSchema,
    priority: prioritySchema,
    size_bytes: uintSchema,
    deps: z.array(anyCidSchema).optional(),
    room_id_hash: bytesSchema.optional(),
    trust_hint: z.enum(['unknown', 'locally_verified', 'checkpointed', 'revoked']).optional(),
    replica_hint: uintSchema.optional(),
  })
  .strict();
export type ObjectSummaryV2 = z.infer<typeof objectSummaryV2Schema>;

/** §16.8 want reason — drives scheduling priority (WS-R.6.4). */
export const wantReasonSchema = z.enum([
  'missing_dependency',
  'explicit_user_request',
  'checkpoint_gap',
  'revocation_gap',
  'room_interest',
  'resume_partial',
  'scarce_replica',
]);
export type WantReason = z.infer<typeof wantReasonSchema>;

/** §16.8 byte range for a resumable fetch. */
export const wantRangeSchema = z.object({ offset: uintSchema, length: uintSchema }).strict();
export type WantRange = z.infer<typeof wantRangeSchema>;

/** §16.8 want — an explicit request for an object, with a scheduling reason. */
export const wantRequestV2Schema = z
  .object({
    cid: anyCidSchema,
    cid_kind: cidKindSchema,
    reason: wantReasonSchema,
    max_bytes: uintSchema.optional(),
    range: wantRangeSchema.optional(),
    priority_override: prioritySchema.optional(),
  })
  .strict();
export type WantRequestV2 = z.infer<typeof wantRequestV2Schema>;

/** §16.4 exchange-response warning codes. */
export const exchangeWarningV2Schema = z
  .object({
    code: z.enum([
      'stale_checkpoint',
      'stale_revocation',
      'quota_near_limit',
      'private_metadata_stripped',
      'budget_truncated',
    ]),
    detail: z.string().optional(),
  })
  .strict();
export type ExchangeWarningV2 = z.infer<typeof exchangeWarningV2Schema>;

/** §16.4 exchange status — the client honors this verbatim (WS-R.6.2). */
export const exchangeStatusSchema = z.enum([
  'ok',
  'partial',
  'rate_limited',
  'retry_later',
  'auth_required',
]);
export type ExchangeStatus = z.infer<typeof exchangeStatusSchema>;

/** §16.3 exchange request — pulse + interests + acks + optional push pack + wants. */
export const exchangeRequestV2Schema = z
  .object({
    pulse: syncPulseV2Schema,
    interests: z.array(interestDescriptorV2Schema),
    known_summaries: z.array(objectSummaryV2Schema).optional(),
    ack_receipts: z.array(receiptRecordV2Schema).optional(),
    push_pack: bytesSchema.optional(),
    want: z.array(wantRequestV2Schema).optional(),
  })
  .strict();
export type ExchangeRequestV2 = z.infer<typeof exchangeRequestV2Schema>;

/** §16.4 exchange response — pulse + status + accepted statuses + offers + pack. */
export const exchangeResponseV2Schema = z
  .object({
    pulse: syncPulseV2Schema,
    status: exchangeStatusSchema,
    accepted_push: z.array(objectStatusV2Schema).optional(),
    wanted_from_client: z.array(wantRequestV2Schema).optional(),
    offer_summary: z.array(objectSummaryV2Schema).optional(),
    response_pack: bytesSchema.optional(),
    receipts: z.array(receiptRecordV2Schema).optional(),
    retry_after_ms: uintSchema.optional(),
    warnings: z.array(exchangeWarningV2Schema).optional(),
  })
  .strict();
export type ExchangeResponseV2 = z.infer<typeof exchangeResponseV2Schema>;
