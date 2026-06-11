// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Event envelope base (WS-E.1.1g, SPEC §21.3/§22.1). Every event topic extends
// this shape: a client- or service-generated id, a discriminator `event_type`,
// an event timestamp, a schema version, and the two governance fields that make
// privacy structural rather than promised — `privacy_classification` (access
// control) and `retention_tier` (data minimization, WS-E.1.1f).
//
// Canonical field-name mapping to the §22.1 `AttentionAggregate` entity
// (unit-asserted in __tests__/events-registry.test.ts so the names never drift):
//
//   envelope `privacy_classification`  — the ACCESS class of the topic
//     (public | aggregated | sensitive | restricted). Attention topics are
//     always `aggregated`: owner- and scoring-readable, never public.
//   row `privacy_level`                — the COLLECTION granularity carried by
//     the §22.1 aggregate (standard | reduced | minimum, WS-C.4.1d). It governs
//     pseudonymization of the persisted row, not API access.
//   event `user_id`                    — the authenticated owner on the wire.
//   row `user_id_or_privacy_bucket`    — the persisted identifier: the user id,
//     or the coarse privacy bucket when `privacy_level` is `minimum`
//     (pseudonymized rows, SPEC §19.2 re-identification resistance).
import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from '../common.js';
import { retentionTierSchema } from './retention.js';

/** The four privacy classifications (WS-E plan, "Privacy classification model"). */
export const PRIVACY_CLASSIFICATIONS = ['public', 'aggregated', 'sensitive', 'restricted'] as const;
export type PrivacyClassification = (typeof PRIVACY_CLASSIFICATIONS)[number];
export const privacyClassificationSchema = z.enum(PRIVACY_CLASSIFICATIONS);

/** Current wire/storage schema version for all event topics. */
export const EVENT_SCHEMA_VERSION = '1' as const;

/**
 * The envelope fields shared by every topic. Topic schemas spread this shape,
 * pin `event_type` / `privacy_classification` / `retention_tier` to literals,
 * and call `.strict()` so unknown keys are rejected at the boundary (a buggy or
 * malicious client cannot smuggle raw traces into a registered topic).
 */
export const eventBaseShape = {
  /** Producer-generated unique id; the idempotency key for at-least-once delivery. */
  event_id: uuidSchema,
  /** Event time (ISO-8601). Client-claimed times are bounded by WS-E.1.3b windows. */
  timestamp: isoTimestampSchema,
  schema_version: z.literal(EVENT_SCHEMA_VERSION),
} as const;

/**
 * Structural envelope check (classification + tier present and valid) used by
 * storage-layer defense in depth. Unknown keys are stripped, not accepted —
 * full validation always goes through the topic schema in the registry.
 */
export const eventEnvelopeSchema = z.object({
  ...eventBaseShape,
  event_type: z.string().min(1).max(64),
  privacy_classification: privacyClassificationSchema,
  retention_tier: retentionTierSchema,
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
