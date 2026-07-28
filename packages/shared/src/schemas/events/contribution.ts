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
 * volume but not constructive participation). This is the SCORING taxonomy;
 * the composer's two write types map onto it at the emission boundary
 * (comment→explanation, correction→correction; the low-info classifier can
 * downgrade a comment to low_info_reply).  `bridge_comment` and
 * `steward_action` are SPEC-live concepts whose emitters are pending (the
 * WS-H bridge flow / the WS-J console) — kept so their weights are ratified
 * before the producers land; the types whose producing features were
 * doctrinally retired (question/synthesis/counterexample/experience/flag)
 * were removed with the WS-G-era write taxonomy.
 */
export const EVENT_CONTRIBUTION_TYPES = [
  'correction',
  'explanation',
  'bridge_comment',
  'steward_action',
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
    /**
     * The thread's OWNING STORY — the key every scoring consumer folds by.
     *
     * A thread and its story are two independently minted uuids
     * (`ingestion/submission.ts` mints both), so a consumer that keys
     * participation by `thread_id` while attention, source-opens and saves key
     * by `story_id` silently produces TWO disjoint items: the real story with
     * no contributions, and a phantom carrying nothing else.  Half the
     * ConstructiveParticipation budget then never reaches the story it belongs
     * to, and every downstream lookup by story id (the PWAtt row the ranking
     * features read, the item-safety row a cascade freeze writes, the Signal
     * Ledger's story title) misses.
     *
     * `threads.story_id` is `NOT NULL` with a foreign key, so the emitter
     * always knows this; carrying it here is what makes the fold key uniform
     * rather than something each consumer has to re-derive — which is how the
     * divergence arose.  `thread_id` stays for the genuinely thread-scoped
     * consumers (the SCOI bridge attempt, thread-posture escalation).
     */
    story_id: uuidSchema,
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
