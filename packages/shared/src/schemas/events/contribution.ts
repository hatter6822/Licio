// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Contribution events (WS-E.1.1c, SPEC §5.3/§15.1/§21.3). Contribution events
// are `public`. The contribution-type enum (especially `bridge_comment`,
// `steward_action`, and `low_info_reply`) is the bridge between the
// conversation model (WS-G) and PWAtt participation scoring (WS-E.2.1c); an
// exhaustive enum prevents an unweighted type from silently entering scoring.
import { z } from 'zod';
import { uuidSchema } from '../common.js';
import { eventBaseShape } from './envelope.js';

/**
 * The event-pipeline contribution taxonomy (WS-E.1.1c). `low_info_reply` is
 * explicitly included for anti-signal tracking (§5.3: counts as conversation
 * volume but not constructive participation). This is the SCORING taxonomy; the
 * client composer's eight modes (schemas/contribution.ts) map onto it at the
 * event-emission boundary (ask→question, explain→explanation, 1:1 otherwise).
 */
export const EVENT_CONTRIBUTION_TYPES = [
  'question',
  'evidence',
  'correction',
  'synthesis',
  'counterexample',
  'explanation',
  'experience',
  'bridge_comment',
  'steward_action',
  'flag',
  'low_info_reply',
] as const;
export type EventContributionType = (typeof EVENT_CONTRIBUTION_TYPES)[number];
export const eventContributionTypeSchema = z.enum(EVENT_CONTRIBUTION_TYPES);

/** Emitted when a user submits a contribution (SPEC §21.3 `contribution.created`). */
export const contributionCreatedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('contribution.created'),
    contribution_id: uuidSchema,
    thread_id: uuidSchema,
    user_id: uuidSchema,
    contribution_type: eventContributionTypeSchema,
    target_claim_id: uuidSchema.nullable(),
    parent_contribution_id: uuidSchema.nullable(),
    /** Whether the contribution carries at least one citation. */
    has_citation: z.boolean(),
    /**
     * Conservative v0 lexical accusation classification (WS-E.2.2b). True only
     * when the body asserts serious wrongdoing without hedging; ordinary
     * opinion and routine disagreement are never flagged. Drives the
     * source-free-accusation downweight (scoring only, never visibility).
     */
    accusation_flag: z.boolean(),
    privacy_classification: z.literal('public'),
    retention_tier: z.literal('public_contribution'),
  })
  .strict();
export type ContributionCreatedEvent = z.infer<typeof contributionCreatedEventSchema>;

/** Evidence types carried by evidence cards (SPEC §22.1 `EvidenceCard`). */
export const EVIDENCE_TYPES = [
  'primary_source',
  'dataset',
  'transcript',
  'legal_text',
  'report',
  'article',
  'other',
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];
export const evidenceTypeSchema = z.enum(EVIDENCE_TYPES);

/** Emitted when an evidence card is submitted (SPEC §21.3 `evidence.added`). */
export const evidenceAddedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('evidence.added'),
    evidence_id: uuidSchema,
    claim_id: uuidSchema,
    thread_id: uuidSchema,
    user_id: uuidSchema,
    evidence_type: evidenceTypeSchema,
    /**
     * In-app source id backing the evidence (never an arbitrary URL); null
     * for user-experience evidence with no web source (§22.1 EvidenceCard —
     * WS-F.2.5a is the first real producer and surfaces both shapes).
     */
    source_id: uuidSchema.nullable(),
    /** The contribution the card was attached to, when applicable. */
    contribution_id: uuidSchema.nullable(),
    privacy_classification: z.literal('public'),
    retention_tier: z.literal('public_contribution'),
  })
  .strict();
export type EvidenceAddedEvent = z.infer<typeof evidenceAddedEventSchema>;

/** Claim lifecycle states (WS-E.1.1c). */
export const CLAIM_STATUSES = [
  'unverified',
  'supported',
  'challenged',
  'corrected',
  'retracted',
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export const claimStatusSchema = z.enum(CLAIM_STATUSES);

/**
 * Legal claim-status transitions. Two invariants: nothing ever returns to
 * `unverified` (evidence history cannot be erased), and `retracted` is
 * terminal. Self-loops are not transitions.
 */
const LEGAL_CLAIM_TRANSITIONS: Readonly<Record<ClaimStatus, readonly ClaimStatus[]>> = {
  unverified: ['supported', 'challenged', 'corrected', 'retracted'],
  supported: ['challenged', 'corrected', 'retracted'],
  challenged: ['supported', 'corrected', 'retracted'],
  corrected: ['supported', 'challenged', 'retracted'],
  retracted: [],
};

/** Whether `from → to` is a legal claim-status transition. */
export function isLegalClaimTransition(from: ClaimStatus, to: ClaimStatus): boolean {
  return LEGAL_CLAIM_TRANSITIONS[from].includes(to);
}

/** Emitted when a claim's status changes (SPEC §21.3 `claim.updated`). */
export const claimUpdatedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('claim.updated'),
    claim_id: uuidSchema,
    story_id: uuidSchema,
    old_status: claimStatusSchema,
    new_status: claimStatusSchema,
    /** The acting user, or `system` for pipeline-driven updates. */
    updated_by: z.union([uuidSchema, z.literal('system')]),
    privacy_classification: z.literal('public'),
    retention_tier: z.literal('public_contribution'),
  })
  .strict()
  .refine((event) => isLegalClaimTransition(event.old_status, event.new_status), {
    message: 'illegal claim status transition',
    path: ['new_status'],
  });
export type ClaimUpdatedEvent = z.infer<typeof claimUpdatedEventSchema>;
