// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U policy-DSL evaluator (SPEC §24.6; ADR-1). Total, deterministic, side-
// effect-free interpretation of a bundle's moderation rules over a structured
// `ModerationContext`. Recursion is over a finite rule tree (no regex, no code),
// so evaluation always terminates. The decision is the most-severe matching
// action, ties broken by declared rule order — fully reproducible.

import {
  actionSeverity,
  type ModerationCondition,
  type ModerationContext,
  type ModerationDecision,
  type ModerationRule,
} from './schemas/moderation.js';

/** Evaluate one predicate against the context. Total over the finite tree. */
export function evaluateCondition(condition: ModerationCondition, ctx: ModerationContext): boolean {
  switch (condition.kind) {
    case 'always':
      return true;
    case 'text_contains_any': {
      const haystack = ctx.contentText.toLowerCase();
      return condition.terms.some((term) => haystack.includes(term.toLowerCase()));
    }
    case 'link_count_gte':
      return ctx.linkCount >= condition.value;
    case 'mention_count_gte':
      return ctx.mentionCount >= condition.value;
    case 'length_gte':
      return ctx.contentLength >= condition.value;
    case 'author_account_age_lt_days':
      return ctx.authorAccountAgeDays < condition.value;
    case 'author_new_to_room':
      return ctx.authorNewToRoom;
    case 'prior_removals_in_room_gte':
      return ctx.priorRemovalsInRoom >= condition.value;
    case 'has_media_upload':
      return ctx.hasMediaUpload;
    case 'all_of':
      return condition.conditions.every((c) => evaluateCondition(c, ctx));
    case 'any_of':
      return condition.conditions.some((c) => evaluateCondition(c, ctx));
    case 'not':
      return !evaluateCondition(condition.condition, ctx);
  }
}

/**
 * Evaluate the full rule-set. Returns the most-severe matching action (ties
 * broken by declared order via the left-biased reduce), with every matched rule
 * id recorded for transparency. No match ⇒ the default `allow`.
 */
export function evaluatePolicy(
  rules: readonly ModerationRule[],
  ctx: ModerationContext,
): ModerationDecision {
  const matched = rules.filter((rule) => evaluateCondition(rule.when, ctx));
  if (matched.length === 0) {
    return {
      action: 'allow',
      matchedRuleIds: [],
      ruleRef: null,
      reason: 'No moderation rule matched; content allowed.',
    };
  }
  const deciding = matched.reduce((best, rule) =>
    actionSeverity(rule.action) > actionSeverity(best.action) ? rule : best,
  );
  return {
    action: deciding.action,
    matchedRuleIds: matched.map((rule) => rule.id),
    ruleRef: deciding.id,
    reason: deciding.reason,
  };
}
