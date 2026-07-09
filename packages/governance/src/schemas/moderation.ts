// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U moderation vocabulary (SPEC §24.6). The in-room moderation MODEL is an
// LLM (the deterministic policy-DSL rule engine was removed, WS-U ADR-9); this
// module carries only the shared, deterministic pieces the model's output is
// bounded against: the closed action ladder + severities, the structured
// room-scoped context the model classifies, and the bounded decision shape. The
// bounding itself (escalate-to-review ceiling + capability clamp) lives in
// `moderation-bound.ts`; the model never holds authority (ADR-5).

import { z } from 'zod';

/**
 * The closed action enum, ordered by severity (index = severity) so that
 * severity is MONOTONIC with real content impact — the visibility state each
 * action maps to: `allow`/`warn` keep content published, `flag_for_review`/
 * `restrict` route it to human review (hidden), and `remove` removes it. A
 * `warn` (visible) is therefore LESS severe than `flag_for_review` (hidden),
 * which keeps the capability downgrade + the escalate-to-review ceiling from
 * ever turning a visible action into a content hide. Only in-room, appealable
 * actions; NO floor-reserved action is expressible. `flag_for_review` routes to
 * a human rather than auto-removing (the human-review-at-the-floor invariant).
 */
export const MODERATION_ACTIONS = [
  'allow',
  'warn',
  'flag_for_review',
  'restrict',
  'remove',
] as const;
export const moderationActionSchema = z.enum(MODERATION_ACTIONS);
export type ModerationAction = z.infer<typeof moderationActionSchema>;

/** Severity rank for deterministic bounding (higher wins / is more severe). */
export function actionSeverity(action: ModerationAction): number {
  return MODERATION_ACTIONS.indexOf(action);
}

/**
 * The structured input the runtime assembles for a single contribution. It is
 * ROOM-SCOPED and carries no PII beyond the room boundary (ADR-5 / SPEC §24.6
 * sandbox): bucketed account age, booleans, and counts — never identity, never
 * cross-room data. `contentText` is untrusted input the model classifies; it
 * never becomes an instruction (authority is enforced outside the model).
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

/**
 * The bounded in-room moderation decision: the action the deterministic wrapper
 * actually permits (already ceiling-capped + capability-clamped) plus its
 * statement of reasons. `allow` carries the default reason.
 */
export const moderationDecisionSchema = z.object({
  action: moderationActionSchema,
  reason: z.string(),
});
export type ModerationDecision = z.infer<typeof moderationDecisionSchema>;
