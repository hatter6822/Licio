// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Steward roles, console capabilities, and appeal eligibility (WS-J; the code
// counterpart of the ratified `docs/policy/STEWARD_ROLES.md` (WS-A.2.2) and the
// `MODERATION_TAXONOMY.md` appeal-eligibility matrix (WS-A.1.2c)).
//
// The five doctrine steward roles are an axis ORTHOGONAL to the platform RBAC
// roles (user/moderator/steward/admin, identity/rbac.ts).  They are granted
// per-user (the `steward_roles` column on the User entity) so the console can
// honour the doctrine's SEPARATIONS structurally — only ROLE_SAFETY removes
// content, only ROLE_APPEALS overturns, only ROLE_INTEGRITY reads coordination
// detail — rather than approximating them with the coarse platform roles.  The
// platform `admin` role implicitly holds all five (a single super-admin can
// operate the whole console; enforced in the API authz layer, not here).
//
// `steward-roles.test.ts` cross-checks STEWARD_ROLE_DOCTRINE against the JSON
// block of STEWARD_ROLES.md so the code can never silently diverge from the
// ratified doctrine.
import { z } from 'zod';
import { type ModerationReasonCode, reasonCodeAppealable } from '../constants/moderation.js';

// ---------------------------------------------------------------------------
// The five doctrine steward roles (SPEC §16.3, STEWARD_ROLES.md).
// ---------------------------------------------------------------------------

export const STEWARD_ROLE_IDS = [
  'ROLE_COMMUNITY',
  'ROLE_EVIDENCE',
  'ROLE_SAFETY',
  'ROLE_APPEALS',
  'ROLE_INTEGRITY',
] as const;
export type StewardRoleId = (typeof STEWARD_ROLE_IDS)[number];
export const stewardRoleIdSchema = z.enum(STEWARD_ROLE_IDS);

const STEWARD_ROLE_SET: ReadonlySet<string> = new Set(STEWARD_ROLE_IDS);
export function isStewardRoleId(value: string): value is StewardRoleId {
  return STEWARD_ROLE_SET.has(value);
}

// ---------------------------------------------------------------------------
// The console action vocabulary (the WS-J.2.3 action palette + the
// account/appeal/community/evidence/integrity actions of STEWARD_ROLES.md).
// ---------------------------------------------------------------------------

/**
 * The WS-J.2.3a content/account action palette.  `escalate` routes the case to
 * the next moderation layer (WS-A.1.2b); `clear` dismisses a report as
 * not-actionable.  Neither enforces against the user, so both are workflow
 * actions available to any report-queue role (see STEWARD_ROLE_CAPABILITIES).
 */
export const PALETTE_ACTIONS = ['warn', 'hide', 'remove', 'restrict', 'escalate', 'clear'] as const;
export type PaletteAction = (typeof PALETTE_ACTIONS)[number];
export const paletteActionSchema = z.enum(PALETTE_ACTIONS);

/** Appeal-decision verbs (ROLE_APPEALS only). */
export const APPEAL_DECISIONS = ['overturn', 'uphold', 'modify'] as const;
export type AppealDecision = (typeof APPEAL_DECISIONS)[number];
export const appealDecisionSchema = z.enum(APPEAL_DECISIONS);

/**
 * Every console capability, as the kebab/word strings used by STEWARD_ROLES.md.
 * Includes the account-level safety actions (shadow/suspend/ban), the appeal
 * verbs, and the community/evidence/integrity capabilities.
 */
export const STEWARD_CAPABILITIES = [
  'warn',
  'hide',
  'remove',
  'restrict',
  'shadow',
  'suspend',
  'ban',
  'escalate',
  'clear',
  'overturn',
  'uphold',
  'modify',
  'merge-duplicates',
  'request-context',
  'organize-branches',
  'mark-primary-source',
  'flag-citation',
  'room-governance-freeze',
  'treasury-freeze',
  'mfci-coordination-detail',
] as const;
export type StewardCapability = (typeof STEWARD_CAPABILITIES)[number];

/** The four moderation queues (STEWARD_ROLES.md "Queue access"). */
export const MODERATION_QUEUES = [
  'report-queue',
  'appeal-queue',
  'integrity-queue',
  'evidence-queue',
] as const;
export type ModerationQueue = (typeof MODERATION_QUEUES)[number];

// ---------------------------------------------------------------------------
// Role → capability/queue policy.
// ---------------------------------------------------------------------------

export interface StewardRolePolicy {
  actions: readonly StewardCapability[];
  queues: readonly ModerationQueue[];
}

/**
 * The doctrine grants, transcribed EXACTLY from the STEWARD_ROLES.md JSON
 * (`roles[].actions` / `roles[].queues`).  The test pins this to the document.
 * `STEWARD_ROLE_CAPABILITIES` (below) is what the application enforces — it is
 * this plus the escalate/clear workflow extension.
 */
export const STEWARD_ROLE_DOCTRINE: Readonly<Record<StewardRoleId, StewardRolePolicy>> = {
  ROLE_COMMUNITY: {
    actions: ['warn', 'merge-duplicates', 'request-context', 'organize-branches'],
    queues: ['report-queue'],
  },
  ROLE_EVIDENCE: {
    actions: ['mark-primary-source', 'flag-citation'],
    queues: ['evidence-queue'],
  },
  ROLE_SAFETY: {
    actions: ['warn', 'hide', 'remove', 'restrict', 'shadow', 'suspend', 'ban'],
    queues: ['report-queue'],
  },
  ROLE_APPEALS: {
    actions: ['overturn', 'uphold', 'modify'],
    queues: ['appeal-queue'],
  },
  ROLE_INTEGRITY: {
    actions: ['room-governance-freeze', 'treasury-freeze', 'mfci-coordination-detail'],
    queues: ['integrity-queue'],
  },
};

/** The doctrine grants PLUS the escalate/clear workflow actions for any role
 *  with report-queue access. */
function withWorkflowActions(roleId: StewardRoleId): StewardRolePolicy {
  const base = STEWARD_ROLE_DOCTRINE[roleId];
  const actions: StewardCapability[] = base.queues.includes('report-queue')
    ? [...base.actions, 'escalate', 'clear']
    : [...base.actions];
  return { actions, queues: base.queues };
}

/**
 * The enforced capability table: the doctrine grants PLUS `escalate`/`clear`
 * for every role with report-queue access (the WS-J.2.3a workflow actions, also
 * implied by the WS-A.1.2b "steward cannot resolve → escalate" path).  This is
 * a faithful SUPERSET of the doctrine — never a subset (the no-weaken rule).
 */
export const STEWARD_ROLE_CAPABILITIES: Readonly<Record<StewardRoleId, StewardRolePolicy>> = {
  ROLE_COMMUNITY: withWorkflowActions('ROLE_COMMUNITY'),
  ROLE_EVIDENCE: withWorkflowActions('ROLE_EVIDENCE'),
  ROLE_SAFETY: withWorkflowActions('ROLE_SAFETY'),
  ROLE_APPEALS: withWorkflowActions('ROLE_APPEALS'),
  ROLE_INTEGRITY: withWorkflowActions('ROLE_INTEGRITY'),
};

/**
 * Capabilities that require a SENIOR grant (STEWARD_ROLES.md: permanent `ban`
 * is "ROLE_SAFETY (senior)"; ban appeals are "ROLE_APPEALS (senior)").  The API
 * authz layer treats the platform `admin` role as the senior grant.
 */
export const SENIOR_ONLY_CAPABILITIES: ReadonlySet<StewardCapability> = new Set(['ban']);

/** Capabilities that require counsel co-approval (STEWARD_ROLES.md / WS-A.1.2c). */
export const CO_APPROVAL_CAPABILITIES: ReadonlySet<StewardCapability> = new Set([
  'treasury-freeze',
]);

/** Whether any of the held doctrine roles grants `capability`. */
export function stewardRolesCan(
  roles: readonly StewardRoleId[],
  capability: StewardCapability,
): boolean {
  return roles.some((roleId) => STEWARD_ROLE_CAPABILITIES[roleId].actions.includes(capability));
}

/** Whether any of the held doctrine roles may access `queue`. */
export function stewardRolesCanAccessQueue(
  roles: readonly StewardRoleId[],
  queue: ModerationQueue,
): boolean {
  return roles.some((roleId) => STEWARD_ROLE_CAPABILITIES[roleId].queues.includes(queue));
}

/** The union of queues the held roles may access. */
export function stewardRolesQueues(roles: readonly StewardRoleId[]): ModerationQueue[] {
  const out = new Set<ModerationQueue>();
  for (const roleId of roles) {
    for (const queue of STEWARD_ROLE_CAPABILITIES[roleId].queues) out.add(queue);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Appeal eligibility (WS-J.1.3a; mirrors the WS-A.1.2c matrix exactly).
// ---------------------------------------------------------------------------

/**
 * The enforcement action types whose appealability the matrix governs.  These
 * are the action TYPES (not reason codes); the per-reason-code lawful-basis
 * exception (CSAM / imminent threat) is layered on top for `remove`.
 */
export const ENFORCEMENT_ACTION_TYPES = [
  'warn',
  'hide',
  'remove',
  'restrict',
  'shadow',
  'suspend',
  'ban',
  'emergency_restriction',
  'room_governance_freeze',
  'treasury_freeze',
] as const;
export type EnforcementActionType = (typeof ENFORCEMENT_ACTION_TYPES)[number];
export const enforcementActionTypeSchema = z.enum(ENFORCEMENT_ACTION_TYPES);

/** Default ban-appeal cooldown (WS-A.1.2c / WS-J.1.3a; configurable, 24h). */
export const DEFAULT_BAN_APPEAL_COOLDOWN_HOURS = 24;

export type AppealIneligibleReason =
  | 'ban_cooldown'
  | 'emergency_deferred'
  | 'lawful_basis'
  | 'shadow_notice_pending';

export interface AppealEligibility {
  appealable: boolean;
  /** The reviewing role (always ROLE_APPEALS for user-facing actions; integrity
   *  freezes route to ROLE_INTEGRITY per WS-A.1.2c). */
  reviewer: StewardRoleId;
  /** Whether the reviewing role is the SENIOR tier (permanent-ban appeals). */
  senior: boolean;
  /** Present when `appealable` is false — why, for the ineligible message. */
  ineligibleReason?: AppealIneligibleReason;
  /** Hours after the action when the appeal becomes available (ban cooldown). */
  availableAfterHours?: number;
}

export interface AppealEligibilityOptions {
  reasonCode?: ModerationReasonCode;
  banCooldownHours?: number;
  /** True once the in-flight emergency review has completed (the deferred
   *  action then becomes appealable). */
  emergencyReviewComplete?: boolean;
  /** True once the user has been notified a shadow action occurred (a shadow
   *  action is appealable only after notice — no silent sanction). */
  shadowUserNotified?: boolean;
}

/**
 * Resolve appeal eligibility for an action type + its reason code.  Pure and
 * total; the client uses it to show/hide the appeal affordance and the server
 * uses it to gate `POST /v1/appeals` — so the two can never disagree.
 */
export function appealEligibility(
  actionType: EnforcementActionType,
  options: AppealEligibilityOptions = {},
): AppealEligibility {
  switch (actionType) {
    case 'warn':
    case 'hide':
    case 'restrict':
    case 'suspend':
      return { appealable: true, reviewer: 'ROLE_APPEALS', senior: false };
    case 'shadow':
      // Appealable, but only once the user has been notified (no silent sanction).
      return options.shadowUserNotified === false
        ? {
            appealable: false,
            reviewer: 'ROLE_APPEALS',
            senior: false,
            ineligibleReason: 'shadow_notice_pending',
          }
        : { appealable: true, reviewer: 'ROLE_APPEALS', senior: false };
    case 'remove': {
      // CSAM and imminent-threat removals are non-appealable by lawful basis
      // (the reason code carries `appealable:false`).
      const appealable =
        options.reasonCode === undefined ? true : reasonCodeAppealable(options.reasonCode);
      return appealable
        ? { appealable: true, reviewer: 'ROLE_APPEALS', senior: false }
        : {
            appealable: false,
            reviewer: 'ROLE_APPEALS',
            senior: false,
            ineligibleReason: 'lawful_basis',
          };
    }
    case 'ban':
      // Appealable once, after a cooldown; reviewed by a senior appeals reviewer.
      return {
        appealable: true,
        reviewer: 'ROLE_APPEALS',
        senior: true,
        availableAfterHours: options.banCooldownHours ?? DEFAULT_BAN_APPEAL_COOLDOWN_HOURS,
      };
    case 'emergency_restriction':
      // Not appealable until the emergency review completes; then the resulting
      // action is appealable (deferred eligibility).
      return options.emergencyReviewComplete
        ? { appealable: true, reviewer: 'ROLE_APPEALS', senior: false }
        : {
            appealable: false,
            reviewer: 'ROLE_APPEALS',
            senior: false,
            ineligibleReason: 'emergency_deferred',
          };
    case 'room_governance_freeze':
      return { appealable: true, reviewer: 'ROLE_INTEGRITY', senior: false };
    case 'treasury_freeze':
      return { appealable: true, reviewer: 'ROLE_INTEGRITY', senior: false };
  }
}

/**
 * Whether an enforcement action is "significant" — i.e. it acts against a user
 * and therefore REQUIRES a readable statement of reasons / user notice
 * (WS-J.2.3a; cross-cutting invariant 2).  `clear`/`escalate` are workflow, not
 * sanctions, so they produce no user notice.
 */
export const SIGNIFICANT_ACTION_TYPES: ReadonlySet<string> = new Set([
  'warn',
  'hide',
  'remove',
  'restrict',
  'shadow',
  'suspend',
  'ban',
  'emergency_restriction',
  'room_governance_freeze',
  'treasury_freeze',
]);

/** Whether an action against a user is significant (notice required). */
export function isSignificantAction(actionType: string): boolean {
  return SIGNIFICANT_ACTION_TYPES.has(actionType);
}
