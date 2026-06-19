// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K.1.1d + WS-K.2.2a — the ProhibitedUseGuard. Every prohibited use is blocked
// before execution; every permitted use (incl. the seven §24.5 governance
// capabilities) is allowed; the structural flags catch a permitted capability
// that would still cross a prohibition.
import { describe, expect, it } from 'vitest';
import {
  type AiCapability,
  type AiInvocation,
  aiInvocationSchema,
  CAPABILITY_CLASSIFICATION,
  classifyCapability,
  evaluateInvocation,
  GOVERNANCE_PERMITTED_CAPABILITIES,
  GOVERNANCE_PROHIBITED_CAPABILITIES,
  isGovernanceCapability,
} from '../index.js';

function invocation(over: Partial<AiInvocation> & { capability: AiCapability }): AiInvocation {
  return aiInvocationSchema.parse({
    use_case_id: 'governance_assistance',
    caller: 'test',
    ...over,
  });
}

describe('WS-K.1.1d prohibited-use guard', () => {
  it('blocks autonomous treasury execution', () => {
    const decision = evaluateInvocation(
      invocation({ capability: 'treasury_execute', use_case_id: 'governance_assistance' }),
    );
    expect(decision.decision).toBe('block');
    if (decision.decision === 'block') {
      expect(decision.prohibition).toBe('autonomous_treasury_execution');
    }
  });

  it('blocks investment advice', () => {
    const decision = evaluateInvocation(invocation({ capability: 'investment_advice' }));
    expect(decision).toMatchObject({ decision: 'block', prohibition: 'investment_advice' });
  });

  it('blocks manipulative voting recommendations', () => {
    const decision = evaluateInvocation(invocation({ capability: 'voting_recommendation' }));
    expect(decision).toMatchObject({
      decision: 'block',
      prohibition: 'manipulative_voting_recommendation',
    });
  });

  it('blocks wallet-based profiling', () => {
    const decision = evaluateInvocation(invocation({ capability: 'wealth_profiling' }));
    expect(decision).toMatchObject({ decision: 'block', prohibition: 'wealth_based_profiling' });
  });

  it('blocks risk-identity hiding', () => {
    const decision = evaluateInvocation(invocation({ capability: 'risk_identity_rewrite' }));
    expect(decision).toMatchObject({ decision: 'block', prohibition: 'risk_identity_hiding' });
  });

  it('permits a governance proposal summary (permitted use)', () => {
    const decision = evaluateInvocation(
      invocation({ capability: 'gov_summarize_proposal', use_case_id: 'governance_assistance' }),
    );
    expect(decision.decision).toBe('allow');
  });

  it('permits a treasury-action explanation (permitted use)', () => {
    const decision = evaluateInvocation(invocation({ capability: 'gov_explain_treasury_action' }));
    expect(decision.decision).toBe('allow');
  });

  it('permits the normal content pipelines', () => {
    for (const capability of [
      'classify_topic',
      'extract_claim',
      'summarize_thread',
      'translate_content',
      'generate_embedding',
      'triage_safety',
      'detect_duplicate',
    ] as const) {
      expect(evaluateInvocation(invocation({ capability })).decision).toBe('allow');
    }
  });

  it('blocks all six §24.5 prohibited governance capabilities', () => {
    for (const capability of GOVERNANCE_PROHIBITED_CAPABILITIES) {
      const decision = evaluateInvocation(invocation({ capability }));
      expect(decision.decision).toBe('block');
    }
    // The six §24.5 governance prohibitions cover the five platform prohibitions.
    expect(GOVERNANCE_PROHIBITED_CAPABILITIES).toHaveLength(6);
  });

  it('exposes exactly seven permitted governance capabilities (§24.5)', () => {
    expect(GOVERNANCE_PERMITTED_CAPABILITIES).toHaveLength(7);
    for (const capability of GOVERNANCE_PERMITTED_CAPABILITIES) {
      expect(isGovernanceCapability(capability)).toBe(true);
      expect(evaluateInvocation(invocation({ capability })).decision).toBe('allow');
    }
  });

  describe('structural defense-in-depth (a permitted capability still blocked)', () => {
    it('blocks an output that would take autonomous effect', () => {
      const decision = evaluateInvocation(
        invocation({ capability: 'gov_explain_treasury_action', effect: 'execute' }),
      );
      expect(decision).toMatchObject({
        decision: 'block',
        prohibition: 'autonomous_treasury_execution',
      });
    });

    it('blocks an invocation that reads wealth signals', () => {
      const decision = evaluateInvocation(
        invocation({ capability: 'gov_summarize_proposal', uses_wealth_signals: true }),
      );
      expect(decision).toMatchObject({
        decision: 'block',
        prohibition: 'wealth_based_profiling',
      });
    });

    it('blocks an invocation that targets a risk actor’s identity', () => {
      const decision = evaluateInvocation(
        invocation({ capability: 'summarize_thread', targets_risk_identity: true }),
      );
      expect(decision).toMatchObject({ decision: 'block', prohibition: 'risk_identity_hiding' });
    });
  });

  it('classifies every capability in the matrix', () => {
    for (const capability of Object.keys(CAPABILITY_CLASSIFICATION) as AiCapability[]) {
      const klass = classifyCapability(capability);
      expect(['permitted', 'prohibited']).toContain(klass.kind);
      if (klass.kind === 'prohibited') expect(klass.prohibition).toBeDefined();
    }
  });
});
