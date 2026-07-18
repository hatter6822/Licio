// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  challengeTransitionAllowed,
  GOVERNANCE_MODE_EDGES,
  GOVERNANCE_MODES_ORDERED,
  type GovernanceModeName,
  modeTransitionGate,
  PAYMENT_INTENT_STATES,
  PAYMENT_INTENT_TERMINAL_STATES,
  type PaymentIntentState,
  PLATFORM_ESCALATING_CHALLENGE_TYPES,
  paymentIntentTransitionAllowed,
} from '../lifecycle.js';

describe('payment-intent state machine (WS-M.3.1b)', () => {
  it('accepts the full happy path', () => {
    const happy: PaymentIntentState[] = [
      'created',
      'preflighted',
      'quoted',
      'signed',
      'submitted',
      'pending',
      'confirmed',
      'finalized',
    ];
    for (let i = 0; i < happy.length - 1; i += 1) {
      expect(
        paymentIntentTransitionAllowed(
          happy[i] as PaymentIntentState,
          happy[i + 1] as PaymentIntentState,
        ),
      ).toBe(true);
    }
  });

  it('every pre-submission state can abandon; post-submission states cannot', () => {
    for (const from of ['created', 'preflighted', 'quoted', 'signed'] as const) {
      expect(paymentIntentTransitionAllowed(from, 'abandoned')).toBe(true);
    }
    for (const from of ['submitted', 'pending', 'confirmed', 'finalized'] as const) {
      expect(paymentIntentTransitionAllowed(from, 'abandoned')).toBe(false);
    }
  });

  it('models the error paths exactly (failed, reverted, reorged, disputed)', () => {
    expect(paymentIntentTransitionAllowed('submitted', 'failed')).toBe(true);
    expect(paymentIntentTransitionAllowed('pending', 'reverted')).toBe(true);
    expect(paymentIntentTransitionAllowed('confirmed', 'reorged')).toBe(true);
    expect(paymentIntentTransitionAllowed('finalized', 'disputed')).toBe(true);
    expect(paymentIntentTransitionAllowed('reorged', 'pending')).toBe(true);
    expect(paymentIntentTransitionAllowed('reorged', 'abandoned')).toBe(true);
    expect(paymentIntentTransitionAllowed('failed', 'created')).toBe(true);
    expect(paymentIntentTransitionAllowed('reverted', 'created')).toBe(true);
  });

  it('rejects state skips and terminal exits', () => {
    expect(paymentIntentTransitionAllowed('created', 'signed')).toBe(false);
    expect(paymentIntentTransitionAllowed('created', 'finalized')).toBe(false);
    expect(paymentIntentTransitionAllowed('quoted', 'submitted')).toBe(false);
    expect(paymentIntentTransitionAllowed('finalized', 'created')).toBe(false);
    for (const terminal of PAYMENT_INTENT_TERMINAL_STATES) {
      for (const to of PAYMENT_INTENT_STATES) {
        expect(paymentIntentTransitionAllowed(terminal, to)).toBe(false);
      }
    }
  });

  it('exposes exactly the thirteen §22.2 states', () => {
    expect(PAYMENT_INTENT_STATES).toHaveLength(13);
  });
});

describe('governance-mode transition table (WS-M.1.1b)', () => {
  it('keeps the shipped WS-L.4.1g edges with their shipped gates', () => {
    expect(modeTransitionGate('ordinary', 'simulated')).toBe('free');
    expect(modeTransitionGate('simulated', 'testnet')).toBe('readiness');
  });

  it('gates every escalation with readiness and every de-escalation as rollback', () => {
    expect(modeTransitionGate('testnet', 'capped_production')).toBe('readiness');
    expect(modeTransitionGate('capped_production', 'mature_production')).toBe('readiness');
    expect(modeTransitionGate('simulated', 'ordinary')).toBe('rollback');
    expect(modeTransitionGate('testnet', 'ordinary')).toBe('rollback');
    expect(modeTransitionGate('migrating', 'ordinary')).toBe('rollback');
  });

  it('permits the emergency freeze from every active mode and never from frozen', () => {
    for (const from of [
      'ordinary',
      'simulated',
      'testnet',
      'capped_production',
      'mature_production',
      'migrating',
    ] as const) {
      expect(modeTransitionGate(from, 'frozen')).toBe('emergency');
    }
    expect(modeTransitionGate('frozen', 'frozen')).toBeNull();
  });

  it('routes frozen recovery through migrating only', () => {
    expect(modeTransitionGate('frozen', 'migrating')).toBe('post_remediation');
    expect(modeTransitionGate('frozen', 'ordinary')).toBeNull();
    expect(modeTransitionGate('frozen', 'capped_production')).toBeNull();
    expect(modeTransitionGate('migrating', 'capped_production')).toBe('resume');
    expect(modeTransitionGate('migrating', 'mature_production')).toBeNull();
  });

  it('rejects every mode skip in the escalation ladder', () => {
    expect(modeTransitionGate('ordinary', 'testnet')).toBeNull();
    expect(modeTransitionGate('ordinary', 'capped_production')).toBeNull();
    expect(modeTransitionGate('ordinary', 'mature_production')).toBeNull();
    expect(modeTransitionGate('simulated', 'capped_production')).toBeNull();
    expect(modeTransitionGate('simulated', 'mature_production')).toBeNull();
    expect(modeTransitionGate('testnet', 'mature_production')).toBeNull();
    expect(modeTransitionGate('mature_production', 'capped_production')).toBeNull();
  });

  it('lists only edges between known modes (table integrity)', () => {
    const known = new Set<GovernanceModeName>(GOVERNANCE_MODES_ORDERED);
    for (const edge of GOVERNANCE_MODE_EDGES) {
      expect(known.has(edge.from)).toBe(true);
      expect(known.has(edge.to)).toBe(true);
      expect(edge.from).not.toBe(edge.to);
    }
  });
});

describe('challenge lifecycle (WS-M.4.3a)', () => {
  it('resolves open challenges to upheld/dismissed/escalated and escalations to final dispositions', () => {
    expect(challengeTransitionAllowed('open', 'upheld')).toBe(true);
    expect(challengeTransitionAllowed('open', 'dismissed')).toBe(true);
    expect(challengeTransitionAllowed('open', 'escalated')).toBe(true);
    expect(challengeTransitionAllowed('escalated', 'upheld')).toBe(true);
    expect(challengeTransitionAllowed('escalated', 'dismissed')).toBe(true);
    expect(challengeTransitionAllowed('upheld', 'dismissed')).toBe(false);
    expect(challengeTransitionAllowed('dismissed', 'open')).toBe(false);
    expect(challengeTransitionAllowed('escalated', 'open')).toBe(false);
  });

  it('legal and capture challenges always carry a platform-escalation path', () => {
    expect(PLATFORM_ESCALATING_CHALLENGE_TYPES.has('legal')).toBe(true);
    expect(PLATFORM_ESCALATING_CHALLENGE_TYPES.has('capture')).toBe(true);
    expect(PLATFORM_ESCALATING_CHALLENGE_TYPES.has('coi')).toBe(false);
  });
});
