// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U ADR-9 fail-closed enablement matrix for the LLM-backed governance NL
// provider: an explicit 'anthropic'/'local' opts in; PRODUCTION defaults an
// UNSET provider to 'local' (the production-complete posture — the loopback
// URL + model both carry reviewed defaults); 'deterministic' opts out
// explicitly; every invalid combination resolves to the deterministic default
// (no silent enablement, no silent egress).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GOVERNANCE_LLM_LOCAL_MODEL_ID,
  DEFAULT_GOVERNANCE_LLM_LOCAL_URL,
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

  it('PRODUCTION defaults an unset provider to the local backend with the reviewed defaults (the production-complete posture)', () => {
    const decision = resolveGovernanceLlmDecision({
      provider: undefined,
      apiKey: undefined,
      nodeEnv: 'production',
    });
    expect(decision.enabled).toBe(true);
    if (decision.enabled) {
      expect(decision.backend).toEqual({
        kind: 'local',
        baseUrl: DEFAULT_GOVERNANCE_LLM_LOCAL_URL,
      });
      expect(decision.settings.modelId).toBe(DEFAULT_GOVERNANCE_LLM_LOCAL_MODEL_ID);
      expect(decision.providerDefaulted).toBe(true);
      // All three governed surfaces default on.
      expect(decision.llmModeration).toBe(true);
      expect(decision.llmDebate).toBe(true);
    }
    // Explicit env values still condition the defaulted backend.
    const tuned = resolveGovernanceLlmDecision({
      provider: undefined,
      apiKey: undefined,
      modelId: 'qwen3:14b',
      nodeEnv: 'production',
    });
    expect(tuned.enabled && tuned.settings.modelId).toBe('qwen3:14b');
    // Non-production never silently defaults (dev wires the simulator at boot).
    for (const nodeEnv of [undefined, 'development', 'test']) {
      expect(
        resolveGovernanceLlmDecision({ provider: undefined, apiKey: undefined, nodeEnv }),
      ).toEqual({ enabled: false, reason: 'not_requested' });
    }
  });

  it('anthropic: disabled without a key (absent, empty, or whitespace)', () => {
    for (const apiKey of [undefined, '', '   ']) {
      const decision = resolveGovernanceLlmDecision({ provider: 'anthropic', apiKey });
      expect(decision).toEqual({ enabled: false, reason: 'missing_api_key' });
    }
  });

  it('anthropic: enables with the reviewed defaults and honours a model override', () => {
    const decision = resolveGovernanceLlmDecision({ provider: 'anthropic', apiKey: ` ${KEY} ` });
    expect(decision.enabled).toBe(true);
    if (decision.enabled) {
      expect(decision.backend).toEqual({ kind: 'anthropic', apiKey: KEY }); // trimmed
      expect(decision.settings).toEqual(DEFAULT_GOVERNANCE_LLM_SETTINGS);
      expect(decision.settings.modelId).toBe('claude-opus-4-8');
    }
    const overridden = resolveGovernanceLlmDecision({
      provider: 'anthropic',
      apiKey: KEY,
      modelId: 'claude-haiku-4-5',
    });
    expect(overridden.enabled && overridden.settings.modelId).toBe('claude-haiku-4-5');
    const blank = resolveGovernanceLlmDecision({
      provider: 'anthropic',
      apiKey: KEY,
      modelId: '   ',
    });
    expect(blank.enabled && blank.settings.modelId).toBe('claude-opus-4-8');
  });

  it('local: an unset/blank base URL defaults to the Ollama loopback endpoint', () => {
    for (const localBaseUrl of [undefined, '', '   ']) {
      const decision = resolveGovernanceLlmDecision({
        provider: 'local',
        apiKey: undefined,
        localBaseUrl,
        modelId: 'llama3.3',
      });
      expect(decision.enabled).toBe(true);
      if (decision.enabled) {
        expect(decision.backend).toEqual({
          kind: 'local',
          baseUrl: DEFAULT_GOVERNANCE_LLM_LOCAL_URL,
        });
      }
    }
  });

  it('local: disabled for ANY non-loopback or non-http(s) URL (no egress wearing a local flag)', () => {
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
  });

  it('local: an unset/blank model defaults to the reviewed default local model', () => {
    for (const modelId of [undefined, '', '   ']) {
      const decision = resolveGovernanceLlmDecision({
        provider: 'local',
        apiKey: undefined,
        localBaseUrl: LOCAL_URL,
        modelId,
      });
      expect(decision.enabled).toBe(true);
      if (decision.enabled) {
        expect(decision.settings.modelId).toBe(DEFAULT_GOVERNANCE_LLM_LOCAL_MODEL_ID);
      }
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
        expect(decision.backend).toEqual({ kind: 'local', baseUrl: localBaseUrl.trim() });
        expect(decision.settings.modelId).toBe('llama3.3:70b'); // trimmed, required
        expect(decision.settings.maxCallsPerRoomPerHour).toBe(
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
    expect(defaulted.enabled && defaulted.settings.maxDebateJudgementsPerHour).toBe(60);
    const raised = resolveGovernanceLlmDecision({ ...base, debateBudgetPerHour: 5_000 });
    expect(raised.enabled && raised.settings.maxDebateJudgementsPerHour).toBe(5_000);
    for (const bad of [0, -5, 1.5, Number.NaN]) {
      const d = resolveGovernanceLlmDecision({ ...base, debateBudgetPerHour: bad });
      expect(d.enabled && d.settings.maxDebateJudgementsPerHour).toBe(60);
    }
  });

  it('reasoning effort: local defaults to the reviewed `low`, honours overrides, and `off` disables; hosted never sends it', () => {
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
      expect(decision.enabled && decision.settings.reasoningEffort).toBe(effort);
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
    expect(hosted.enabled && hosted.settings.reasoningEffort).toBe(null);
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
