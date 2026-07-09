// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The governed SHADOW moderation advisor (WS-U ADR-9 slice 2): a governed LLM
// classifies a contribution SCORE-BLIND (it never sees the DSL decision) and
// records the divergence. It carries no authority: the record is observability.
// Every invocation runs the full governed path (guard → completion → zod →
// AIOutputRecord + shadow record), bounded by the per-room budget + breaker, and
// swallows every failure (fire-and-forget contract — never throws to the caller).
import type { AiInvocation } from '@licio/ai-governance';
import type { ModerationContext } from '@licio/governance';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProhibitedUseGuard } from '../ai-governance/guard.js';
import {
  createGovernanceModerationShadowAdvisor,
  MODERATION_ADVISOR_JSON_SCHEMA,
} from '../ai-governance/llm/advisor.js';
import { DEFAULT_GOVERNANCE_LLM_SETTINGS } from '../ai-governance/llm/config.js';
import type { LlmCompletionRequest, LlmCompletionResult } from '../ai-governance/llm/provider.js';
import { buildGovernanceModerationAdvisorIdentity } from '../ai-governance/llm/registration.js';
import {
  type AiGovernanceServices,
  createInMemoryAiGovernanceServices,
} from '../ai-governance/services.js';
import { createInMemoryEventPipelineServices } from '../events/services.js';
import type { ModerationShadowAdvisor } from '../governance/moderation-shadow.js';

const SETTINGS = {
  ...DEFAULT_GOVERNANCE_LLM_SETTINGS,
  maxModerationCallsPerRoomPerHour: 2,
  breakerFailureThreshold: 2,
  breakerCooldownSeconds: 60,
};
const BACKEND = { kind: 'local', baseUrl: 'http://127.0.0.1:11434/v1' } as const;

function context(over: Partial<ModerationContext> = {}): ModerationContext {
  return {
    contentText: 'A borderline comment that mentions a link.',
    contentKind: 'comment',
    contentLength: 42,
    linkCount: 1,
    mentionCount: 0,
    hasMediaUpload: false,
    authorAccountAgeDays: 30,
    authorNewToRoom: false,
    priorRemovalsInRoom: 0,
    ...over,
  };
}

function verdict(action: string, reason = 'because'): LlmCompletionResult {
  return { stopReason: 'end_turn', text: JSON.stringify({ action, reason }) };
}

interface Harness {
  services: AiGovernanceServices;
  advisor: ModerationShadowAdvisor;
  requests: LlmCompletionRequest[];
  queue: Array<LlmCompletionResult | Error>;
  advance: (ms: number) => void;
}

function makeHarness(): Harness {
  let nowMs = Date.parse('2026-07-09T00:00:00.000Z');
  const NOW = () => nowMs;
  const events = createInMemoryEventPipelineServices({ now: NOW });
  const services = createInMemoryAiGovernanceServices(events, { now: NOW });
  const requests: LlmCompletionRequest[] = [];
  const queue: Array<LlmCompletionResult | Error> = [];
  const advisor = createGovernanceModerationShadowAdvisor({
    services,
    settings: SETTINGS,
    identity: buildGovernanceModerationAdvisorIdentity(SETTINGS, BACKEND),
    complete: async (req) => {
      requests.push(req);
      const next = queue.shift() ?? verdict('allow');
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { services, advisor, requests, queue, advance: (ms) => (nowMs += ms) };
}

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});

describe('shadow moderation advisor — governed path + divergence', () => {
  it('records a divergence row + an immutable AIOutputRecord when the advisor AGREES', async () => {
    h.queue.push(verdict('remove', 'spam'));
    await h.advisor.recordShadow({
      roomId: 'room-1',
      subjectRef: 'contrib-1',
      context: context(),
      roomPromptText: 'Be courteous.',
      dslAction: 'remove',
    });

    const records = await h.services.shadowModeration.listByRoom('room-1', 10);
    expect(records).toHaveLength(1);
    const rec = records[0];
    expect(rec?.dslAction).toBe('remove');
    expect(rec?.advisorAction).toBe('remove');
    expect(rec?.agreed).toBe(true);
    expect(rec?.severityDelta).toBe(0);
    expect(rec?.advisorReason).toBe('spam');
    expect(rec?.modelName).toBe('governance-moderation-advisor-llm-local');
    expect(rec?.outputId).toMatch(/^out:/);

    const outputs = await h.services.outputRecords.listByModel(
      'governance-moderation-advisor-llm-local',
      '1.0.0',
    );
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.use_case_id).toBe('toxicity_safety_triage');
    expect(outputs[0]?.output_id).toBe(rec?.outputId);

    expect(h.services.metrics.counter('ai.governance.shadow.compared')).toBe(1);
    expect(h.services.metrics.counter('ai.governance.shadow.agreed')).toBe(1);
  });

  it('classifies SCORE-BLIND: the prompt is byte-identical regardless of the DSL action', async () => {
    h.queue.push(verdict('allow'), verdict('allow'));
    const base = {
      roomId: 'room-blind',
      subjectRef: 'c',
      context: context(),
      roomPromptText: 'norms',
    };
    await h.advisor.recordShadow({ ...base, dslAction: 'allow' });
    await h.advisor.recordShadow({ ...base, dslAction: 'remove' });
    expect(h.requests).toHaveLength(2);
    // The two requests are byte-identical: the DSL action is never placed in the
    // prompt, so the model cannot be anchored by it (score-blind, by construction).
    expect(h.requests[0]).toEqual(h.requests[1]);
    expect(h.requests[0]?.jsonSchema).toBe(MODERATION_ADVISOR_JSON_SCHEMA);
    // The content is DATA in the user turn; the DSL decision appears nowhere.
    expect(h.requests[0]?.user).toContain('<contribution>');
    expect(h.requests[0]?.user).toContain('A borderline comment');
  });

  it('records advisor-MORE-severe and advisor-LESS-severe divergences with the right sign', async () => {
    h.queue.push(verdict('remove')); // advisor stricter than an allow DSL
    await h.advisor.recordShadow({
      roomId: 'room-2',
      subjectRef: 'c1',
      context: context(),
      roomPromptText: null,
      dslAction: 'allow',
    });
    h.queue.push(verdict('allow')); // advisor more lenient than a remove DSL
    await h.advisor.recordShadow({
      roomId: 'room-2',
      subjectRef: 'c2',
      context: context(),
      roomPromptText: null,
      dslAction: 'remove',
    });

    const summary = await h.services.shadowModeration.summaryByRoom('room-2');
    expect(summary).toEqual({ total: 2, agreed: 0, advisorMoreSevere: 1, advisorLessSevere: 1 });
    expect(h.services.metrics.counter('ai.governance.shadow.advisor_more_severe')).toBe(1);
    expect(h.services.metrics.counter('ai.governance.shadow.advisor_less_severe')).toBe(1);
    expect(h.services.metrics.counter('ai.governance.shadow.agreed')).toBe(0);
  });

  it('runs the prohibited-use guard BEFORE the model; a block skips WITHOUT recording or tripping the breaker', async () => {
    class BlockingGuard extends ProhibitedUseGuard {
      override async enforce(_invocation: AiInvocation): Promise<void> {
        throw new Error('blocked');
      }
    }
    const services = h.services;
    services.guard = new BlockingGuard({
      blocked: services.blocked,
      metrics: services.metrics,
      log: services.log,
      now: services.now,
    });
    const advisor = createGovernanceModerationShadowAdvisor({
      services,
      settings: SETTINGS,
      identity: buildGovernanceModerationAdvisorIdentity(SETTINGS, BACKEND),
      complete: async (req) => {
        h.requests.push(req);
        return verdict('allow');
      },
    });
    await advisor.recordShadow({
      roomId: 'room-guard',
      subjectRef: 'c',
      context: context(),
      roomPromptText: null,
      dslAction: 'allow',
    });
    expect(h.requests).toHaveLength(0); // the model was never called
    expect(await services.shadowModeration.listByRoom('room-guard', 10)).toHaveLength(0);
    expect(services.metrics.counter('ai.governance.shadow.skipped.guard_block')).toBe(1);
  });
});

describe('shadow moderation advisor — failure handling (never throws; no record)', () => {
  async function expectNoRecord(room: string): Promise<void> {
    await h.advisor.recordShadow({
      roomId: room,
      subjectRef: 'c',
      context: context(),
      roomPromptText: null,
      dslAction: 'allow',
    });
    expect(await h.services.shadowModeration.listByRoom(room, 10)).toHaveLength(0);
  }

  it('swallows transport / refusal / truncation / malformed output (no throw, no record)', async () => {
    h.queue.push(new Error('socket'));
    await expectNoRecord('r-transport');
    h.advance(61_000); // clear breaker between cases
    h.queue.push({ stopReason: 'refusal', text: null });
    await expectNoRecord('r-refusal');
    h.advance(61_000);
    h.queue.push({ stopReason: 'max_tokens', text: '{"action":"remove"' });
    await expectNoRecord('r-trunc');
    h.advance(61_000);
    h.queue.push({ stopReason: 'end_turn', text: 'not json' });
    await expectNoRecord('r-json');
    h.advance(61_000);
    h.queue.push({ stopReason: 'end_turn', text: JSON.stringify({ action: 'nuke', reason: 'x' }) });
    await expectNoRecord('r-badaction');

    expect(
      await h.services.outputRecords.listByModel(
        'governance-moderation-advisor-llm-local',
        '1.0.0',
      ),
    ).toHaveLength(0);
    expect(h.services.metrics.counter('ai.governance.shadow.failed.transport')).toBe(1);
    expect(h.services.metrics.counter('ai.governance.shadow.failed.refusal')).toBe(1);
    expect(h.services.metrics.counter('ai.governance.shadow.failed.invalid_output')).toBe(2);
  });

  it('opens the breaker after consecutive failures and skips WITHOUT calling the model', async () => {
    h.queue.push(new Error('down'), new Error('down'));
    await expectNoRecord('r-b1'); // failure 1
    await expectNoRecord('r-b2'); // failure 2 → breaker opens
    const callsSoFar = h.requests.length;
    await expectNoRecord('r-b3'); // breaker open → not called
    expect(h.requests.length).toBe(callsSoFar);
    expect(h.services.metrics.counter('ai.governance.shadow.skipped.breaker_open')).toBe(1);
  });

  it('enforces the per-room hourly budget (identity-free, per-room, window expiry)', async () => {
    // budget = 2/room/hour
    h.queue.push(verdict('allow'), verdict('allow'));
    await h.advisor.recordShadow({
      roomId: 'r-bud',
      subjectRef: 'a',
      context: context(),
      roomPromptText: null,
      dslAction: 'allow',
    });
    await h.advisor.recordShadow({
      roomId: 'r-bud',
      subjectRef: 'b',
      context: context(),
      roomPromptText: null,
      dslAction: 'allow',
    });
    const calls = h.requests.length;
    await h.advisor.recordShadow({
      roomId: 'r-bud',
      subjectRef: 'c',
      context: context(),
      roomPromptText: null,
      dslAction: 'allow',
    });
    expect(h.requests.length).toBe(calls); // budget exhausted → not called
    expect(await h.services.shadowModeration.listByRoom('r-bud', 10)).toHaveLength(2);
    expect(h.services.metrics.counter('ai.governance.shadow.skipped.budget_exhausted')).toBe(1);
    // Another room has its own budget.
    h.queue.push(verdict('allow'));
    await h.advisor.recordShadow({
      roomId: 'r-bud2',
      subjectRef: 'a',
      context: context(),
      roomPromptText: null,
      dslAction: 'allow',
    });
    expect(await h.services.shadowModeration.listByRoom('r-bud2', 10)).toHaveLength(1);
  });
});
