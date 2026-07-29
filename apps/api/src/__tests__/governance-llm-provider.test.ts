// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The hosted-LLM governance NL provider runs the FULL governed path: guard
// BEFORE the model, strict schema + the deterministic quality gate on the way
// out, an immutable AIOutputRecord pinning the config surface, the ADR-6
// per-room budget, and a consecutive-failure circuit breaker. Every failure
// throws a typed GovernanceLlmError (the GovernanceService falls back
// deterministically) and never writes an output record.
import type { AiInvocation } from '@licio/ai-governance';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProhibitedUseGuard } from '../ai-governance/guard.js';
import { DEFAULT_GOVERNANCE_LLM_SETTINGS } from '../ai-governance/llm/config.js';
import {
  createAnthropicCompletion,
  createGovernanceLlmNlProvider,
  GovernanceLlmError,
  type LlmCompletionRequest,
  type LlmCompletionResult,
} from '../ai-governance/llm/provider.js';
import { buildGovernanceLlmIdentity } from '../ai-governance/llm/registration.js';
import { configHash } from '../ai-governance/output-records.js';
import {
  type AiGovernanceServices,
  createInMemoryAiGovernanceServices,
} from '../ai-governance/services.js';
import { createInMemoryEventPipelineServices } from '../events/services.js';
import type { GovernanceNlProvider, LawmakingSummaryRequest } from '../governance/nl-provider.js';

const SETTINGS = {
  ...DEFAULT_GOVERNANCE_LLM_SETTINGS,
  maxCallsPerRoomPerHour: 2,
  breakerFailureThreshold: 2,
  breakerCooldownSeconds: 60,
};

const BACKEND = { kind: 'anthropic', apiKey: 'sk-ant-test-key' } as const;

const GOOD_DRAFT = {
  headline: 'Adopt a weekly digest',
  summary:
    'Create an opt-in weekly digest email that collects the room highlights every Friday. Yes. No.',
};

function request(overrides: Partial<LawmakingSummaryRequest> = {}): LawmakingSummaryRequest {
  return {
    roomId: 'room-1',
    proposal: {
      proposalId: 'prop-1',
      title: 'Adopt a weekly digest',
      body: 'Create an opt-in weekly digest email that collects the room highlights every Friday.',
      options: ['Yes', 'No'],
    },
    roomPromptText: 'Be concise and cite the room charter.',
    promptTemplate: 'Lead with what changes for members.',
    summaryStyle: 'neutral_brief',
    adjudicationRef: null,
    ...overrides,
  };
}

interface Harness {
  services: AiGovernanceServices;
  provider: GovernanceNlProvider;
  requests: LlmCompletionRequest[];
  /** Program the fake: a result to return, or an Error to throw. */
  queue: Array<LlmCompletionResult | Error>;
  advance: (ms: number) => void;
}

function makeHarness(): Harness {
  let nowMs = Date.parse('2026-07-01T00:00:00.000Z');
  const NOW = () => nowMs;
  const events = createInMemoryEventPipelineServices({ now: NOW });
  const services = createInMemoryAiGovernanceServices(events, { now: NOW });
  const requests: LlmCompletionRequest[] = [];
  const queue: Array<LlmCompletionResult | Error> = [];
  const provider = createGovernanceLlmNlProvider({
    services,
    settings: SETTINGS,
    identity: buildGovernanceLlmIdentity(SETTINGS, BACKEND),
    complete: async (req) => {
      requests.push(req);
      const next = queue.shift() ?? { stopReason: 'end_turn', text: JSON.stringify(GOOD_DRAFT) };
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return {
    services,
    provider,
    requests,
    queue,
    advance: (ms) => {
      nowMs += ms;
    },
  };
}

async function expectFailure(h: Harness, code: string): Promise<void> {
  try {
    await h.provider.summarizeProposal(request());
    expect.unreachable('provider should have thrown');
  } catch (error) {
    expect(error).toBeInstanceOf(GovernanceLlmError);
    expect((error as GovernanceLlmError).code).toBe(code);
  }
}

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});

describe('governance LLM provider — governed happy path', () => {
  it('returns the gated draft as a ProposalSummary and records an immutable AIOutputRecord', async () => {
    const summary = await h.provider.summarizeProposal(request());
    expect(summary).toEqual({
      proposalId: 'prop-1',
      headline: GOOD_DRAFT.headline,
      optionCount: 2,
      summary: GOOD_DRAFT.summary,
    });

    const identity = buildGovernanceLlmIdentity(SETTINGS, BACKEND);
    const records = await h.services.outputRecords.listByModel(identity.name, identity.version);
    expect(records).toHaveLength(1);
    expect(records[0]?.model_name).toBe(identity.name);
    expect(identity.name).toMatch(/^governance-summarizer-llm-anthropic-[0-9a-f]{12}$/);
    expect(records[0]?.use_case_id).toBe('governance_assistance');
    expect(records[0]?.config_hash).toBe(configHash(identity.config));
    expect(records[0]?.input_refs).toEqual(['room:room-1', 'proposal:prop-1']);
    expect(h.services.metrics.counter('ai.governance.llm.summary.generated')).toBe(1);
  });

  it('assembles layered prompts: platform rules + room prompt + template in system; the proposal ONLY in the user turn', async () => {
    await h.provider.summarizeProposal(request());
    const sent = h.requests[0];
    expect(sent).toBeDefined();
    if (!sent) return;
    expect(sent.system).toContain('Platform rules');
    expect(sent.system).toContain('at most three short sentences'); // neutral_brief
    expect(sent.system).toContain('Be concise and cite the room charter.');
    expect(sent.system).toContain('Lead with what changes for members.');
    expect(sent.system).not.toContain('weekly digest email'); // proposal body stays out
    expect(sent.user).toContain('<proposal>');
    expect(sent.user).toContain('Adopt a weekly digest');
    expect(sent.user).toContain('weekly digest email');
    expect(sent.maxOutputTokens).toBe(SETTINGS.maxOutputTokens);
  });

  it('uses the detailed style directive for neutral_detailed bundles', async () => {
    await h.provider.summarizeProposal(request({ summaryStyle: 'neutral_detailed' }));
    expect(h.requests[0]?.system).toContain('every material field');
  });

  it('runs the prohibited-use guard BEFORE the model call', async () => {
    const order: string[] = [];
    class SpyGuard extends ProhibitedUseGuard {
      override async enforce(invocation: AiInvocation): Promise<void> {
        order.push('guard');
        expect(invocation.capability).toBe('gov_summarize_proposal');
        expect(invocation.effect).toBe('advisory');
        return super.enforce(invocation);
      }
    }
    h.services.guard = new SpyGuard({
      blocked: h.services.blocked,
      metrics: h.services.metrics,
      log: h.services.log,
      now: h.services.now,
    });
    h.queue.push({ stopReason: 'end_turn', text: JSON.stringify(GOOD_DRAFT) });
    const provider = createGovernanceLlmNlProvider({
      services: h.services,
      settings: SETTINGS,
      identity: buildGovernanceLlmIdentity(SETTINGS, BACKEND),
      complete: async (req) => {
        order.push('complete');
        h.requests.push(req);
        const next = h.queue.shift();
        if (next instanceof Error) throw next;
        return next ?? { stopReason: 'end_turn', text: JSON.stringify(GOOD_DRAFT) };
      },
    });
    await provider.summarizeProposal(request());
    expect(order).toEqual(['guard', 'complete']);
  });
});

describe('governance LLM provider — failure taxonomy (throws; NO output record)', () => {
  it('transport error', async () => {
    h.queue.push(new Error('socket hang up'));
    await expectFailure(h, 'transport');
  });

  it('refusal stop reason', async () => {
    h.queue.push({ stopReason: 'refusal', text: null });
    await expectFailure(h, 'refusal');
  });

  it('truncated output (max_tokens)', async () => {
    h.queue.push({ stopReason: 'max_tokens', text: '{"headline":"x"' });
    await expectFailure(h, 'truncated');
  });

  it('non-JSON output', async () => {
    h.queue.push({ stopReason: 'end_turn', text: 'Sure! Here is your summary: ...' });
    await expectFailure(h, 'invalid_output');
  });

  it('schema-violating output (extra key; strict)', async () => {
    h.queue.push({
      stopReason: 'end_turn',
      text: JSON.stringify({ ...GOOD_DRAFT, vote: 'yes' }),
    });
    await expectFailure(h, 'invalid_output');
  });

  it('quality-gate rejection (ungrounded draft)', async () => {
    h.queue.push({
      stopReason: 'end_turn',
      text: JSON.stringify({
        headline: 'Adopt a weekly digest',
        summary:
          'Members must immediately transfer treasury funds into cryptocurrency ventures for guaranteed returns.',
      }),
    });
    await expectFailure(h, 'quality');
    expect(h.services.metrics.counter('ai.governance.llm.failed.quality')).toBe(1);
  });

  it('never writes an output record on any failure', async () => {
    h.queue.push(new Error('boom'), { stopReason: 'refusal', text: null });
    await expectFailure(h, 'transport');
    h.advance(61_000); // past the breaker cooldown so the probe is allowed
    await expectFailure(h, 'refusal');
    const identity = buildGovernanceLlmIdentity(SETTINGS, BACKEND);
    expect(
      await h.services.outputRecords.listByModel(identity.name, identity.version),
    ).toHaveLength(0);
  });
});

describe('governance LLM provider — breaker + budget bounds (ADR-6)', () => {
  it('opens the breaker after consecutive failures, skips WITHOUT calling the model, then half-opens after the cooldown', async () => {
    h.queue.push(new Error('down'), new Error('still down'));
    await expectFailure(h, 'transport');
    h.advance(30_000); // half the cooldown: the breaker is not yet open (1 failure)
    await expectFailure(h, 'transport'); // second consecutive failure → opens
    const callsSoFar = h.requests.length;
    await expectFailure(h, 'breaker_open');
    expect(h.requests.length).toBe(callsSoFar); // the model was NOT consulted
    expect(h.services.metrics.counter('ai.governance.llm.skipped.breaker_open')).toBe(1);

    h.advance(61_000); // past the cooldown → half-open probe
    const summary = await h.provider.summarizeProposal(request({ roomId: 'room-2' }));
    expect(summary.headline).toBe(GOOD_DRAFT.headline);
    // The success reset the breaker: the next call attempts normally.
    const after = h.requests.length;
    await h.provider.summarizeProposal(request({ roomId: 'room-3' }));
    expect(h.requests.length).toBe(after + 1);
  });

  it('serializes the half-open probe: only ONE call passes per cooldown window (R3-2, no fan-out)', async () => {
    h.queue.push(new Error('down'), new Error('still down'));
    await expectFailure(h, 'transport');
    await expectFailure(h, 'transport'); // second consecutive failure → opens
    h.advance(61_000); // past the cooldown → half-open
    const callsBefore = h.requests.length;
    // Two calls WITHOUT awaiting the first: the first admits the probe and re-arms
    // the cooldown; the second, at the same instant, must be breaker_open — NOT a
    // second concurrent external call (the recovery-window fan-out the fix prevents).
    const first = h.provider.summarizeProposal(request({ roomId: 'room-2' }));
    let secondCode: string | null = null;
    try {
      await h.provider.summarizeProposal(request({ roomId: 'room-3' }));
    } catch (error) {
      secondCode = (error as GovernanceLlmError).code;
    }
    await first;
    expect(secondCode).toBe('breaker_open');
    expect(h.requests.length).toBe(callsBefore + 1); // exactly ONE probe hit the model
  });

  it('enforces the per-room hourly budget (identity-free, per-room key, window expiry)', async () => {
    await h.provider.summarizeProposal(request());
    await h.provider.summarizeProposal(request());
    const callsSoFar = h.requests.length;
    await expectFailure(h, 'budget_exhausted');
    expect(h.requests.length).toBe(callsSoFar); // not consulted
    expect(h.services.metrics.counter('ai.governance.llm.skipped.budget_exhausted')).toBe(1);

    // Another room has its own budget…
    await h.provider.summarizeProposal(request({ roomId: 'room-2' }));
    // …and the window rolls over after an hour.
    h.advance(3_600_001);
    const summary = await h.provider.summarizeProposal(request());
    expect(summary.proposalId).toBe('prop-1');
  });
});

describe('room hub adjudication model (WS-U model candidacy — the summariser rides the adjudication lane)', () => {
  const REF = {
    source: 'huggingface',
    repoId: 'Qwen/Qwen3.6-27B',
    revision: 'c'.repeat(40),
  } as const;

  it('a ratified adjudication selection serves the room summary under ITS identity; the lane never runs', async () => {
    const h = makeHarness();
    const roomRequests: LlmCompletionRequest[] = [];
    const provider = createGovernanceLlmNlProvider({
      services: h.services,
      settings: SETTINGS,
      identity: buildGovernanceLlmIdentity(SETTINGS, BACKEND),
      complete: async (req) => {
        h.requests.push(req);
        return { stopReason: 'end_turn', text: JSON.stringify(GOOD_DRAFT) };
      },
      roomModels: {
        resolveModeration: async () => null,
        resolveAdjudication: async () => ({
          complete: async (req) => {
            roomRequests.push(req);
            return { stopReason: 'end_turn', text: JSON.stringify(GOOD_DRAFT) };
          },
          settings: SETTINGS,
          identity: {
            name: 'governance-summarizer-hub-abcdefabcdef',
            version: '1.0.0',
            useCaseId: 'governance_assistance',
            modalities: ['generation'],
            promptTemplateId: 'governance-summarizer-llm/lawmaking-v1',
            config: { model_id: 'Qwen/Qwen3.6-27B' },
          },
          backendId: 'llm:governance-summarizer-hub-abcdefabcdef',
          format: 'json',
        }),
      },
    });
    const summary = await provider.summarizeProposal(request({ adjudicationRef: REF }));
    expect(summary.proposalId).toBe('prop-1');
    expect(roomRequests).toHaveLength(1); // the ROOM model served it…
    expect(h.requests).toHaveLength(0); // …never the lane
    const records = await h.services.outputRecords.listByModel(
      'governance-summarizer-hub-abcdefabcdef',
      '1.0.0',
    );
    expect(records).toHaveLength(1); // provenance names the ROOM model
  });

  it('an unresolvable selection throws room_model_unavailable (⇒ the deterministic summary), never a lane fallback', async () => {
    const h = makeHarness(); // no roomModels resolver wired
    await expect(
      h.provider.summarizeProposal(request({ adjudicationRef: REF })),
    ).rejects.toMatchObject({ name: 'GovernanceLlmError', code: 'room_model_unavailable' });
    expect(h.requests).toHaveLength(0); // the lane completion was never consulted
  });
});

describe('createAnthropicCompletion — the SDK logs through pino or not at all', () => {
  // Left unconfigured, @anthropic-ai/sdk sinks to the global `console` and
  // promotes its own level from ANTHROPIC_LOG; at `debug` it prints the
  // outbound request BODY — the governed room content this module promises is
  // never logged, on a path pino's redaction never sees.
  const ROOM_CONTENT = 'CONFIDENTIAL-ROOM-PROPOSAL-TEXT';

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('emits nothing to console — and nothing at all — with ANTHROPIC_LOG=debug set', async () => {
    vi.stubEnv('ANTHROPIC_LOG', 'debug');
    const consoleCalls: unknown[][] = [];
    for (const method of ['debug', 'info', 'log', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleCalls.push(args);
      });
    }
    // The SDK captures the global fetch at construction time.
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            model: DEFAULT_GOVERNANCE_LLM_SETTINGS.modelId,
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    const events: Array<{ event: string; meta: Record<string, unknown> }> = [];
    const complete = createAnthropicCompletion(
      'sk-ant-test-key',
      DEFAULT_GOVERNANCE_LLM_SETTINGS,
      (event, meta) => events.push({ event, meta }),
    );
    const result = await complete({
      system: 'system prompt',
      user: ROOM_CONTENT,
      maxOutputTokens: 256,
    });
    expect(result).toEqual({ stopReason: 'end_turn', text: 'ok' });

    // Nothing reached console…
    expect(consoleCalls).toEqual([]);
    // …and the pinned `warn` level meant nothing reached the pino hook either,
    // so the request body has no route to ANY sink at debug.
    expect(events).toEqual([]);
  });
});
