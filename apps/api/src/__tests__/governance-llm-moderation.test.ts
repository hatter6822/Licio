// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The governed LLM in-room moderation proposer (WS-U ADR-9). Covers the review
// hardening: (F3) FAIL CLOSED when the immutable AIOutputRecord cannot be written
// — never return an unrecorded, audit-sensitive decision — and (F1) ISOLATE the
// admission probes (roomId = ADMISSION_ROOM_ID) from the live circuit breaker +
// per-room budget, so a bad candidate prompt failing admission cannot degrade
// live moderation for unrelated rooms.
import type { ModerationContext } from '@licio/governance';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GOVERNANCE_LLM_SETTINGS } from '../ai-governance/llm/config.js';
import { createGovernanceLlmModerationProposer } from '../ai-governance/llm/moderation.js';
import type { LlmCompletionRequest, LlmCompletionResult } from '../ai-governance/llm/provider.js';
import { buildGovernanceModerationProposerIdentity } from '../ai-governance/llm/registration.js';
import {
  type AiGovernanceServices,
  createInMemoryAiGovernanceServices,
} from '../ai-governance/services.js';
import { createInMemoryEventPipelineServices } from '../events/services.js';
import type { ModerationProposer } from '../governance/moderation-proposer.js';
import { ADMISSION_ROOM_ID } from '../governance/service.js';

const SETTINGS = {
  ...DEFAULT_GOVERNANCE_LLM_SETTINGS,
  maxModerationCallsPerRoomPerHour: 3,
  breakerFailureThreshold: 2,
  breakerCooldownSeconds: 60,
};
const BACKEND = { kind: 'anthropic', apiKey: 'sk-ant-test-key' } as const;
const DECISION = { action: 'flag_for_review', reason: 'links' };

function ctx(over: Partial<ModerationContext> = {}): ModerationContext {
  return {
    contentText: 'hi',
    contentKind: 'comment',
    contentLength: 2,
    linkCount: 0,
    mentionCount: 0,
    hasMediaUpload: false,
    authorAccountAgeDays: 100,
    authorNewToRoom: false,
    priorRemovalsInRoom: 0,
    ...over,
  };
}
function req(roomId: string, subjectRef: string) {
  return { roomId, subjectRef, context: ctx(), moderationPrompt: null };
}

interface Harness {
  services: AiGovernanceServices;
  proposer: ModerationProposer;
  requests: LlmCompletionRequest[];
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
  const proposer = createGovernanceLlmModerationProposer({
    services,
    settings: SETTINGS,
    identity: buildGovernanceModerationProposerIdentity(SETTINGS, BACKEND),
    complete: async (request) => {
      requests.push(request);
      const next = queue.shift() ?? { stopReason: 'end_turn', text: JSON.stringify(DECISION) };
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return {
    services,
    proposer,
    requests,
    queue,
    advance: (ms) => {
      nowMs += ms;
    },
  };
}

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});

describe('governance LLM moderation proposer — governed decision + backendId', () => {
  it('classifies, records an immutable AIOutputRecord, and pins a stable backendId', async () => {
    const result = await h.proposer.propose(req('room-1', 'c1'));
    expect(result.status).toBe('decided');
    if (result.status === 'decided') {
      expect(result.proposal.action).toBe('flag_for_review');
      expect(result.proposal.outputId).not.toBeNull();
    }
    // backendId pins the admission to this backend + config (F4); the identity name
    // folds in a config hash, so it changes whenever the model/prompt/URL changes.
    expect(h.proposer.backendId).toMatch(/^llm:governance-moderation-llm-anthropic-[0-9a-f]{12}$/);
  });
});

describe('F3 — fail closed when moderation provenance cannot be recorded', () => {
  it('returns unavailable(record_failed) on an output-record store fault (never an unrecorded decision)', async () => {
    // The model classifies fine, but the immutable AIOutputRecord write throws.
    h.services.outputRecords.put = async () => {
      throw new Error('output-record store down');
    };
    const result = await h.proposer.propose(req('room-1', 'c1'));
    expect(result).toEqual({ status: 'unavailable', code: 'record_failed' });
    expect(h.services.metrics.counter('ai.governance.moderation.record_failed')).toBe(1);
  });
});

describe('F1 — admission probes are isolated from the live breaker + budget', () => {
  it('a failing admission probe does NOT trip the live breaker', async () => {
    // Enough failures to exceed breakerFailureThreshold — but from ADMISSION probes.
    h.queue.push(new Error('down'), new Error('down'), new Error('down'));
    for (let i = 0; i < 3; i += 1) {
      const r = await h.proposer.propose(req(ADMISSION_ROOM_ID, `f:${i}`));
      expect(r.status).toBe('unavailable'); // the probe itself failed…
    }
    // …but the breaker never opened: a LIVE call still reaches the model (decides),
    // rather than returning breaker_open. (Without the isolation, 2 admission
    // failures would have opened the shared, process-wide breaker.)
    const live = await h.proposer.propose(req('room-1', 'c1'));
    expect(live.status).toBe('decided');
  });

  it('admission probes bypass the per-room budget (many probes never exhaust it)', async () => {
    // maxModerationCallsPerRoomPerHour is small; without the bypass the (N+1)th
    // admission probe would return budget_exhausted and spuriously fail admission.
    for (let i = 0; i < SETTINGS.maxModerationCallsPerRoomPerHour + 2; i += 1) {
      const r = await h.proposer.propose(req(ADMISSION_ROOM_ID, `p:${i}`));
      expect(r.status).toBe('decided'); // never budget_exhausted
    }
  });

  it('live moderation STILL honours the breaker (isolation is admission-only)', async () => {
    // Two consecutive LIVE failures open the breaker; the third live call is skipped.
    h.queue.push(new Error('down'), new Error('down'));
    expect((await h.proposer.propose(req('room-1', 'c1'))).status).toBe('unavailable');
    expect((await h.proposer.propose(req('room-1', 'c2'))).status).toBe('unavailable');
    const callsBefore = h.requests.length;
    const skipped = await h.proposer.propose(req('room-1', 'c3'));
    expect(skipped).toEqual({ status: 'unavailable', code: 'breaker_open' });
    expect(h.requests.length).toBe(callsBefore); // the model was NOT consulted
  });
});

describe('provenance-write failures count toward the breaker (parity with the debate leg)', () => {
  it('repeated record_failed opens the breaker instead of re-spending completions forever', async () => {
    // Threshold 2 via the shared SETTINGS (breakerFailureThreshold: 2).
    h.services.outputRecords.put = async () => {
      throw new Error('output-record store down');
    };
    expect(await h.proposer.propose(req('room-1', 'c1'))).toEqual({
      status: 'unavailable',
      code: 'record_failed',
    });
    expect(await h.proposer.propose(req('room-1', 'c2'))).toEqual({
      status: 'unavailable',
      code: 'record_failed',
    });
    // Breaker open: the third call never reaches the completion.
    expect(await h.proposer.propose(req('room-1', 'c3'))).toEqual({
      status: 'unavailable',
      code: 'breaker_open',
    });
    expect(h.requests).toHaveLength(2);
  });
});
