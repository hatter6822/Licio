// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Role-based + object-level authorization (WS-D.1.6b, §25.4).  Two guarantees:
//   • A central policy table maps (role → allowed actions).  No action joins
//     wallet identity to attention/ranking data — that capability does not exist
//     by construction, and a test asserts the table never grows one (reinforcing
//     the §21.5 / §17.1 no-pay-to-rank isolation at the policy layer too).
//   • Object-level ownership: a user may only touch their own resources.  A
//     cross-user reference to a PRIVATE object resolves to `not_found`, never
//     `forbidden`, so existence is not confirmed (no enumeration oracle).

export const ROLES = ['user', 'moderator', 'steward', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = [
  'self.manage', // manage own account, sessions, settings, privacy, export, deletion
  'moderation.act', // take moderation actions
  'steward.audit.read', // read the audit log / steward review surfaces
  'admin.role.assign', // assign/revoke roles
] as const;
export type Action = (typeof ACTIONS)[number];

/** The authoritative role → capability grants.  Reviewed by a policy-matrix test. */
export const POLICY: Readonly<Record<Role, readonly Action[]>> = {
  user: ['self.manage'],
  moderator: ['self.manage', 'moderation.act'],
  steward: ['self.manage', 'moderation.act', 'steward.audit.read'],
  admin: ['self.manage', 'moderation.act', 'steward.audit.read', 'admin.role.assign'],
};

/** Whether ANY of the actor's roles grants `action`. */
export function authorize(roles: readonly Role[], action: Action): boolean {
  return roles.some((role) => POLICY[role]?.includes(action) ?? false);
}

/** Object-level ownership check. */
export function assertOwns(actorUserId: string, resourceOwnerUserId: string): boolean {
  return actorUserId === resourceOwnerUserId;
}

export type OwnershipOutcome = 'ok' | 'not_found';

/**
 * Resolve a cross-user access on a PRIVATE resource.  Ownership mismatch yields
 * `not_found` (→ HTTP 404) rather than `forbidden` (→ 403), so an attacker cannot
 * use the status code as an existence oracle (WS-D.1.6b, WS-D.1.3c).
 */
export function privateOwnershipOutcome(
  actorUserId: string,
  resourceOwnerUserId: string,
): OwnershipOutcome {
  return assertOwns(actorUserId, resourceOwnerUserId) ? 'ok' : 'not_found';
}

/** Highest-privilege role present (for display/audit only; authz uses `authorize`). */
export function isSteward(roles: readonly Role[]): boolean {
  return roles.includes('steward') || roles.includes('admin');
}
