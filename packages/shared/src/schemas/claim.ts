// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Claim record vocabulary (WS-F.1.2a, SPEC §22.1/§22.3). Claims are content
// artifacts whose `independence_group_id` is how MERI (WS-H.2) groups
// non-independent lineages so duplicated coverage can never count as
// independent validation (SPEC §13.6). Sourcing on conversations is
// comment-centric (citations on contributions) — the separate EvidenceCard
// entity was removed with its orphaned creation paths, and the public
// per-story claim projection (`GET /stories/:id/claims`) was removed with
// the independent-sources drawer, its only consumer. Claims remain internal
// MERI/WS-K inputs; only the record-vocabulary enums live here now.
import { z } from 'zod';

/**
 * Lifecycle of the claim RECORD itself (WS-F.1.2a). Distinct from the WS-E
 * `claim.updated` EVENT vocabulary (unverified/supported/challenged/corrected/
 * retracted), which describes verification transitions on the wire; the
 * ingestion service maps record-status changes onto that event vocabulary
 * when emitting (candidate→unverified, accepted→supported,
 * contested→challenged, retracted→retracted).
 */
export const CLAIM_RECORD_STATUSES = ['candidate', 'accepted', 'contested', 'retracted'] as const;
export type ClaimRecordStatus = (typeof CLAIM_RECORD_STATUSES)[number];
export const claimRecordStatusSchema = z.enum(CLAIM_RECORD_STATUSES);

/** Who produced the claim text (provenance, WS-F.1.2b). */
export const CLAIM_EXTRACTION_SOURCES = ['system', 'user', 'steward'] as const;
export type ClaimExtractionSource = (typeof CLAIM_EXTRACTION_SOURCES)[number];
export const claimExtractionSourceSchema = z.enum(CLAIM_EXTRACTION_SOURCES);
