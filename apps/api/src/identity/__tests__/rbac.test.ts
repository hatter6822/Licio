// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  type Action,
  assertOwns,
  authorize,
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
    ],
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
  });
});
