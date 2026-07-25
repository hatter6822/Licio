// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J console authorization (SPEC §25.4; STEWARD_ROLES.md WS-A.2.2).  Maps an
// authenticated actor to its EFFECTIVE doctrine steward roles and decides
// console capabilities / queue access.  The doctrine grants live in
// @licio/shared (the role→capability policy, single-sourced with the ratified
// document); this layer adds the platform-side rules:
//   • the platform `admin` role implicitly holds ALL five doctrine roles (a
//     single super-admin can operate the whole console / small deployments);
//   • every console action requires VERIFIED MFA (STEWARD_ROLES.md: "MFA is
//     required for all steward accounts") — enrolled is not enough;
//   • senior-only capabilities (permanent `ban`) require the senior grant,
//     which the platform `admin` role carries;
//   • CO-APPROVAL capabilities (`treasury-freeze`) require a SECOND, distinct
//     actor holding legal counsel — STEWARD_ROLES.md: "`treasury-freeze` |
//     `ROLE_INTEGRITY` only | Requires counsel co-approval (WS-A.1.2c)", and
//     MODERATION_TAXONOMY.md's machine-readable row `{"action_type": "Treasury
//     freeze", …, "co_approver": "counsel"}`.
import {
  CO_APPROVAL_CAPABILITIES,
  type ModerationQueue,
  SENIOR_ONLY_CAPABILITIES,
  STEWARD_ROLE_IDS,
  type StewardCapability,
  type StewardRoleId,
  stewardRolesCan,
  stewardRolesCanAccessQueue,
  stewardRolesQueues,
} from '@licio/shared';
import { isCounsel, type Role } from '../identity/rbac.js';

export interface StewardActor {
  userId: string;
  platformRoles: readonly Role[];
  stewardRoles: readonly StewardRoleId[];
  mfaActive: boolean;
  mfaVerified: boolean;
}

/** Effective doctrine roles: explicit grants, plus ALL five for platform admin. */
export function effectiveStewardRoles(
  platformRoles: readonly Role[],
  grants: readonly StewardRoleId[],
): StewardRoleId[] {
  if (platformRoles.includes('admin')) return [...STEWARD_ROLE_IDS];
  return [...grants];
}

/** Senior tier (permanent ban; senior appeals) — the platform `admin` role. */
export function isSenior(platformRoles: readonly Role[]): boolean {
  return platformRoles.includes('admin');
}

/** True when the actor holds ANY doctrine steward role (console gate). */
export function isStewardActor(actor: StewardActor): boolean {
  return effectiveStewardRoles(actor.platformRoles, actor.stewardRoles).length > 0;
}

export type CapabilityDenial = {
  code: 'mfa_required' | 'insufficient_capability' | 'co_approval_required';
  message: string;
};

/**
 * The ROLE-and-seniority half of the decision, without the per-invocation gates
 * (MFA freshness, co-approval).  Factored out because {@link denyCapability} and
 * {@link availableConsoleActions} both need exactly this and previously spelled
 * it out separately — two places deciding one question, free to drift.
 */
function grantsCapability(actor: StewardActor, capability: StewardCapability): boolean {
  const roles = effectiveStewardRoles(actor.platformRoles, actor.stewardRoles);
  if (!stewardRolesCan(roles, capability)) return false;
  if (SENIOR_ONLY_CAPABILITIES.has(capability) && !isSenior(actor.platformRoles)) return false;
  return true;
}

/** The second approver presented alongside a co-approval capability. */
export interface CoApprover {
  userId: string;
  platformRoles: readonly Role[];
}

/**
 * Resolve whether the actor may invoke a console capability (null ⇒ allowed).
 *
 * `coApprover` is REQUIRED for every capability in `CO_APPROVAL_CAPABILITIES`
 * and ignored otherwise.  Omitting it DENIES — the fail-closed direction, and
 * the reason this parameter is optional rather than required: every existing
 * call site passes a capability that needs no co-approver, and any future one
 * that does must opt in explicitly rather than inherit a pass.
 */
export function denyCapability(
  actor: StewardActor,
  capability: StewardCapability,
  coApprover?: CoApprover | null,
): CapabilityDenial | null {
  if (!actor.mfaActive || !actor.mfaVerified) {
    return { code: 'mfa_required', message: 'Verify MFA to perform steward actions' };
  }
  if (!grantsCapability(actor, capability)) {
    const roles = effectiveStewardRoles(actor.platformRoles, actor.stewardRoles);
    return {
      code: 'insufficient_capability',
      message: stewardRolesCan(roles, capability)
        ? `"${capability}" requires a senior grant`
        : `Capability "${capability}" is not granted to your steward role`,
    };
  }
  // Counsel co-approval (WS-A.1.2c).  Three conditions, each of which a
  // one-condition check would let through: a co-approver must be PRESENT, must
  // be a DIFFERENT person (an actor naming themselves is not four eyes), and
  // must actually hold the counsel capability (`compliance.counsel.approve`) —
  // the doctrine says counsel, not "any second steward".
  if (CO_APPROVAL_CAPABILITIES.has(capability)) {
    if (!coApprover) {
      return {
        code: 'co_approval_required',
        message: `"${capability}" requires legal-counsel co-approval`,
      };
    }
    if (coApprover.userId === actor.userId) {
      return {
        code: 'co_approval_required',
        message: `"${capability}" requires a co-approver other than yourself`,
      };
    }
    if (!isCounsel(coApprover.platformRoles)) {
      return {
        code: 'co_approval_required',
        message: `"${capability}" requires the co-approver to hold legal counsel`,
      };
    }
  }
  return null;
}

/** The auth-context fields a {@link StewardActor} is built from.  Structural on
 *  purpose — it lets this domain module stay free of the route/middleware
 *  `AuthEnv` type while still being the single source of `stewardActorOf` /
 *  `isPlatformStaff` for every governance route file. */
export interface StewardAuthContext {
  userId: string;
  roles: readonly Role[];
  stewardRoles: readonly StewardRoleId[];
  mfaActive: boolean;
  mfaVerified: boolean;
}

/** Map an authenticated context to its {@link StewardActor}. */
export function stewardActorOf(auth: StewardAuthContext): StewardActor {
  return {
    userId: auth.userId,
    platformRoles: auth.roles,
    stewardRoles: auth.stewardRoles,
    mfaActive: auth.mfaActive,
    mfaVerified: auth.mfaVerified,
  };
}

/** Platform staff = the WS-J `restrict` capability (the platform legal floor):
 *  operators who act on rooms as enforcement, exempt from the KYC governance
 *  floor that gates community participants. */
export function isPlatformStaff(auth: StewardAuthContext): boolean {
  return denyCapability(stewardActorOf(auth), 'restrict') === null;
}

/** Resolve whether the actor may access a queue (null ⇒ allowed). */
export function denyQueue(actor: StewardActor, queue: ModerationQueue): CapabilityDenial | null {
  if (!actor.mfaActive || !actor.mfaVerified) {
    return { code: 'mfa_required', message: 'Verify MFA to access this queue' };
  }
  const roles = effectiveStewardRoles(actor.platformRoles, actor.stewardRoles);
  if (!stewardRolesCanAccessQueue(roles, queue)) {
    return { code: 'insufficient_capability', message: `Your role cannot access the ${queue}` };
  }
  return null;
}

/** Whether the actor may see reporter identity / coordination detail
 *  (integrity-sensitive; ROLE_SAFETY for case context, ROLE_INTEGRITY for
 *  coordination depth — STEWARD_ROLES.md least-privilege). */
export function mayseeReporterIdentity(actor: StewardActor): boolean {
  const roles = effectiveStewardRoles(actor.platformRoles, actor.stewardRoles);
  return roles.includes('ROLE_SAFETY') || roles.includes('ROLE_INTEGRITY');
}

/** Whether the actor holds the integrity-analyst role (ROLE_INTEGRITY) — the
 *  MFCI/coordination judgment authority (clears incidents, may act on a case
 *  whose volume-driven enforcement is delayed pending integrity review). */
export function isIntegrityActor(actor: StewardActor): boolean {
  return effectiveStewardRoles(actor.platformRoles, actor.stewardRoles).includes('ROLE_INTEGRITY');
}

/** Whether the actor may see full MFCI coordination detail (ROLE_INTEGRITY). */
export function maySeeCoordinationDetail(actor: StewardActor): boolean {
  return isIntegrityActor(actor);
}

/**
 * The console actions the actor's role may take (for the review payload's
 * `available_actions`).
 *
 * Deliberately the ROLE grant only — MFA freshness is a per-invocation gate the
 * UI resolves by stepping up, not a reason to hide an action the role holds.
 * The palette carries no co-approval capability (`CO_APPROVAL_CAPABILITIES` is
 * disjoint from it); should one be added, {@link denyCapability} still refuses
 * it without a counsel co-approver, so the fail-closed floor holds regardless of
 * what this offers.
 */
export function availableConsoleActions(actor: StewardActor): StewardCapability[] {
  const palette: StewardCapability[] = [
    'warn',
    'hide',
    'remove',
    'restrict',
    'shadow',
    'suspend',
    'ban',
    'escalate',
    'clear',
  ];
  return palette.filter((capability) => grantsCapability(actor, capability));
}

/**
 * Queues an actor may access — for console UI shaping AND for WS-J #18
 * reviewer auto-assignment (which must only pick reviewers who can actually
 * open the queue).  Takes the two ROLE LISTS rather than a full
 * {@link StewardActor}, matching its siblings `effectiveStewardRoles` /
 * `isSenior`, so the assignment path (which holds a user record, not an
 * authenticated console actor) resolves queues through this one definition
 * instead of recomposing `stewardRolesQueues(effectiveStewardRoles(…))` inline.
 */
export function actorQueues(
  platformRoles: readonly Role[],
  stewardRoles: readonly StewardRoleId[],
): ModerationQueue[] {
  return stewardRolesQueues(effectiveStewardRoles(platformRoles, stewardRoles));
}
