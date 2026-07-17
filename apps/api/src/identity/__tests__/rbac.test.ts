// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  canAccessComplianceConsole,
  canAccessModerationConsole,
  PLATFORM_ROLES,
  STEWARD_ROLE_IDS,
} from '@licio/shared';
import { describe, expect, it } from 'vitest';
import { isStewardActor } from '../../moderation/authz.js';
import {
  ACTIONS,
  type Action,
  assertOwns,
  authorize,
  isComplianceReviewer,
  isCounsel,
  isSteward,
  POLICY,
  privateOwnershipOutcome,
  ROLES,
  type Role,
} from '../rbac.js';

describe('RBAC policy matrix', () => {
  // The expected grants — kept here independently so a drift in POLICY is caught.
  const expected: Record<Role, Action[]> = {
    user: ['self.manage'],
    // `expert` is least-privilege: identical platform grants to `user` (its only
    // distinct power — expert-room posting — is a forum authorization, not an action).
    expert: ['self.manage'],
    moderator: ['self.manage', 'moderation.act'],
    steward: ['self.manage', 'moderation.act', 'steward.audit.read'],
    admin: [
      'self.manage',
      'moderation.act',
      'steward.audit.read',
      'admin.role.assign',
      // The AI team (WS-K.1.1b): register/version/deprecate models + the deploy gate.
      'ai.model.manage',
      // Deliberately NO compliance.* action (WS-N.2.1c-2 structural separation):
      // an admin assigns the compliance/counsel roles but cannot read the data.
    ],
    // WS-N.2.1c-2 — the financial-compliance plane (least-privilege both ways).
    compliance: ['self.manage', 'compliance.review'],
    counsel: ['self.manage', 'compliance.review', 'compliance.counsel.approve'],
  };

  for (const role of ROLES) {
    for (const action of ACTIONS) {
      const shouldAllow = expected[role].includes(action);
      it(`${role} ${shouldAllow ? 'CAN' : 'cannot'} ${action}`, () => {
        expect(authorize([role], action)).toBe(shouldAllow);
      });
    }
  }

  it('grants the union across multiple roles', () => {
    expect(authorize(['user', 'moderator'], 'moderation.act')).toBe(true);
  });

  it('denies an empty role set everything', () => {
    for (const action of ACTIONS) expect(authorize([], action)).toBe(false);
  });

  it('ROLES is the shared PLATFORM_ROLES SSOT (wire vocabulary ≡ policy table)', () => {
    expect(ROLES).toBe(PLATFORM_ROLES);
  });

  it('the shared console-nav hints mirror the server authorization exactly (no drift)', () => {
    // `canAccess*Console` gates only which LINK renders; these equivalences
    // guarantee the hint can never disagree with the gate that actually
    // authorizes.  The moderation console's gate is the WS-J doctrine
    // `isStewardActor` (ANY doctrine grant, or platform admin) — NOT the
    // platform `steward` role: a doctrine-granted plain `user` must see the
    // link, and a grant-less platform `steward` must not.  Checked over
    // every platform role × {no grants, one grant, all grants}.
    const grantSets: readonly (readonly (typeof STEWARD_ROLE_IDS)[number][])[] = [
      [],
      [STEWARD_ROLE_IDS[0]],
      STEWARD_ROLE_IDS,
    ];
    for (const role of ROLES) {
      for (const grants of grantSets) {
        expect(
          canAccessModerationConsole([role], grants),
          `${role} + ${grants.length} grants`,
        ).toBe(
          isStewardActor({
            userId: '6f9619ff-8b86-4d01-b42d-00cf4fc964ff',
            platformRoles: [role],
            stewardRoles: grants,
            mfaActive: true,
            mfaVerified: true,
          }),
        );
      }
      expect(canAccessComplianceConsole([role]), role).toBe(isComplianceReviewer([role]));
    }
  });
});

describe('no action joins wallet identity to attention/ranking (structural)', () => {
  it('the ACTIONS list contains no wallet↔ranking capability', () => {
    for (const action of ACTIONS) {
      const a = action.toLowerCase();
      const mentionsWallet = a.includes('wallet');
      const mentionsRanking = a.includes('ranking') || a.includes('attention');
      expect(mentionsWallet && mentionsRanking).toBe(false);
    }
  });

  it('no role is granted a wallet↔ranking action (none exists to grant)', () => {
    for (const grants of Object.values(POLICY)) {
      for (const action of grants) {
        const a = action.toLowerCase();
        expect(a.includes('wallet') && (a.includes('ranking') || a.includes('attention'))).toBe(
          false,
        );
      }
    }
  });
});

describe('object-level ownership', () => {
  it('assertOwns is true only for the owner', () => {
    expect(assertOwns('u1', 'u1')).toBe(true);
    expect(assertOwns('u1', 'u2')).toBe(false);
  });

  it('private cross-user access resolves to not_found (404), never forbidden (403)', () => {
    expect(privateOwnershipOutcome('u1', 'u1')).toBe('ok');
    expect(privateOwnershipOutcome('u1', 'u2')).toBe('not_found');
  });
});

describe('isSteward', () => {
  it('is true for steward or admin only', () => {
    expect(isSteward(['steward'])).toBe(true);
    expect(isSteward(['admin'])).toBe(true);
    expect(isSteward(['moderator'])).toBe(false);
    expect(isSteward(['user'])).toBe(false);
    expect(isSteward(['expert'])).toBe(false);
    // The compliance plane never gains steward surfaces (WS-N.2.1c-2).
    expect(isSteward(['compliance'])).toBe(false);
    expect(isSteward(['counsel'])).toBe(false);
  });
});

describe('WS-N.2.1c-2 compliance/counsel capabilities', () => {
  it('reviewer access: compliance + counsel only — steward/admin never pass', () => {
    expect(isComplianceReviewer(['compliance'])).toBe(true);
    expect(isComplianceReviewer(['counsel'])).toBe(true);
    for (const role of ['user', 'expert', 'moderator', 'steward', 'admin'] as const) {
      expect(isComplianceReviewer([role]), `${role} must not review compliance`).toBe(false);
    }
  });

  it('counsel approval is distinct from reviewer access', () => {
    expect(isCounsel(['counsel'])).toBe(true);
    expect(isCounsel(['compliance'])).toBe(false);
    expect(isCounsel(['admin'])).toBe(false);
  });
});
