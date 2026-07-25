// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.1.2d — the prohibited-proposal-target classifier (SPEC §17.3.3).
// Room governance can NEVER countermand the platform legal floor: proposals
// targeting platform moderation, safety, privacy, accessibility, or security
// are auto-rejected at preflight.  The classifier is DATA-DRIVEN (a versioned
// denylist of action kinds + an allowlist of known-safe kinds) and FAIL-CLOSED:
// a proposal whose requested action cannot be POSITIVELY classified as safe is
// rejected and routed to review, never allowed by default.

/**
 * The denylist/allowlist revision.  Carried in every rejection reason below, so
 * a refused proposal is attributable to the exact list revision that refused it
 * — a member disputing a rejection, or a steward reviewing one months later, can
 * tell which vocabulary was in force.  BUMP THIS whenever either list changes.
 *
 * It was previously declared and never read, which made "a versioned denylist"
 * in the header a claim nothing realized.
 */
export const PROHIBITED_TARGETS_VERSION = 1;

/** Action kinds that always reject (SPEC §17.3.3 prohibited list). */
export const PROHIBITED_ACTION_KINDS: ReadonlySet<string> = new Set([
  'reinstate_content',
  'reinstate_account',
  'unban_user',
  'override_content_removal',
  'publish_safety_reports',
  'publish_reporter_identity',
  'access_reporter_identity',
  'override_child_safety',
  'override_terrorism_policy',
  'override_self_harm_policy',
  'override_doxxing_policy',
  'override_illegal_content_policy',
  'remove_accessibility_obligation',
  'remove_privacy_obligation',
  'remove_security_obligation',
  'grant_platform_moderator_role',
  'grant_super_role',
  'market_manipulation',
  'sanctions_evasion',
  'bribery',
  'harassment_campaign',
  'deceptive_campaign',
  'alter_settlement_parameters',
]);

/** Known-SAFE action kinds per proposal type (the positive allowlist). */
export const ALLOWED_ACTION_KINDS: Readonly<Record<string, readonly string[]>> = {
  charter_update: ['charter_update'],
  bounty: ['bounty'],
  capped_grant: ['grant'],
  steward_rotation: ['steward_rotation'],
  law_pack_upgrade: ['law_pack_upgrade'],
  treasury_policy_update: ['law_pack_upgrade'],
};

export type ProhibitedTargetVerdict =
  | { allowed: true }
  | { allowed: false; code: 'prohibited_target' | 'unclassifiable_action'; reason: string };

/**
 * Classify a proposal's requested action (WS-M.1.2d).  The action payload must
 * carry a string `kind`; a denylisted kind rejects with the specific class, and
 * a kind OUTSIDE the proposal type's allowlist rejects as unclassifiable
 * (fail-closed — platform review is the escape hatch, never auto-allow).
 */
export function classifyProposalTarget(
  proposalType: string,
  requestedAction: Record<string, unknown>,
): ProhibitedTargetVerdict {
  const kind = requestedAction['kind'];
  if (typeof kind !== 'string' || kind.length === 0) {
    return {
      allowed: false,
      code: 'unclassifiable_action',
      reason: `The requested action must declare a string \`kind\` (fail-closed; target list v${PROHIBITED_TARGETS_VERSION}).`,
    };
  }
  if (PROHIBITED_ACTION_KINDS.has(kind)) {
    return {
      allowed: false,
      code: 'prohibited_target',
      reason: `Action kind "${kind}" targets the platform legal floor (SPEC §17.3.3; target list v${PROHIBITED_TARGETS_VERSION}).`,
    };
  }
  const allowlist = ALLOWED_ACTION_KINDS[proposalType] ?? [];
  if (!allowlist.includes(kind)) {
    return {
      allowed: false,
      code: 'unclassifiable_action',
      reason: `Action kind "${kind}" is not a known-safe action for "${proposalType}" (fail-closed; target list v${PROHIBITED_TARGETS_VERSION}).`,
    };
  }
  return { allowed: true };
}
