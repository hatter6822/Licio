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
//     which the platform `admin` role carries.
import {
  type ModerationQueue,
  SENIOR_ONLY_CAPABILITIES,
  STEWARD_ROLE_IDS,
  type StewardCapability,
  type StewardRoleId,
  stewardRolesCan,
  stewardRolesCanAccessQueue,
  stewardRolesQueues,
} from '@licio/shared';
import type { Role } from '../identity/rbac.js';

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
  code: 'mfa_required' | 'insufficient_capability';
  message: string;
};

/** Resolve whether the actor may invoke a console capability (null ⇒ allowed). */
export function denyCapability(
  actor: StewardActor,
  capability: StewardCapability,
): CapabilityDenial | null {
  if (!actor.mfaActive || !actor.mfaVerified) {
    return { code: 'mfa_required', message: 'Verify MFA to perform steward actions' };
  }
  const roles = effectiveStewardRoles(actor.platformRoles, actor.stewardRoles);
  if (!stewardRolesCan(roles, capability)) {
    return {
      code: 'insufficient_capability',
      message: `Capability "${capability}" is not granted to your steward role`,
    };
  }
  if (SENIOR_ONLY_CAPABILITIES.has(capability) && !isSenior(actor.platformRoles)) {
    return {
      code: 'insufficient_capability',
      message: `"${capability}" requires a senior grant`,
    };
  }
  return null;
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

/** Whether the actor may see full MFCI coordination detail (ROLE_INTEGRITY). */
export function maySeeCoordinationDetail(actor: StewardActor): boolean {
  const roles = effectiveStewardRoles(actor.platformRoles, actor.stewardRoles);
  return roles.includes('ROLE_INTEGRITY');
}

/** The console actions the actor's role may take (for the review payload's
 *  `available_actions`). */
export function availableConsoleActions(actor: StewardActor): StewardCapability[] {
  const roles = effectiveStewardRoles(actor.platformRoles, actor.stewardRoles);
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
  return palette.filter((capability) => {
    if (!stewardRolesCan(roles, capability)) return false;
    if (SENIOR_ONLY_CAPABILITIES.has(capability) && !isSenior(actor.platformRoles)) return false;
    return true;
  });
}

/** Queues the actor may access (for UI shaping). */
export function actorQueues(actor: StewardActor): ModerationQueue[] {
  return stewardRolesQueues(effectiveStewardRoles(actor.platformRoles, actor.stewardRoles));
}
