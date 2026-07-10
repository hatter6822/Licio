// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The SAME-HOST local completion (WS-U ADR-9 'local' backend): one OpenAI-
// compatible /chat/completions adapter covers llama.cpp server, Ollama, vLLM,
// and LM Studio. The wire shape is pinned here (model, max_tokens, temperature
// 0, layered messages, json_schema response_format), finish reasons map onto
// the provider's stop-reason vocabulary, and every malformed/failed response
// throws — which the governed provider turns into a deterministic fallback.
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GOVERNANCE_LLM_SETTINGS } from '../ai-governance/llm/config.js';
import {
  createLocalCompletion,
  type FetchLike,
  localChatCompletionsUrl,
} from '../ai-governance/llm/local.js';
import {
  createGovernanceLlmNlProvider,
  LLM_SUMMARY_JSON_SCHEMA,
} from '../ai-governance/llm/provider.js';
import { buildGovernanceLlmIdentity } from '../ai-governance/llm/registration.js';
import {
  type AiGovernanceServices,
  createInMemoryAiGovernanceServices,
} from '../ai-governance/services.js';
import { createInMemoryEventPipelineServices } from '../events/services.js';

const SETTINGS = { ...DEFAULT_GOVERNANCE_LLM_SETTINGS, modelId: 'llama3.3:70b' };
const BASE_URL = 'http://127.0.0.1:11434/v1';

const REQUEST = {
  system: 'system prompt',
  user: 'user prompt',
  maxOutputTokens: 512,
  jsonSchema: LLM_SUMMARY_JSON_SCHEMA,
};

interface FetchCall {
  url: string;
  init: Parameters<FetchLike>[1];
}

function fakeFetch(status: number, body: unknown): { fetch: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      };
    },
  };
}

function okBody(content: string | null, finishReason: string | null = 'stop'): unknown {
  return { choices: [{ message: { content }, finish_reason: finishReason }] };
}

describe('localChatCompletionsUrl', () => {
  it('joins the operator base URL, tolerating trailing slashes', () => {
    expect(localChatCompletionsUrl(BASE_URL)).toBe(`${BASE_URL}/chat/completions`);
    expect(localChatCompletionsUrl(`${BASE_URL}//`)).toBe(`${BASE_URL}/chat/completions`);
    expect(localChatCompletionsUrl('http://localhost:8080/v1/')).toBe(
      'http://localhost:8080/v1/chat/completions',
    );
  });
});

describe('createLocalCompletion (OpenAI-compatible wire shape)', () => {
  it('POSTs the pinned request shape with the JSON-schema response format', async () => {
    const { fetch, calls } = fakeFetch(200, okBody('{"headline":"h","summary":"s"}'));
    const complete = createLocalCompletion(BASE_URL, SETTINGS, fetch);
    const result = await complete(REQUEST);

    expect(result).toEqual({ stopReason: 'end_turn', text: '{"headline":"h","summary":"s"}' });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) return;
    expect(call.url).toBe(`${BASE_URL}/chat/completions`);
    expect(call.init.method).toBe('POST');
    expect(call.init.headers['content-type']).toBe('application/json');
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    // Loopback egress guarantee (R3-1): a redirect must fail, never be followed.
    expect(call.init.redirect).toBe('error');

    const payload = JSON.parse(call.init.body) as Record<string, unknown>;
    expect(payload['model']).toBe('llama3.3:70b');
    expect(payload['max_tokens']).toBe(512);
    expect(payload['temperature']).toBe(0);
    expect(payload['messages']).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user prompt' },
    ]);
    expect(payload['response_format']).toEqual({
      type: 'json_schema',
      json_schema: { name: 'lawmaking_summary', strict: true, schema: LLM_SUMMARY_JSON_SCHEMA },
    });
  });

  it('maps OpenAI-compatible finish reasons onto the provider vocabulary', async () => {
    const cases: Array<[string | null, string | null]> = [
      ['stop', 'end_turn'],
      ['length', 'max_tokens'],
      ['content_filter', 'refusal'],
      [null, null],
      ['tool_calls', 'tool_calls'], // unknown reasons pass through untouched
    ];
    for (const [finishReason, expected] of cases) {
      const { fetch } = fakeFetch(200, okBody('x', finishReason));
      const complete = createLocalCompletion(BASE_URL, SETTINGS, fetch);
      expect((await complete(REQUEST)).stopReason).toBe(expected);
    }
  });

  it('throws on a non-2xx response (→ deterministic fallback upstream)', async () => {
    const { fetch } = fakeFetch(500, { error: 'boom' });
    const complete = createLocalCompletion(BASE_URL, SETTINGS, fetch);
    await expect(complete(REQUEST)).rejects.toThrow('local inference server responded 500');
  });

  it('throws on a malformed response body (zod at the trust boundary)', async () => {
    for (const body of [{}, { choices: [] }, { choices: [{ message: {} }] }, 'nope']) {
      const { fetch } = fakeFetch(200, body);
      const complete = createLocalCompletion(BASE_URL, SETTINGS, fetch);
      await expect(complete(REQUEST)).rejects.toThrow();
    }
  });
});

describe('local backend through the governed provider (end to end, no network)', () => {
  let services: AiGovernanceServices;
  beforeEach(() => {
    const NOW = () => Date.parse('2026-07-01T00:00:00.000Z');
    const events = createInMemoryEventPipelineServices({ now: NOW });
    services = createInMemoryAiGovernanceServices(events, { now: NOW });
  });

  it('serves a gated local draft and records it under the local identity', async () => {
    const draft = {
      headline: 'Adopt a weekly digest',
      summary:
        'Create an opt-in weekly digest email that collects the room highlights every Friday. Yes. No.',
    };
    const { fetch } = fakeFetch(200, okBody(JSON.stringify(draft)));
    const backend = { kind: 'local', baseUrl: BASE_URL } as const;
    const identity = buildGovernanceLlmIdentity(SETTINGS, backend);
    const provider = createGovernanceLlmNlProvider({
      services,
      settings: SETTINGS,
      identity,
      complete: createLocalCompletion(BASE_URL, SETTINGS, fetch),
    });

    const summary = await provider.summarizeProposal({
      roomId: 'room-local',
      proposal: {
        proposalId: 'prop-local-1',
        title: 'Adopt a weekly digest',
        body: 'Create an opt-in weekly digest email that collects the room highlights every Friday.',
        options: ['Yes', 'No'],
      },
      roomPromptText: null,
      promptTemplate: null,
      summaryStyle: 'neutral_brief',
    });

    expect(summary.headline).toBe(draft.headline);
    const records = await services.outputRecords.listByModel(identity.name, identity.version);
    expect(records).toHaveLength(1);
    expect(records[0]?.model_name).toBe(identity.name);
    expect(identity.name).toMatch(/^governance-summarizer-llm-local-[0-9a-f]{12}$/);
  });
});

describe('reasoning_effort (the gpt-oss latency lever)', () => {
  const OK_BODY = {
    choices: [{ message: { content: '{"headline":"h","summary":"s"}' }, finish_reason: 'stop' }],
  };

  it('is sent when the settings carry it and omitted when null', async () => {
    const withEffort = fakeFetch(200, OK_BODY);
    await createLocalCompletion(
      BASE_URL,
      { ...SETTINGS, reasoningEffort: 'low' },
      withEffort.fetch,
    )(REQUEST);
    const effortCall = withEffort.calls[0];
    if (!effortCall) throw new Error('no call recorded');
    const sent = JSON.parse(effortCall.init.body) as Record<string, unknown>;
    expect(sent['reasoning_effort']).toBe('low');

    const without = fakeFetch(200, OK_BODY);
    await createLocalCompletion(
      BASE_URL,
      { ...SETTINGS, reasoningEffort: null },
      without.fetch,
    )(REQUEST);
    const bareCall = without.calls[0];
    if (!bareCall) throw new Error('no call recorded');
    const bare = JSON.parse(bareCall.init.body) as Record<string, unknown>;
    expect('reasoning_effort' in bare).toBe(false);
  });

  it('is folded into the registry identity config (a changed effort re-clears the gate)', () => {
    const backend = { kind: 'local', baseUrl: BASE_URL } as const;
    const low = buildGovernanceLlmIdentity({ ...SETTINGS, reasoningEffort: 'low' }, backend);
    const high = buildGovernanceLlmIdentity({ ...SETTINGS, reasoningEffort: 'high' }, backend);
    const none = buildGovernanceLlmIdentity({ ...SETTINGS, reasoningEffort: null }, backend);
    expect(low.config['reasoning_effort']).toBe('low');
    expect('reasoning_effort' in none.config).toBe(false);
    const names = new Set([low.name, high.name, none.name]);
    expect(names.size).toBe(3); // three distinct decision surfaces, three identities
  });
});

describe('per-runtime parameter negotiation (the effort latches)', () => {
  const OK = {
    choices: [{ message: { content: '{"headline":"h","summary":"s"}' }, finish_reason: 'stop' }],
  };
  const EXHAUSTED = {
    choices: [{ message: { content: '' }, finish_reason: 'length' }],
  };

  function scriptedFetch(script: Array<{ status: number; body: unknown }>) {
    const calls: FetchCall[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      const step = script.shift() ?? { status: 200, body: OK };
      return { ok: step.status < 400, status: step.status, json: async () => step.body };
    };
    return { calls, fetchImpl };
  }

  function effortOf(call: FetchCall | undefined): unknown {
    if (!call) return 'NO CALL';
    return (JSON.parse(call.init.body) as Record<string, unknown>)['reasoning_effort'];
  }

  it('a 400-rejected reasoning_effort is retried without the field and LATCHED', async () => {
    const { calls, fetchImpl } = scriptedFetch([{ status: 400, body: {} }]);
    const complete = createLocalCompletion(
      BASE_URL,
      { ...SETTINGS, reasoningEffort: 'low' },
      fetchImpl,
    );
    const result = await complete(REQUEST);
    expect(result.text).toBe('{"headline":"h","summary":"s"}');
    expect(calls).toHaveLength(2);
    expect(effortOf(calls[0])).toBe('low');
    expect(effortOf(calls[1])).toBeUndefined(); // dropped on the retry…
    await complete(REQUEST);
    expect(effortOf(calls[2])).toBeUndefined(); // …and latched for later calls
  });

  it('a thinking-exhausted response (length + empty) retries once at `none` and LATCHES', async () => {
    const { calls, fetchImpl } = scriptedFetch([{ status: 200, body: EXHAUSTED }]);
    const complete = createLocalCompletion(
      BASE_URL,
      { ...SETTINGS, reasoningEffort: 'low' },
      fetchImpl,
    );
    const result = await complete(REQUEST);
    expect(result.stopReason).toBe('end_turn');
    expect(calls).toHaveLength(2);
    expect(effortOf(calls[0])).toBe('low');
    expect(effortOf(calls[1])).toBe('none'); // thinking disabled on the retry…
    await complete(REQUEST);
    expect(effortOf(calls[2])).toBe('none'); // …and latched
  });

  it('an explicit operator `off` (null) is honoured strictly — no auto-`none` retry', async () => {
    const { calls, fetchImpl } = scriptedFetch([{ status: 200, body: EXHAUSTED }]);
    const complete = createLocalCompletion(
      BASE_URL,
      { ...SETTINGS, reasoningEffort: null },
      fetchImpl,
    );
    const result = await complete(REQUEST);
    expect(result.stopReason).toBe('max_tokens'); // the honest truncated failure
    expect(calls).toHaveLength(1);
    expect(effortOf(calls[0])).toBeUndefined();
  });

  it('a second 400 after the drop is a real transport failure (no retry loop)', async () => {
    const { calls, fetchImpl } = scriptedFetch([
      { status: 400, body: {} },
      { status: 400, body: {} },
    ]);
    const complete = createLocalCompletion(
      BASE_URL,
      { ...SETTINGS, reasoningEffort: 'low' },
      fetchImpl,
    );
    await expect(complete(REQUEST)).rejects.toThrow(/responded 400/);
    expect(calls).toHaveLength(2);
  });
});
