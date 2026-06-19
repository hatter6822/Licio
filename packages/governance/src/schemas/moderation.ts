// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U moderation policy DSL (SPEC §24.6; ADR-1). A community "model" carries a
// declarative, total, side-effect-free rule-set evaluated over a structured,
// room-scoped `ModerationContext`. The DSL has a BOUNDED predicate set and NO raw
// regular expressions (ReDoS-safe) and NO arbitrary code — the platform runtime
// interprets it deterministically, so the agent's moderation behaviour is fully
// reproducible from the downloadable bundle. Actions are a closed enum that maps
// to legal §15.4 transitions; floor-reserved actions are not expressible.

import { z } from 'zod';

/** A bounded, recursive predicate over the moderation context. No regex. */
export type ModerationCondition =
  | { kind: 'always' }
  | { kind: 'text_contains_any'; terms: string[] }
  | { kind: 'link_count_gte'; value: number }
  | { kind: 'mention_count_gte'; value: number }
  | { kind: 'length_gte'; value: number }
  | { kind: 'author_account_age_lt_days'; value: number }
  | { kind: 'author_new_to_room' }
  | { kind: 'prior_removals_in_room_gte'; value: number }
  | { kind: 'has_media_upload' }
  | { kind: 'all_of'; conditions: ModerationCondition[] }
  | { kind: 'any_of'; conditions: ModerationCondition[] }
  | { kind: 'not'; condition: ModerationCondition };

export const moderationConditionSchema: z.ZodType<ModerationCondition> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('always') }),
    z.object({
      kind: z.literal('text_contains_any'),
      terms: z.array(z.string().min(1).max(128)).min(1).max(512),
    }),
    z.object({ kind: z.literal('link_count_gte'), value: z.number().int().min(0).max(10_000) }),
    z.object({ kind: z.literal('mention_count_gte'), value: z.number().int().min(0).max(10_000) }),
    z.object({ kind: z.literal('length_gte'), value: z.number().int().min(0).max(1_000_000) }),
    z.object({
      kind: z.literal('author_account_age_lt_days'),
      value: z.number().int().min(0).max(100_000),
    }),
    z.object({ kind: z.literal('author_new_to_room') }),
    z.object({
      kind: z.literal('prior_removals_in_room_gte'),
      value: z.number().int().min(0).max(10_000),
    }),
    z.object({ kind: z.literal('has_media_upload') }),
    z.object({
      kind: z.literal('all_of'),
      conditions: z.array(moderationConditionSchema).min(1).max(64),
    }),
    z.object({
      kind: z.literal('any_of'),
      conditions: z.array(moderationConditionSchema).min(1).max(64),
    }),
    z.object({ kind: z.literal('not'), condition: moderationConditionSchema }),
  ]),
);

/**
 * The closed action enum, ordered by severity (index = severity). Only in-room,
 * appealable actions; NO floor-reserved action is expressible. `flag_for_review`
 * routes to a human rather than auto-removing (preserves the human-review-at-the
 * -floor invariant for ambiguous cases).
 */
export const MODERATION_ACTIONS = [
  'allow',
  'flag_for_review',
  'warn',
  'restrict',
  'remove',
] as const;
export const moderationActionSchema = z.enum(MODERATION_ACTIONS);
export type ModerationAction = z.infer<typeof moderationActionSchema>;

/** Severity rank for deterministic decision resolution (higher wins). */
export function actionSeverity(action: ModerationAction): number {
  return MODERATION_ACTIONS.indexOf(action);
}

export const moderationRuleSchema = z.object({
  id: z.string().min(1).max(128),
  when: moderationConditionSchema,
  /** The action to take when `when` holds (the rule's consequent). */
  action: moderationActionSchema,
  /** The statement of reasons recorded on the agent action (SPEC §16.4). */
  reason: z.string().min(1).max(2_000),
});
export type ModerationRule = z.infer<typeof moderationRuleSchema>;

/**
 * The structured input the runtime assembles for a single contribution. It is
 * ROOM-SCOPED and carries no PII beyond the room boundary (ADR-5 / SPEC §24.6
 * sandbox): bucketed account age, booleans, and counts — never identity, never
 * cross-room data. `contentText` is untrusted input; it influences predicates
 * but never instructions (capabilities are enforced outside the model).
 */
export const moderationContextSchema = z.object({
  contentText: z.string(),
  contentKind: z.enum(['comment', 'evidence', 'correction', 'story']),
  contentLength: z.number().int().min(0),
  linkCount: z.number().int().min(0),
  mentionCount: z.number().int().min(0),
  hasMediaUpload: z.boolean(),
  authorAccountAgeDays: z.number().int().min(0),
  authorNewToRoom: z.boolean(),
  priorRemovalsInRoom: z.number().int().min(0),
});
export type ModerationContext = z.infer<typeof moderationContextSchema>;

export const moderationDecisionSchema = z.object({
  action: moderationActionSchema,
  /** Every rule that matched (transparency); empty ⇒ the default allow. */
  matchedRuleIds: z.array(z.string()),
  /** The deciding rule's id, or null for the default allow. */
  ruleRef: z.string().nullable(),
  reason: z.string(),
});
export type ModerationDecision = z.infer<typeof moderationDecisionSchema>;
