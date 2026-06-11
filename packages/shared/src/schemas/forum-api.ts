// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Forum endpoint wire contracts (WS-G.3, SPEC §23.2/§23.3): evidence cards,
// feed preferences, uploads, and the link-safety blocklist.  Validated on
// ingress AND re-validated on egress (the WS-C.1.2 boundary guarantee).
import { z } from 'zod';
import { evidenceCardPublicSchema, evidenceCardTypeSchema } from './claim.js';
import { isoTimestampSchema, uuidSchema } from './common.js';
import { citationUrlSchema, contributionPublicSchema } from './contribution.js';
import { feedModeSchema } from './feed.js';
import {
  attentionRetentionPreferenceSchema,
  MAX_TOPIC_PREFERENCES,
  privacyNotificationPreferencesSchema,
} from './privacy-settings.js';

// ---------------------------------------------------------------------------
// POST /v1/contributions (WS-G.3.1) — response.
// ---------------------------------------------------------------------------

export const contributionCreateResponseSchema = z
  .object({
    contribution: contributionPublicSchema,
    /** Present when an evidence card was co-created atomically (WS-G.3.2). */
    evidence_card: evidenceCardPublicSchema.nullable(),
    /** True when this request matched an existing client_draft_id (dedup). */
    deduplicated: z.boolean(),
  })
  .strict();
export type ContributionCreateResponse = z.infer<typeof contributionCreateResponseSchema>;

// ---------------------------------------------------------------------------
// POST /v1/evidence (WS-G.3.2).
// ---------------------------------------------------------------------------

export const evidenceCreateRequestSchema = z
  .object({
    claim_id: uuidSchema,
    citation_url_or_ref: citationUrlSchema,
    relevance_note: z.string().trim().min(1).max(500),
    evidence_type: evidenceCardTypeSchema,
    /** How the evidence RELATES to the claim (claim.ts relationship enum). */
    relationship_type: z
      .enum(['supports', 'contradicts', 'contextualizes', 'corrects', 'counterexample'])
      .default('contextualizes'),
    /** The contribution that introduced this card, when created standalone. */
    contribution_id: uuidSchema.optional(),
  })
  .strict();
export type EvidenceCreateRequest = z.infer<typeof evidenceCreateRequestSchema>;

export const evidenceCreateResponseSchema = z
  .object({ evidence: evidenceCardPublicSchema })
  .strict();
export type EvidenceCreateResponse = z.infer<typeof evidenceCreateResponseSchema>;

// ---------------------------------------------------------------------------
// GET/PATCH /v1/feed/preferences (WS-G.3.8, SPEC §13/§23.2).  A canonical
// veneer over the WS-D settings stores (single source of truth: the identity
// store's privacy/personalization blobs) — feed modes are the five §13 modes
// and NONE of them introduces popularity ordering (no-applause invariant).
// ---------------------------------------------------------------------------

export const feedPreferencesSchema = z
  .object({
    feed_mode: feedModeSchema,
    topic_preferences: z.array(z.string().min(1).max(128)).max(MAX_TOPIC_PREFERENCES),
    personalization_enabled: z.boolean(),
    attention_retention_preference: attentionRetentionPreferenceSchema,
    notification_preferences: privacyNotificationPreferencesSchema,
  })
  .strict();
export type FeedPreferences = z.infer<typeof feedPreferencesSchema>;

export const feedPreferencesPatchSchema = z
  .object({
    feed_mode: feedModeSchema.optional(),
    topic_preferences: z.array(z.string().min(1).max(128)).max(MAX_TOPIC_PREFERENCES).optional(),
    personalization_enabled: z.boolean().optional(),
    notification_preferences: privacyNotificationPreferencesSchema.partial().optional(),
  })
  .strict();
export type FeedPreferencesPatch = z.infer<typeof feedPreferencesPatchSchema>;

// ---------------------------------------------------------------------------
// POST /v1/uploads (WS-G.3.7b).
// ---------------------------------------------------------------------------

export const UPLOAD_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'] as const;
export const UPLOAD_DOCUMENT_TYPES = ['application/pdf'] as const;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export const uploadPublicSchema = z
  .object({
    upload_id: uuidSchema,
    content_type: z.enum([...UPLOAD_IMAGE_TYPES, ...UPLOAD_DOCUMENT_TYPES]),
    byte_size: z.number().int().min(1).max(MAX_DOCUMENT_BYTES),
    /** Required for images (WCAG); null for documents. */
    alt_text: z.string().min(1).max(500).nullable(),
    /** Same-origin serving path (`/v1/uploads/:id`). */
    url: z.string().min(1).max(512),
    /** True once metadata stripping ran (images; EXIF/GPS removed). */
    metadata_stripped: z.boolean(),
    created_at: isoTimestampSchema,
  })
  .strict();
export type UploadPublic = z.infer<typeof uploadPublicSchema>;

// ---------------------------------------------------------------------------
// GET /v1/security/link-blocklist (WS-G.4.2c) — updatable without deploys.
// ---------------------------------------------------------------------------

export const linkBlocklistResponseSchema = z
  .object({
    /** Opaque version for cache-busting (changes on every update). */
    version: z.string().min(1).max(64),
    domains: z.array(z.string().min(4).max(253)).max(5_000),
  })
  .strict();
export type LinkBlocklistResponse = z.infer<typeof linkBlocklistResponseSchema>;
