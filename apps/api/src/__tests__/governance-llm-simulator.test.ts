// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The DEV-ONLY simulated local governance-LLM runtime (simulator/governance-llm.ts),
// exercised END-TO-END through the REAL WS-U ADR-9 `local` backend seam over
// actual loopback HTTP: the OpenAI-compatible protocol shell, the WS-K
// registration/admission/deploy gate, the moderation proposer + the
// GovernanceService deterministic wrapper (ceiling clamp), the summariser +
// the §24.5 quality gate, the failure-injection markers, and the
// never-in-production guard. Nothing stubs the transport — every governed call
// here crosses the wire exactly as `pnpm dev` does.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_GOVERNANCE_LLM_SETTINGS,
  type GovernanceLlmSettings,
  resolveGovernanceLlmDecision,
} from '../ai-governance/llm/config.js';
import { createLocalCompletion } from '../ai-governance/llm/local.js';
import { createGovernanceLlmModerationProposer } from '../ai-governance/llm/moderation.js';
import { buildUserPrompt, createGovernanceLlmNlProvider } from '../ai-governance/llm/provider.js';
import {
  buildGovernanceLlmIdentity,
  buildGovernanceModerationProposerIdentity,
  ensureGovernanceLlmDeployed,
} from '../ai-governance/llm/registration.js';
import { createInMemoryAiGovernanceServices } from '../ai-governance/services.js';
import { createInMemoryEventPipelineServices } from '../events/services.js';
import type { ModerationDecisionObservation } from '../governance/moderation-proposer.js';
import { createGovernanceService } from '../governance/services.js';
import {
  classifySimulatedModeration,
  draftSimulatedSummary,
  parseProposal,
  SIMULATED_GOVERNANCE_LLM_MODEL_ID,
  type SimulatedGovernanceLlmHandle,
  startSimulatedGovernanceLlm,
} from '../simulator/governance-llm.js';

let sim: SimulatedGovernanceLlmHandle;
beforeAll(async () => {
  sim = await startSimulatedGovernanceLlm({ port: 0 });
});
afterAll(async () => {
  await sim.close();
});

/** A high breaker threshold so marker-injected failures never cross tests. */
function settings(): GovernanceLlmSettings {
  return {
    ...DEFAULT_GOVERNANCE_LLM_SETTINGS,
    modelId: SIMULATED_GOVERNANCE_LLM_MODEL_ID,
    breakerFailureThreshold: 100,
  };
}

function makeServices() {
  const now = () => Date.parse('2026-07-09T00:00:00.000Z');
  return createInMemoryAiGovernanceServices(createInMemoryEventPipelineServices({ now }), {
    now,
  });
}

function makeModerationProposer() {
  const s = settings();
  const services = makeServices();
  return {
    services,
    proposer: createGovernanceLlmModerationProposer({
      services,
      settings: s,
      identity: buildGovernanceModerationProposerIdentity(s, {
        kind: 'local',
        baseUrl: sim.baseUrl,
      }),
      complete: createLocalCompletion(sim.baseUrl, s),
    }),
  };
}

function moderationContext(over: Record<string, unknown> = {}) {
  return {
    contentText: 'Thanks, this is a helpful and civil comment.',
    contentKind: 'comment' as const,
    contentLength: 44,
    linkCount: 0,
    mentionCount: 0,
    hasMediaUpload: false,
    authorAccountAgeDays: 365,
    authorNewToRoom: false,
    priorRemovalsInRoom: 0,
    ...over,
  };
}

const SPAM_CONTEXT = moderationContext({
  contentText: 'BUY CHEAP PILLS NOW http://spam http://spam http://spam click click',
  contentLength: 66,
  linkCount: 3,
});

describe('the boot seam — the simulated runtime rides the unchanged local backend decision', () => {
  it('resolveGovernanceLlmDecision accepts the simulator base URL as a loopback local backend', () => {
    const decision = resolveGovernanceLlmDecision({
      provider: 'local',
      apiKey: undefined,
      modelId: SIMULATED_GOVERNANCE_LLM_MODEL_ID,
      localBaseUrl: sim.baseUrl,
      moderation: undefined,
    });
    expect(decision.enabled).toBe(true);
    if (decision.enabled) {
      expect(decision.backend).toEqual({ kind: 'local', baseUrl: sim.baseUrl });
      expect(decision.llmModeration).toBe(true);
    }
  });

  it('binds the loopback interface only and falls back to an ephemeral port when the requested one is taken', async () => {
    expect(sim.baseUrl.startsWith('http://127.0.0.1:')).toBe(true);
    const second = await startSimulatedGovernanceLlm({ port: sim.port });
    expect(second.port).not.toBe(sim.port);
    await second.close();
  });

  it('refuses to start in production (defense-in-depth on top of the NODE_ENV boot gate)', async () => {
    const prior = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      await expect(startSimulatedGovernanceLlm({ port: 0 })).rejects.toThrow(
        /never start in production/,
      );
    } finally {
      process.env['NODE_ENV'] = prior;
    }
  });
});

describe('protocol shell — OpenAI-compatible /chat/completions on loopback', () => {
  it('answers only POST …/chat/completions with JSON; rejects other methods/paths/bodies', async () => {
    const url = `${sim.baseUrl}/chat/completions`;
    expect((await fetch(url, { method: 'GET' })).status).toBe(405);
    expect((await fetch(`${sim.baseUrl}/models`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await fetch(url, { method: 'POST', body: 'not json' })).status).toBe(400);
    expect((await fetch(url, { method: 'POST', body: '{"nope":1}' })).status).toBe(400);
  });

  it('is deterministic: the same request yields byte-identical output', async () => {
    const { proposer } = makeModerationProposer();
    const request = {
      roomId: 'room-det',
      subjectRef: 'c1',
      context: SPAM_CONTEXT,
      moderationPrompt: null,
    };
    const first = await proposer.propose({ ...request, subjectRef: 'c1' });
    const second = await proposer.propose({ ...request, subjectRef: 'c2' });
    expect(first.status).toBe('decided');
    expect(second.status).toBe('decided');
    if (first.status === 'decided' && second.status === 'decided') {
      expect(second.proposal.action).toBe(first.proposal.action);
      expect(second.proposal.reason).toBe(first.proposal.reason);
    }
  });
});

describe('WS-K gate — both simulated-backend identities register + deploy through the real machinery', () => {
  it('ensureGovernanceLlmDeployed deploys the summariser and the moderation model', async () => {
    const services = makeServices();
    const backend = { kind: 'local', baseUrl: sim.baseUrl } as const;
    expect(
      await ensureGovernanceLlmDeployed(services, buildGovernanceLlmIdentity(settings(), backend)),
    ).toBe(true);
    expect(
      await ensureGovernanceLlmDeployed(
        services,
        buildGovernanceModerationProposerIdentity(settings(), backend),
      ),
    ).toBe(true);
  });
});

describe('moderation — the simulated model through the governed proposer', () => {
  it('classifies benign content allow and link-spam remove, with an immutable AIOutputRecord', async () => {
    const { proposer } = makeModerationProposer();
    const benign = await proposer.propose({
      roomId: 'room-1',
      subjectRef: 'c-benign',
      context: moderationContext(),
      moderationPrompt: null,
    });
    expect(benign).toMatchObject({ status: 'decided', proposal: { action: 'allow' } });
    const spam = await proposer.propose({
      roomId: 'room-1',
      subjectRef: 'c-spam',
      context: SPAM_CONTEXT,
      moderationPrompt: null,
    });
    expect(spam.status).toBe('decided');
    if (spam.status === 'decided') {
      expect(spam.proposal.action).toBe('remove');
      expect(spam.proposal.outputId).not.toBeNull();
    }
  });

  it('failure markers drive every fail-closed branch: transport, refusal, invalid output, forced verdicts', async () => {
    const { proposer } = makeModerationProposer();
    const propose = (contentText: string, subjectRef: string) =>
      proposer.propose({
        roomId: 'room-2',
        subjectRef,
        context: moderationContext({ contentText }),
        moderationPrompt: null,
      });
    expect(await propose('please [sim:error] this', 'c1')).toMatchObject({
      status: 'unavailable',
      code: 'transport',
    });
    expect(await propose('please [sim:refuse] this', 'c2')).toMatchObject({
      status: 'unavailable',
      code: 'refusal',
    });
    expect(await propose('please [sim:truncate] this', 'c3')).toMatchObject({
      status: 'unavailable',
      code: 'truncated',
    });
    expect(await propose('please [sim:garbage] this', 'c4')).toMatchObject({
      status: 'unavailable',
      code: 'invalid_output',
    });
    expect(await propose('fine text [sim:propose=restrict]', 'c5')).toMatchObject({
      status: 'decided',
      proposal: { action: 'restrict' },
    });
  });
});

describe('GovernanceService end-to-end — admission, activation, and the wrapper clamp', () => {
  it('a community model clears the platform admission gate over live HTTP and the wrapper bounds a proposed remove to flag_for_review', async () => {
    const { proposer } = makeModerationProposer();
    const decisions: ModerationDecisionObservation[] = [];
    const governance = createGovernanceService({
      moderationProposer: proposer,
      onModerationDecided: (record) => decisions.push(record),
    });
    const roomId = 'room-gov';
    const steward = 'user-steward';
    await governance.bootstrapSeat(roomId, steward);
    const proposed = await governance.proposeModel(
      roomId,
      steward,
      {
        bundleId: 'sim-civility',
        version: '1',
        name: 'Simulated civility policy',
        moderationPrompt: 'Route link-heavy or spammy contributions to human review.',
        promptTemplates: {},
        config: { summaryStyle: 'neutral_brief', explanationVerbosity: 'standard' },
        requestedCapabilities: ['moderate.flag', 'lawmaking.summarize'],
      },
      'Be neutral and concise.',
    );
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    // Admission samples the SIMULATED model over the platform eval set — through
    // real loopback HTTP — and must pass deterministically (k-of-N agreement).
    const evaluated = await governance.evaluateModel(proposed.value.modelId);
    expect(evaluated).toMatchObject({ ok: true, value: { status: 'eligible' } });

    const approved = await governance.approveModel(roomId, proposed.value.modelId, null, null);
    expect(approved.ok).toBe(true);

    // The model proposes `remove` for link-spam; the deterministic wrapper caps it
    // at the escalate-to-human-review ceiling (a human resolves the challenge).
    const decision = await governance.moderate(roomId, SPAM_CONTEXT, 'contribution-1');
    expect(decision).toMatchObject({ ok: true, value: { action: 'flag_for_review' } });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      proposedAction: 'remove',
      boundedAction: 'flag_for_review',
      clamped: true,
    });
  });
});

describe('lawmaking summariser — the simulated model through the governed provider + §24.5 gate', () => {
  const PROPOSAL = {
    proposalId: 'prop-1',
    title: 'Adopt a weekly community digest',
    body: 'Members propose an opt-in weekly digest summarising the most-discussed threads.',
    options: ['Adopt', 'Reject'],
  };

  function makeProvider() {
    const s = settings();
    const services = makeServices();
    return createGovernanceLlmNlProvider({
      services,
      settings: s,
      identity: buildGovernanceLlmIdentity(s, { kind: 'local', baseUrl: sim.baseUrl }),
      complete: createLocalCompletion(sim.baseUrl, s),
    });
  }

  function request(proposal: typeof PROPOSAL) {
    return {
      roomId: 'room-gov',
      proposal,
      roomPromptText: 'Be neutral and concise.',
      promptTemplate: null,
      summaryStyle: 'neutral_brief' as const,
    };
  }

  it('produces a grounded summary that clears the deterministic quality gate', async () => {
    const summary = await makeProvider().summarizeProposal(request(PROPOSAL));
    expect(summary.proposalId).toBe('prop-1');
    expect(summary.headline).toBe('Adopt a weekly community digest');
    expect(summary.optionCount).toBe(2);
    expect(summary.summary).toContain('opt-in weekly digest');
    expect(summary.summary).toContain('Options: Adopt; Reject');
  });

  it('the [sim:ungrounded] and [sim:foreign-url] markers are rejected by the quality gate', async () => {
    await expect(
      makeProvider().summarizeProposal(
        request({ ...PROPOSAL, body: `${PROPOSAL.body} [sim:ungrounded]` }),
      ),
    ).rejects.toMatchObject({ name: 'GovernanceLlmError', code: 'quality' });
    await expect(
      makeProvider().summarizeProposal(
        request({ ...PROPOSAL, body: `${PROPOSAL.body} [sim:foreign-url]` }),
      ),
    ).rejects.toMatchObject({ code: 'quality' });
  });

  it('the prompt parser stays in sync with the real prompt builder', () => {
    const parsed = parseProposal(buildUserPrompt(request(PROPOSAL)));
    expect(parsed).toEqual({
      title: PROPOSAL.title,
      body: PROPOSAL.body,
      options: PROPOSAL.options,
    });
    const draft = draftSimulatedSummary(parsed);
    expect(draft.headline.length).toBeLessThanOrEqual(120);
    expect(draft.summary.length).toBeLessThanOrEqual(600);
  });
});

describe('the simulated classifier ladder (pure)', () => {
  const base = {
    linkCount: 0,
    authorAccountAgeDays: 365,
    authorNewToRoom: false,
    priorRemovalsInRoom: 0,
    text: 'A thoughtful contribution.',
  };
  it('spans the full vocabulary deterministically', () => {
    expect(classifySimulatedModeration(base).action).toBe('allow');
    expect(
      classifySimulatedModeration({ ...base, text: 'buy cheap pills', linkCount: 1 }).action,
    ).toBe('remove');
    expect(classifySimulatedModeration({ ...base, text: 'buy cheap pills' }).action).toBe(
      'flag_for_review',
    );
    expect(classifySimulatedModeration({ ...base, text: 'you are an idiot' }).action).toBe(
      'flag_for_review',
    );
    expect(classifySimulatedModeration({ ...base, linkCount: 3 }).action).toBe('flag_for_review');
    expect(classifySimulatedModeration({ ...base, priorRemovalsInRoom: 2 }).action).toBe(
      'flag_for_review',
    );
    expect(
      classifySimulatedModeration({ ...base, authorNewToRoom: true, linkCount: 1 }).action,
    ).toBe('flag_for_review');
    expect(
      classifySimulatedModeration({ ...base, authorAccountAgeDays: 2, linkCount: 1 }).action,
    ).toBe('warn');
  });
});
