// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U ADR-9 fail-closed enablement matrix for the LLM-backed governance NL
// provider: a backend exists ONLY behind the explicit opt-in + that backend's
// requirements ('anthropic' ⇒ a key; 'local' ⇒ a LOOPBACK-ONLY base URL + a
// model name); every other combination — including every invalid one —
// resolves to the deterministic default (no silent enablement, no silent
// egress). The opt-in is environment-independent (available in production as
// an explicit operator decision — the 2026-07-09 maintainer decision).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GOVERNANCE_LLM_SETTINGS,
  resolveGovernanceLlmDecision,
} from '../ai-governance/llm/config.js';

const KEY = 'sk-ant-test-key';
const LOCAL_URL = 'http://127.0.0.1:11434/v1';

describe('resolveGovernanceLlmDecision (fail-closed)', () => {
  it('is disabled when no backend is requested (the default posture)', () => {
    for (const provider of [undefined, '', 'deterministic', 'openai', 'ANTHROPIC', 'LOCAL']) {
      const decision = resolveGovernanceLlmDecision({
        provider,
        apiKey: KEY,
        localBaseUrl: LOCAL_URL,
        modelId: 'llama3.3',
      });
      expect(decision).toEqual({ enabled: false, reason: 'not_requested' });
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

  it('local: disabled without a base URL', () => {
    for (const localBaseUrl of [undefined, '', '   ']) {
      const decision = resolveGovernanceLlmDecision({
        provider: 'local',
        apiKey: undefined,
        localBaseUrl,
        modelId: 'llama3.3',
      });
      expect(decision).toEqual({ enabled: false, reason: 'missing_local_url' });
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

  it('local: disabled without an explicit model name (no cross-runtime default exists)', () => {
    for (const modelId of [undefined, '', '   ']) {
      const decision = resolveGovernanceLlmDecision({
        provider: 'local',
        apiKey: undefined,
        localBaseUrl: LOCAL_URL,
        modelId,
      });
      expect(decision).toEqual({ enabled: false, reason: 'missing_local_model' });
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

  it('never mutates the shared default settings object', () => {
    const decision = resolveGovernanceLlmDecision({
      provider: 'local',
      apiKey: undefined,
      localBaseUrl: LOCAL_URL,
      modelId: 'llama3.3',
    });
    expect(decision.enabled).toBe(true);
    expect(DEFAULT_GOVERNANCE_LLM_SETTINGS.modelId).toBe('claude-opus-4-8');
  });
});
