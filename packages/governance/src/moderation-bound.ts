// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U deterministic moderation bounding (SPEC §24.6; ADR-5, ADR-9). The in-room
// AI moderation model (an LLM) is a bounded INPUT to a deterministic container,
// never the authority. This module is that container's core clamp: given the
// model's proposed action, it produces the action the agent is actually allowed
// to take, enforced OUTSIDE the model so prompt-injection has no authority
// channel. Two deterministic bounds compose:
//
//   1. The escalate-to-human-review CEILING — the in-room model can raise a
//      contribution AT MOST to `flag_for_review` (route to a human), never to
//      `restrict`/`remove` on its own; a human always confirms before an
//      AI-driven removal.
//   2. The community-ratified CAPABILITY clamp — the action is further reduced
//      to the strongest action the room's capability descriptor grants (or
//      `allow` if none), so a room that withheld a capability structurally
//      cannot have the agent take it. Floor-reserved actions are not members of
//      the capability type, so they are unreachable here.
//
// The floor-DOMINANT combination with the always-on platform baseline (WS-J)
// happens in the forum: this module only bounds the in-room model's own action.

import { hasCapability } from './capability-derive.js';
import type { Capability, CapabilityDescriptor } from './schemas/capability.js';
import { actionSeverity, MODERATION_ACTIONS, type ModerationAction } from './schemas/moderation.js';

/** The action each non-`allow` moderation action requires (the §24.6 mapping). */
export const MODERATION_ACTION_CAPABILITY: Record<
  Exclude<ModerationAction, 'allow'>,
  Capability
> = {
  warn: 'moderate.warn',
  flag_for_review: 'moderate.flag',
  restrict: 'moderate.restrict',
  remove: 'moderate.remove',
};

/**
 * The highest action the in-room AI model may reach on its own authority
 * (WS-U ADR-9, the maintainer's escalate-to-human-review-only decision):
 * `flag_for_review` routes to a human, who confirms before any removal. Raising
 * this constant is the single knob that would grant the model stronger
 * autonomous authority.
 */
export const MODERATION_AI_ESCALATION_CEILING: ModerationAction = 'flag_for_review';

/** The lower-severity of two actions (used to cap an action at the ceiling). */
function minSeverity(a: ModerationAction, b: ModerationAction): ModerationAction {
  return actionSeverity(a) <= actionSeverity(b) ? a : b;
}

/**
 * Clamp an action to the strongest action the descriptor grants that is no more
 * severe than it (or `allow` if none). Deterministic and total. `allow` needs no
 * capability. This is the capability half of the deterministic container.
 */
export function clampActionToCapability(
  action: ModerationAction,
  descriptor: CapabilityDescriptor,
): ModerationAction {
  if (action === 'allow') return 'allow';
  if (hasCapability(descriptor, MODERATION_ACTION_CAPABILITY[action])) return action;
  const decidedSeverity = actionSeverity(action);
  let fallback: ModerationAction = 'allow';
  for (const candidate of MODERATION_ACTIONS) {
    if (candidate === 'allow') continue;
    if (actionSeverity(candidate) > decidedSeverity) break; // severity-ordered
    if (hasCapability(descriptor, MODERATION_ACTION_CAPABILITY[candidate])) fallback = candidate;
  }
  return fallback;
}

/**
 * Bound the in-room AI model's proposed action: cap it at the escalate-to-review
 * ceiling, THEN clamp to the community-granted capability. Pure, total,
 * deterministic — the model's text cannot exceed this envelope (ADR-5).
 */
export function boundAiModerationAction(
  proposed: ModerationAction,
  descriptor: CapabilityDescriptor,
): ModerationAction {
  return clampActionToCapability(
    minSeverity(proposed, MODERATION_AI_ESCALATION_CEILING),
    descriptor,
  );
}
