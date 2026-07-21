// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U ADR-9 fail-closed enablement matrix for the LLM-backed governance
// surfaces (the role-split revision): an explicit 'anthropic'/'local' opts in;
// PRODUCTION defaults an UNSET provider to 'local' with the TWO reviewed lane
// defaults (moderation = the Qwen3Guard safety classifier on :8001,
// adjudication = the Qwen3.6 generalist on :8002); the legacy single-lane keys
// apply to BOTH lanes; 'deterministic' opts out explicitly; every invalid
// combination resolves to the deterministic default (no silent enablement, no
// silent egress — every lane + extra URL is loopback-enforced).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GOVERNANCE_LLM_ADJUDICATION_MODEL_ID,
  DEFAULT_GOVERNANCE_LLM_ADJUDICATION_URL,
  DEFAULT_GOVERNANCE_LLM_MODERATION_MODEL_ID,
  DEFAULT_GOVERNANCE_LLM_MODERATION_URL,
  DEFAULT_GOVERNANCE_LLM_SETTINGS,
  resolveGovernanceLlmDecision,
} from '../ai-governance/llm/config.js';

const KEY = 'sk-ant-test-key';
const LOCAL_URL = 'http://127.0.0.1:11434/v1';

describe('resolveGovernanceLlmDecision (fail-closed)', () => {
  it('is disabled when no backend is requested (the non-production default posture)', () => {
    for (const provider of [undefined, '', 'deterministic', 'openai', 'ANTHROPIC', 'LOCAL']) {
      const decision = resolveGovernanceLlmDecision({
        provider,
        apiKey: KEY,
        localBaseUrl: LOCAL_URL,
        modelId: 'llama3.3',
      });
      expect(decision).toEqual({ enabled: false, reason: 'not_requested' });
    }
    // Explicit in every environment: 'deterministic' opts out of the
    // production default too, and an explicit INVALID value never defaults.
    for (const provider of ['deterministic', 'openai', '']) {
      expect(
        resolveGovernanceLlmDecision({ provider, apiKey: undefined, nodeEnv: 'production' }),
      ).toEqual({ enabled: false, reason: 'not_requested' });
    }
  });

  it('PRODUCTION defaults an unset provider to the local backend with the TWO reviewed lane defaults (the production-complete posture)', () => {
    const decision = resolveGovernanceLlmDecision({
      provider: undefined,
      apiKey: undefined,
      nodeEnv: 'production',
    });
    expect(decision.enabled).toBe(true);
    if (decision.enabled) {
      expect(decision.lanes.moderation.backend).toEqual({
        kind: 'local',
        baseUrl: DEFAULT_GOVERNANCE_LLM_MODERATION_URL,
      });
      expect(decision.lanes.moderation.settings.modelId).toBe(
        DEFAULT_GOVERNANCE_LLM_MODERATION_MODEL_ID,
      );
      expect(decision.lanes.adjudication.backend).toEqual({
        kind: 'local',
        baseUrl: DEFAULT_GOVERNANCE_LLM_ADJUDICATION_URL,
      });
      expect(decision.lanes.adjudication.settings.modelId).toBe(
        DEFAULT_GOVERNANCE_LLM_ADJUDICATION_MODEL_ID,
      );
      // The moderation default is a guard model ⇒ the guard-native dialect.
      expect(decision.moderationFormat).toBe('qwen3guard');
      // Both lane URLs are probeable by the room-model resolver.
      expect(decision.runtimeUrls).toEqual([
        DEFAULT_GOVERNANCE_LLM_MODERATION_URL,
        DEFAULT_GOVERNANCE_LLM_ADJUDICATION_URL,
      ]);
      expect(decision.providerDefaulted).toBe(true);
      // All three governed surfaces default on.
      expect(decision.llmModeration).toBe(true);
      expect(decision.llmDebate).toBe(true);
    }
    // Non-production never silently defaults (dev wires the simulator at boot).
    for (const nodeEnv of [undefined, 'development', 'test']) {
      expect(
        resolveGovernanceLlmDecision({ provider: undefined, apiKey: undefined, nodeEnv }),
      ).toEqual({ enabled: false, reason: 'not_requested' });
    }
  });

  it('the LEGACY single-lane keys apply to BOTH lanes (the single-runtime posture)', () => {
    const decision = resolveGovernanceLlmDecision({
      provider: 'local',
      apiKey: undefined,
      modelId: 'qwen3:14b',
      localBaseUrl: LOCAL_URL,
    });
    expect(decision.enabled).toBe(true);
    if (decision.enabled) {
      expect(decision.lanes.moderation.backend).toEqual({ kind: 'local', baseUrl: LOCAL_URL });
      expect(decision.lanes.adjudication.backend).toEqual({ kind: 'local', baseUrl: LOCAL_URL });
      expect(decision.lanes.moderation.settings.modelId).toBe('qwen3:14b');
      expect(decision.lanes.adjudication.settings.modelId).toBe('qwen3:14b');
      // One shared URL ⇒ one deduplicated runtime entry.
      expect(decision.runtimeUrls).toEqual([LOCAL_URL]);
      // A generalist single model ⇒ the strict-JSON dialect.
      expect(decision.moderationFormat).toBe('json');
    }
  });

  it('per-lane keys override the legacy keys lane-by-lane', () => {
    const decision = resolveGovernanceLlmDecision({
      provider: 'local',
      apiKey: undefined,
      modelId: 'qwen3:14b',
      localBaseUrl: LOCAL_URL,
      moderationModelId: 'Qwen/Qwen3Guard-Gen-8B',
      moderationUrl: 'http://127.0.0.1:9001/v1',
    });
    expect(decision.enabled).toBe(true);
    if (decision.enabled) {
      expect(decision.lanes.moderation.settings.modelId).toBe('Qwen/Qwen3Guard-Gen-8B');
      expect(decision.lanes.moderation.backend).toEqual({
        kind: 'local',
        baseUrl: 'http://127.0.0.1:9001/v1',
      });
      // The adjudication lane still follows the legacy keys.
      expect(decision.lanes.adjudication.settings.modelId).toBe('qwen3:14b');
      expect(decision.lanes.adjudication.backend).toEqual({ kind: 'local', baseUrl: LOCAL_URL });
      // A guard-family override auto-detects the guard dialect.
      expect(decision.moderationFormat).toBe('qwen3guard');
      expect(decision.runtimeUrls).toEqual(['http://127.0.0.1:9001/v1', LOCAL_URL]);
    }
  });

  it('the moderation format override wins over auto-detection; garbage auto-detects', () => {
    const base = {
      provider: 'local',
      apiKey: undefined,
      localBaseUrl: LOCAL_URL,
    } as const;
    const forcedJson = resolveGovernanceLlmDecision({ ...base, moderationFormat: 'json' });
    expect(forcedJson.enabled && forcedJson.moderationFormat).toBe('json');
    const forcedGuard = resolveGovernanceLlmDecision({
      ...base,
      modelId: 'llama3.3',
      moderationFormat: 'guard',
    });
    expect(forcedGuard.enabled && forcedGuard.moderationFormat).toBe('qwen3guard');
    const garbage = resolveGovernanceLlmDecision({
      ...base,
      modelId: 'llama3.3',
      moderationFormat: 'yaml',
    });
    expect(garbage.enabled && garbage.moderationFormat).toBe('json');
  });

  it('anthropic: disabled without a key (absent, empty, or whitespace)', () => {
    for (const apiKey of [undefined, '', '   ']) {
      const decision = resolveGovernanceLlmDecision({ provider: 'anthropic', apiKey });
      expect(decision).toEqual({ enabled: false, reason: 'missing_api_key' });
    }
  });

  it('anthropic: enables with the reviewed defaults on both lanes; per-lane models override; hub resolution is off', () => {
    const decision = resolveGovernanceLlmDecision({ provider: 'anthropic', apiKey: ` ${KEY} ` });
    expect(decision.enabled).toBe(true);
    if (decision.enabled) {
      expect(decision.lanes.moderation.backend).toEqual({ kind: 'anthropic', apiKey: KEY }); // trimmed
      expect(decision.lanes.adjudication.backend).toEqual({ kind: 'anthropic', apiKey: KEY });
      expect(decision.lanes.moderation.settings.modelId).toBe('claude-opus-4-8');
      expect(decision.lanes.adjudication.settings.modelId).toBe('claude-opus-4-8');
      // Hub models are local-runtime-only: nothing to probe under the hosted backend.
      expect(decision.runtimeUrls).toEqual([]);
    }
    const overridden = resolveGovernanceLlmDecision({
      provider: 'anthropic',
      apiKey: KEY,
      adjudicationModelId: 'claude-haiku-4-5',
    });
    expect(overridden.enabled && overridden.lanes.adjudication.settings.modelId).toBe(
      'claude-haiku-4-5',
    );
    expect(overridden.enabled && overridden.lanes.moderation.settings.modelId).toBe(
      'claude-opus-4-8',
    );
    const blank = resolveGovernanceLlmDecision({
      provider: 'anthropic',
      apiKey: KEY,
      modelId: '   ',
    });
    expect(blank.enabled && blank.lanes.moderation.settings.modelId).toBe('claude-opus-4-8');
  });

  it('local: disabled for ANY non-loopback or non-http(s) URL on either lane or the extras (no egress wearing a local flag)', () => {
    for (const localBaseUrl of [
      'http://192.168.1.20:11434/v1',
      'https://api.example.com/v1',
      'http://myhost.local:8080/v1',
      'ftp://127.0.0.1/v1',
      'not a url',
    ]) {
      const decision = resolveGovernanceLlmDecision({
        provider: 'local',
        apiKey: undefined,
        localBaseUrl,
        modelId: 'llama3.3',
      });
      expect(decision).toEqual({ enabled: false, reason: 'local_url_not_loopback' });
    }
    expect(
      resolveGovernanceLlmDecision({
        provider: 'local',
        apiKey: undefined,
        adjudicationUrl: 'https://api.example.com/v1',
      }),
    ).toEqual({ enabled: false, reason: 'local_url_not_loopback' });
    expect(
      resolveGovernanceLlmDecision({
        provider: 'local',
        apiKey: undefined,
        extraRuntimeUrls: ['http://127.0.0.1:9005/v1', 'http://10.0.0.2:9005/v1'],
      }),
    ).toEqual({ enabled: false, reason: 'local_url_not_loopback' });
  });

  it('local: extra runtime URLs join the probeable set (deduplicated, order-preserving)', () => {
    const decision = resolveGovernanceLlmDecision({
      provider: 'local',
      apiKey: undefined,
      localBaseUrl: LOCAL_URL,
      extraRuntimeUrls: ['http://127.0.0.1:9005/v1', LOCAL_URL, ' '],
    });
    expect(decision.enabled).toBe(true);
    if (decision.enabled) {
      expect(decision.runtimeUrls).toEqual([LOCAL_URL, 'http://127.0.0.1:9005/v1']);
    }
  });

  it('local: enables on every loopback host form with the explicit model', () => {
    for (const localBaseUrl of [LOCAL_URL, 'http://localhost:8080/v1/', 'https://[::1]:4000/v1']) {
      const decision = resolveGovernanceLlmDecision({
        provider: 'local',
        apiKey: undefined,
        localBaseUrl,
        modelId: ' llama3.3:70b ',
      });
      expect(decision.enabled).toBe(true);
      if (decision.enabled) {
        expect(decision.lanes.moderation.backend).toEqual({
          kind: 'local',
          baseUrl: localBaseUrl.trim(),
        });
        expect(decision.lanes.moderation.settings.modelId).toBe('llama3.3:70b'); // trimmed
        expect(decision.lanes.moderation.settings.maxCallsPerRoomPerHour).toBe(
          DEFAULT_GOVERNANCE_LLM_SETTINGS.maxCallsPerRoomPerHour,
        );
      }
    }
  });

  it('the LLM is the moderation model by default, disabled only by GOVERNANCE_LLM_MODERATION=off', () => {
    const base = { provider: 'anthropic', apiKey: KEY } as const;
    // Default (absent) ⇒ the LLM is the moderation model.
    const on = resolveGovernanceLlmDecision(base);
    expect(on.enabled && on.llmModeration).toBe(true);
    // Any non-'off' value ⇒ on; 'off'/'OFF'/' off ' ⇒ off (deterministic default proposer).
    expect(
      resolveGovernanceLlmDecision({ ...base, moderation: 'on' }) as { llmModeration: boolean },
    ).toMatchObject({ llmModeration: true });
    for (const value of ['off', 'OFF', '  off  ']) {
      const d = resolveGovernanceLlmDecision({ ...base, moderation: value });
      expect(d.enabled && d.llmModeration).toBe(false);
    }
    // The flag is independent of the backend (local honours it too).
    const local = resolveGovernanceLlmDecision({
      provider: 'local',
      apiKey: undefined,
      localBaseUrl: LOCAL_URL,
      modelId: 'llama3.3',
      moderation: 'off',
    });
    expect(local.enabled && local.llmModeration).toBe(false);
  });

  it('the LLM is the debate adjudicator by default, disabled only by GOVERNANCE_LLM_DEBATE=off', () => {
    const base = { provider: 'anthropic', apiKey: KEY } as const;
    const on = resolveGovernanceLlmDecision(base);
    expect(on.enabled && on.llmDebate).toBe(true);
    for (const value of ['off', 'OFF', '  off  ']) {
      const d = resolveGovernanceLlmDecision({ ...base, debate: value });
      expect(d.enabled && d.llmDebate).toBe(false);
      // The flags are independent: debate off leaves moderation on.
      expect(d.enabled && d.llmModeration).toBe(true);
    }
    const local = resolveGovernanceLlmDecision({
      provider: 'local',
      apiKey: undefined,
      localBaseUrl: LOCAL_URL,
      modelId: 'llama3.3',
      debate: 'off',
    });
    expect(local.enabled && local.llmDebate).toBe(false);
  });

  it('GOVERNANCE_LLM_DEBATE_BUDGET_PER_HOUR overrides the ADR-6 debate budget (invalid values ignored)', () => {
    const base = { provider: 'anthropic', apiKey: KEY } as const;
    const defaulted = resolveGovernanceLlmDecision(base);
    expect(
      defaulted.enabled && defaulted.lanes.adjudication.settings.maxDebateJudgementsPerHour,
    ).toBe(60);
    const raised = resolveGovernanceLlmDecision({ ...base, debateBudgetPerHour: 5_000 });
    expect(raised.enabled && raised.lanes.adjudication.settings.maxDebateJudgementsPerHour).toBe(
      5_000,
    );
    for (const bad of [0, -5, 1.5, Number.NaN]) {
      const d = resolveGovernanceLlmDecision({ ...base, debateBudgetPerHour: bad });
      expect(d.enabled && d.lanes.adjudication.settings.maxDebateJudgementsPerHour).toBe(60);
    }
  });

  it('reasoning effort: local defaults to the reviewed `low` on both lanes, honours overrides, and `off` disables; hosted never sends it', () => {
    const local = (reasoningEffort?: string) =>
      resolveGovernanceLlmDecision({
        provider: 'local',
        apiKey: undefined,
        localBaseUrl: LOCAL_URL,
        modelId: 'llama3.3',
        reasoningEffort,
      });
    const expectEffort = (value: string | undefined, effort: 'low' | 'medium' | 'high' | null) => {
      const decision = local(value);
      expect(decision.enabled && decision.lanes.moderation.settings.reasoningEffort).toBe(effort);
      expect(decision.enabled && decision.lanes.adjudication.settings.reasoningEffort).toBe(effort);
    };
    expectEffort(undefined, 'low'); // the reviewed default for the local backend
    expectEffort('medium', 'medium');
    expectEffort(' HIGH ', 'high');
    expectEffort('off', null);
    // Garbage behaves like unset — the reviewed default, never a raw pass-through.
    expectEffort('turbo', 'low');
    // The hosted backend never carries the field (Claude rejects unknown params).
    const hosted = resolveGovernanceLlmDecision({
      provider: 'anthropic',
      apiKey: KEY,
      reasoningEffort: 'high',
    });
    expect(hosted.enabled && hosted.lanes.adjudication.settings.reasoningEffort).toBe(null);
  });

  it('never mutates the shared default settings object', () => {
    const decision = resolveGovernanceLlmDecision({
      provider: 'local',
      apiKey: undefined,
      localBaseUrl: LOCAL_URL,
      modelId: 'llama3.3',
    });
    expect(decision.enabled).toBe(true);
    expect(DEFAULT_GOVERNANCE_LLM_SETTINGS.modelId).toBe('claude-opus-4-8');
    expect(DEFAULT_GOVERNANCE_LLM_SETTINGS.maxModerationCallsPerRoomPerHour).toBe(120);
  });
});
