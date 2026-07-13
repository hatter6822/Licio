// SPDX-License-Identifier: AGPL-3.0-or-later
//
// System and operational events (WS-E.1.1e, SPEC §21.3). These are `sensitive`:
// they describe how the system makes decisions — not user content — but can
// reveal manipulation defenses. `signals_used` and `score_vector` are
// internal-only; user-facing surfaces receive only `explanation_summary`
// (SPEC §5.4 simplified explanation). Notification events deliberately exclude
// message content so bodies are never persisted in the pipeline.
import { z } from 'zod';
import { uuidSchema } from '../common.js';
import { eventBaseShape } from './envelope.js';

/** Invariant families (SPEC §7-§12 + PWAtt): 5 core + 6 supporting (WS-H). */
export const INVARIANT_TYPES = [
  'MERI',
  'MFCI',
  'SCOI',
  'GWEI',
  'PHI',
  'PWAtt',
  'hodge_tension',
  'tropical_cascade',
  'braid_dynamics',
  'reeb_landscape',
  'counterfactual_defect',
  'path_signature_wellbeing',
] as const;
export type InvariantType = (typeof INVARIANT_TYPES)[number];
export const invariantTypeSchema = z.enum(INVARIANT_TYPES);

/** Targets an invariant run can score (§22.1 + the WS-H.1.1a additions). */
export const INVARIANT_TARGET_TYPES = [
  'story',
  'thread',
  'user',
  'room',
  'feed',
  'cohort',
  'session',
] as const;
export type InvariantTargetType = (typeof INVARIANT_TARGET_TYPES)[number];

/**
 * A time-window label: `<window-start ISO>/<size>` (e.g.
 * `2026-06-10T10:00:00.000Z/1h`). Deterministic so runs are reproducible and
 * replayable (SPEC §30.6).
 */
export const timeWindowLabelSchema = z.string().min(1).max(64);

/** Emitted after an invariant computation completes. */
export const invariantRunCompletedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('invariant.run.completed'),
    invariant_type: invariantTypeSchema,
    target_type: z.enum(INVARIANT_TARGET_TYPES),
    target_id: uuidSchema,
    time_window: timeWindowLabelSchema,
    /** Implementation version (e.g. `v0`) for reproducibility (§30.6). */
    version: z.string().min(1).max(32),
    /** Named score components; internal-only, never user-facing. */
    score_vector: z.record(z.string().min(1).max(64), z.number()),
    confidence: z.number().min(0).max(1),
    computation_time_ms: z.number().nonnegative(),
    privacy_classification: z.literal('sensitive'),
    retention_tier: z.literal('ranking_log'),
  })
  .strict();
export type InvariantRunCompletedEvent = z.infer<typeof invariantRunCompletedEventSchema>;

/** Surfaces a ranking decision can apply to. */
export const RANKING_CONTEXTS = ['feed', 'room', 'search'] as const;
export type RankingContext = (typeof RANKING_CONTEXTS)[number];

/** Emitted for each ranking decision (decision replay, SPEC §30.6). */
export const rankingDecisionLoggedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('ranking.decision.logged'),
    decision_id: uuidSchema,
    story_id: uuidSchema,
    context: z.enum(RANKING_CONTEXTS),
    score: z.number(),
    position: z.number().int().nonnegative(),
    /** Signal types that fed the decision (names only, never values). */
    signals_used: z.array(z.string().min(1).max(64)).max(50),
    /** DEPRECATED — the per-item explanation system was removed; the field
     *  stays optional so stored pre-removal events keep parsing. */
    explanation_summary: z.string().max(500).optional(),
    privacy_classification: z.literal('sensitive'),
    retention_tier: z.literal('ranking_log'),
  })
  .strict();
export type RankingDecisionLoggedEvent = z.infer<typeof rankingDecisionLoggedEventSchema>;

/** Emitted when a notification is dispatched. Carries NO content (type only). */
export const notificationSentEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('notification.sent'),
    notification_id: uuidSchema,
    user_id: uuidSchema,
    notification_type: z.string().min(1).max(64),
    channel: z.enum(['push', 'email', 'in_app']),
    privacy_classification: z.literal('sensitive'),
    retention_tier: z.literal('account_active'),
  })
  .strict();
export type NotificationSentEvent = z.infer<typeof notificationSentEventSchema>;

/** Privacy request kinds (SPEC §19.3 user controls). */
export const PRIVACY_REQUEST_TYPES = ['export', 'deletion', 'attention_reset'] as const;
export type PrivacyRequestType = (typeof PRIVACY_REQUEST_TYPES)[number];

/** Emitted when a privacy action is requested (export, deletion, reset). */
export const privacyRequestCreatedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('privacy.request.created'),
    request_type: z.enum(PRIVACY_REQUEST_TYPES),
    user_id: uuidSchema,
    status: z.enum(['received', 'processing', 'completed', 'cancelled']),
    privacy_classification: z.literal('sensitive'),
    retention_tier: z.literal('account_active'),
  })
  .strict();
export type PrivacyRequestCreatedEvent = z.infer<typeof privacyRequestCreatedEventSchema>;

/**
 * Item safety states for the PWAtt growth freeze (WS-E.2.3e / WS-E.2.2c).
 * `frozen` pins the ranking score while events still populate the Signal
 * Ledger; `removed` zeroes it. `removed` is terminal in v0 (reinstatement is a
 * WS-J appeal concern).
 */
export const ITEM_SAFETY_STATES = ['normal', 'frozen', 'removed'] as const;
export type ItemSafetyState = (typeof ITEM_SAFETY_STATES)[number];
export const itemSafetyStateSchema = z.enum(ITEM_SAFETY_STATES);

/** WS-G.1.1 thread-level safety vocabulary (distinct from item states). */
const THREAD_SAFETY_DIMENSION_STATES = [
  'normal',
  'elevated',
  'under_review',
  'restricted',
] as const;

/**
 * Emitted when a thread's conversation_state or safety state changes.  Three
 * dimensions: `conversation` (WS-G.1.1 lifecycle), `safety` (the WS-E ITEM
 * scoring dimension: normal/frozen/removed), and `thread_safety` (the
 * WS-G.1.1 thread moderation posture: normal/elevated/under_review/
 * restricted) — each refined to its own vocabulary.
 */
export const threadStateChangedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('thread.state.changed'),
    thread_id: uuidSchema,
    story_id: uuidSchema,
    state_dimension: z.enum(['conversation', 'safety', 'thread_safety']),
    old_state: z.string().min(1).max(64),
    new_state: z.string().min(1).max(64),
    /** The acting user, or `system` for pipeline-driven transitions. */
    changed_by: z.union([uuidSchema, z.literal('system')]),
    privacy_classification: z.literal('sensitive'),
    retention_tier: z.literal('ranking_log'),
  })
  .strict()
  .refine((event) => event.old_state !== event.new_state, {
    message: 'state change must change the state',
    path: ['new_state'],
  })
  .refine(
    (event) =>
      event.state_dimension !== 'safety' ||
      ((ITEM_SAFETY_STATES as readonly string[]).includes(event.old_state) &&
        (ITEM_SAFETY_STATES as readonly string[]).includes(event.new_state)),
    { message: 'safety states must be normal | frozen | removed', path: ['new_state'] },
  )
  .refine(
    (event) =>
      event.state_dimension !== 'thread_safety' ||
      ((THREAD_SAFETY_DIMENSION_STATES as readonly string[]).includes(event.old_state) &&
        (THREAD_SAFETY_DIMENSION_STATES as readonly string[]).includes(event.new_state)),
    {
      message: 'thread_safety states must be normal | elevated | under_review | restricted',
      path: ['new_state'],
    },
  );
export type ThreadStateChangedEvent = z.infer<typeof threadStateChangedEventSchema>;
