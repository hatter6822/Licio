// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The governed LLM debate adjudicator (WS-T challenge resolution — the AI
// reviewing a sourced story/comment correction debate). Verifies the ADR-5
// split: the model emits ONLY probabilities + a bounded rationale, the
// deterministic shell owns the outcome (normalization, judgeDebate's exact
// argmax/tie rule, the class→verdict vocabulary, the no-URL rationale bound),
// and EVERY failure path — transport, refusal, truncation, schema, degenerate
// distribution, URL rationale, budget, breaker, provenance-write failure —
// returns null so `adjudicateDebate` falls back to the deterministic MLP (a
// verdict is always rendered; never an unrecorded LLM verdict).

import type { DebateJudgeInput } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import { adjudicateDebate } from '../ai-governance/debate.js';
import {
  DEFAULT_GOVERNANCE_LLM_SETTINGS,
  type GovernanceLlmSettings,
} from '../ai-governance/llm/config.js';
import {
  boundDebateAssessment,
  buildDebateUserPrompt,
  createGovernanceLlmDebateJudge,
} from '../ai-governance/llm/debate.js';
import type { LlmCompletionRequest, LlmCompletionResult } from '../ai-governance/llm/provider.js';
import { buildGovernanceDebateJudgeIdentity } from '../ai-governance/llm/registration.js';
import {
  type AiGovernanceServices,
  createInMemoryAiGovernanceServices,
} from '../ai-governance/services.js';
import { createInMemoryEventPipelineServices } from '../events/services.js';

const BACKEND = { kind: 'local', baseUrl: 'http://127.0.0.1:11434/v1' } as const;

const GOOD_ASSESSMENT = JSON.stringify({
  probabilities: { incumbent: 0.1, challenger: 0.85, inconclusive: 0.05 },
  rationale: 'The challenger presented more independent, reliable sources and a direct rebuttal.',
});

const INPUT: DebateJudgeInput = {
  incumbent: {
    content: 'The disputed figure was 40% according to the original report.',
    summary: 'The original claim stands as written.',
    sources: [],
    rebuts_opponent: false,
  },
  challenger: {
    content: 'The actual figure was 4%, per three independent measurements.',
    summary:
      'The correction cites three independent reports contradicting the claimed figure and quotes the original passage directly.',
    sources: [
      { url: 'https://a.example/report', domain: 'a.example', link_safe: true, reliability: 0.9 },
      { url: 'https://b.example/study', domain: 'b.example', link_safe: true, reliability: 0.8 },
      { url: 'https://c.example/data', domain: 'c.example', link_safe: true, reliability: 0.85 },
    ],
    rebuts_opponent: true,
  },
};

interface Harness {
  services: AiGovernanceServices;
  judge: ReturnType<typeof createGovernanceLlmDebateJudge>;
  requests: LlmCompletionRequest[];
  queue: Array<LlmCompletionResult | Error>;
}
function makeHarness(over: Partial<GovernanceLlmSettings> = {}): Harness {
  const now = () => Date.parse('2026-07-09T00:00:00.000Z');
  const settings: GovernanceLlmSettings = {
    ...DEFAULT_GOVERNANCE_LLM_SETTINGS,
    modelId: 'test-local-model',
    ...over,
  };
  const services = createInMemoryAiGovernanceServices(
    createInMemoryEventPipelineServices({ now }),
    { now },
  );
  const requests: LlmCompletionRequest[] = [];
  const queue: Array<LlmCompletionResult | Error> = [];
  const judge = createGovernanceLlmDebateJudge({
    services,
    settings,
    identity: buildGovernanceDebateJudgeIdentity(settings, BACKEND),
    complete: async (request) => {
      requests.push(request);
      const next = queue.shift() ?? { stopReason: 'end_turn', text: GOOD_ASSESSMENT };
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { services, judge, requests, queue };
}

describe('boundDebateAssessment — the deterministic shell over the raw probabilities', () => {
  const rationale = 'Comparative sourcing quality decided it.';

  it('normalizes an unnormalized distribution and applies the exact argmax rule', () => {
    const verdict = boundDebateAssessment(
      { probabilities: { incumbent: 0.5, challenger: 0.25, inconclusive: 0.25 }, rationale },
      'model-x',
    );
    expect(verdict).toMatchObject({
      winner: 'incumbent',
      verdict: 'upheld',
      confidence: 0.5,
      model_version: 'model-x',
    });
    // Renormalization: {2, 1, 1} → {0.5, 0.25, 0.25}.
    const scaled = boundDebateAssessment(
      { probabilities: { incumbent: 1, challenger: 0.5, inconclusive: 0.5 }, rationale },
      'model-x',
    );
    expect(scaled?.probabilities).toEqual({ incumbent: 0.5, challenger: 0.25, inconclusive: 0.25 });
  });

  it('resolves ties exactly like judgeDebate (inconclusive-first; strict > to win)', () => {
    const threeWay = boundDebateAssessment(
      {
        probabilities: { incumbent: 1 / 3, challenger: 1 / 3, inconclusive: 1 / 3 },
        rationale,
      },
      'model-x',
    );
    expect(threeWay?.verdict).toBe('inconclusive');
    expect(threeWay?.winner).toBe('none');
  });

  it('rejects a degenerate distribution and a URL-carrying or empty rationale (⇒ unavailable)', () => {
    const probabilities = { incumbent: 0.1, challenger: 0.8, inconclusive: 0.1 };
    expect(
      boundDebateAssessment(
        { probabilities: { incumbent: 0, challenger: 0, inconclusive: 0 }, rationale },
        'model-x',
      ),
    ).toBeNull();
    expect(
      boundDebateAssessment(
        { probabilities, rationale: 'See https://exfil.example/proof for details.' },
        'model-x',
      ),
    ).toBeNull();
    expect(boundDebateAssessment({ probabilities, rationale: '   \n ' }, 'model-x')).toBeNull();
  });
});

describe('the governed LLM debate judge', () => {
  it('renders a shell-mapped verdict with an immutable AIOutputRecord', async () => {
    const h = makeHarness();
    const outcome = await h.judge('debate-1', INPUT);
    expect(outcome).not.toBeNull();
    if (outcome) {
      expect(outcome.verdict.verdict).toBe('corrected');
      expect(outcome.verdict.winner).toBe('challenger');
      expect(outcome.verdict.model_version).toMatch(/^governance-debate-llm-local-[0-9a-f]{12}$/);
      expect(outcome.outputId).toBeTruthy();
    }
    // The prompt carries both positions as data.
    expect(h.requests[0]?.user).toContain('<position side="incumbent">');
    expect(h.requests[0]?.user).toContain('<position side="challenger">');
  });

  it('returns null on transport/refusal/truncation/invalid output/unusable assessment', async () => {
    const h = makeHarness({ breakerFailureThreshold: 100 });
    h.queue.push(new Error('down'));
    expect(await h.judge('d1', INPUT)).toBeNull();
    h.queue.push({ stopReason: 'refusal', text: null });
    expect(await h.judge('d2', INPUT)).toBeNull();
    h.queue.push({ stopReason: 'max_tokens', text: '{"probab' });
    expect(await h.judge('d3', INPUT)).toBeNull();
    h.queue.push({ stopReason: 'end_turn', text: 'the challenger wins, probably' });
    expect(await h.judge('d4', INPUT)).toBeNull();
    h.queue.push({
      stopReason: 'end_turn',
      text: JSON.stringify({
        probabilities: { incumbent: 0.2, challenger: 0.7, inconclusive: 0.1 },
        rationale: 'see https://exfil.example',
      }),
    });
    expect(await h.judge('d5', INPUT)).toBeNull();
    expect(h.services.metrics.counter('ai.governance.debate.llm.unavailable.transport')).toBe(1);
    expect(
      h.services.metrics.counter('ai.governance.debate.llm.unavailable.unusable_assessment'),
    ).toBe(1);
  });

  it('fails closed to null when the AIOutputRecord cannot be written (never an unrecorded verdict)', async () => {
    const h = makeHarness();
    h.services.outputRecords.put = async () => {
      throw new Error('store down');
    };
    expect(await h.judge('d1', INPUT)).toBeNull();
    expect(h.services.metrics.counter('ai.governance.debate.llm.record_failed')).toBe(1);
  });

  it('enforces the global hourly budget and the consecutive-failure breaker', async () => {
    const budgeted = makeHarness({ maxDebateJudgementsPerHour: 2 });
    expect(await budgeted.judge('d1', INPUT)).not.toBeNull();
    expect(await budgeted.judge('d2', INPUT)).not.toBeNull();
    expect(await budgeted.judge('d3', INPUT)).toBeNull(); // budget_exhausted
    expect(budgeted.requests).toHaveLength(2);

    const braked = makeHarness({ breakerFailureThreshold: 2 });
    braked.queue.push(new Error('down'), new Error('down'));
    await braked.judge('d1', INPUT);
    await braked.judge('d2', INPUT);
    expect(await braked.judge('d3', INPUT)).toBeNull(); // breaker_open — no call
    expect(braked.requests).toHaveLength(2);
  });
});

describe('adjudicateDebate — LLM primary, deterministic MLP fail-closed fallback', () => {
  function shellDeps(h: Harness) {
    return {
      guard: h.services.guard,
      outputRecords: h.services.outputRecords,
      now: h.services.now,
    };
  }

  it('returns the LLM verdict when the leg decides', async () => {
    const h = makeHarness();
    const outcome = await adjudicateDebate(
      { ...shellDeps(h), llmJudge: h.judge },
      'debate-1',
      INPUT,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.verdict.model_version).toMatch(/^governance-debate-llm-local-/);
      expect(outcome.verdict.verdict).toBe('corrected');
    }
  });

  it('falls back to the deterministic MLP when the LLM leg is unavailable', async () => {
    const h = makeHarness({ breakerFailureThreshold: 100 });
    h.queue.push(new Error('down'));
    const outcome = await adjudicateDebate(
      { ...shellDeps(h), llmJudge: h.judge },
      'debate-1',
      INPUT,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // The pinned-weights MLP rendered the verdict (its weights version —
      // 1.1.0: the substance feature spans the locked underlying content).
      expect(outcome.verdict.model_version).toBe('1.1.0');
      // The strongly-sourced challenger still prevails on structural features.
      expect(outcome.verdict.verdict).toBe('corrected');
    }
  });

  it('the prompt builder emits the exact side-block format (parser-sync anchor)', () => {
    const prompt = buildDebateUserPrompt(INPUT);
    expect(prompt).toContain('rebuts_opponent: true');
    expect(prompt).toContain('sources (3):');
    expect(prompt).toContain(
      '- url: https://a.example/report | domain: a.example | link_safe: true | reliability: 0.9',
    );
  });
});

describe('provenance-write failures count toward the breaker', () => {
  it('record_failed opens the breaker instead of pinning it closed while spending completions', async () => {
    const h = makeHarness({ breakerFailureThreshold: 2 });
    h.services.outputRecords.put = async () => {
      throw new Error('output-record store down');
    };
    expect(await h.judge('d1', INPUT)).toBeNull(); // record_failed (breaker 1)
    expect(await h.judge('d2', INPUT)).toBeNull(); // record_failed (breaker 2 → open)
    expect(await h.judge('d3', INPUT)).toBeNull(); // breaker_open — no completion spent
    expect(h.requests).toHaveLength(2);
    expect(h.services.metrics.counter('ai.governance.debate.llm.unavailable.breaker_open')).toBe(1);
  });
});
