// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U ADR-9 fail-closed enablement + settings for the LLM-backed governance
// NL provider. TWO backends exist behind the same governed seam:
//   - 'anthropic' — the hosted Claude API (official SDK); requires
//     ANTHROPIC_API_KEY. Sends governed-room proposal text off-host, making
//     the vendor an operator-chosen data processor — never a silent or
//     mandatory dependency (boot logs it loudly).
//   - 'local'     — an operator-run, SAME-HOST inference server speaking the
//     OpenAI-compatible /chat/completions protocol (llama.cpp server, Ollama,
//     vLLM, LM Studio); requires GOVERNANCE_LLM_LOCAL_URL (loopback-only, so
//     "local" provably means no third-party egress) + GOVERNANCE_LLM_MODEL.
// The provider is constructed ONLY when GOVERNANCE_LLM_PROVIDER names a
// backend (absent/'deterministic' ⇒ the deterministic default) AND that
// backend's requirements are met (key, or loopback URL + model). It is
// available in EVERY environment — production included (the 2026-07-09
// maintainer decision) — always as an explicit opt-in, and anything else —
// absent or invalid values included — resolves to the reviewed deterministic
// default, so a misconfiguration can never silently enable an LLM backend
// (the house fail-closed config posture).

import { isLoopbackHttpUrl } from '@licio/shared/env';

export interface GovernanceLlmSettings {
  /** Model id — a Claude model for 'anthropic' (default claude-opus-4-8), the
   *  local runtime's model name for 'local' (required; no default exists). */
  modelId: string;
  /** Hard per-response output-token ceiling. */
  maxOutputTokens: number;
  /** Per-request transport timeout. */
  timeoutMs: number;
  /** ADR-6 per-room invocation budget for the LLM leg (fixed hourly window,
   *  identity-free: keyed by room, never by user or address). */
  maxCallsPerRoomPerHour: number;
  /** Consecutive-failure count that opens the circuit breaker. */
  breakerFailureThreshold: number;
  /** Seconds the breaker stays open before a half-open retry. */
  breakerCooldownSeconds: number;
}

export const DEFAULT_GOVERNANCE_LLM_SETTINGS: GovernanceLlmSettings = {
  modelId: 'claude-opus-4-8',
  maxOutputTokens: 1024,
  timeoutMs: 30_000,
  maxCallsPerRoomPerHour: 30,
  breakerFailureThreshold: 3,
  breakerCooldownSeconds: 300,
};

/** The transport a decision selected (the key/URL live here, NEVER in the
 *  model-identity config that gets hashed into output records). */
export type GovernanceLlmBackend =
  | { kind: 'anthropic'; apiKey: string }
  | { kind: 'local'; baseUrl: string };

export interface GovernanceLlmEnvInput {
  /** GOVERNANCE_LLM_PROVIDER — 'anthropic' or 'local' opts in. */
  provider: string | undefined;
  /** ANTHROPIC_API_KEY (anthropic backend). */
  apiKey: string | undefined;
  /** GOVERNANCE_LLM_MODEL (optional override for anthropic; REQUIRED for local). */
  modelId?: string | undefined;
  /** GOVERNANCE_LLM_LOCAL_URL (local backend; loopback-only OpenAI-compatible
   *  base URL, e.g. http://127.0.0.1:11434/v1). */
  localBaseUrl?: string | undefined;
}

export type GovernanceLlmDisabledReason =
  | 'not_requested'
  | 'missing_api_key'
  | 'missing_local_url'
  | 'local_url_not_loopback'
  | 'missing_local_model';

export type GovernanceLlmDecision =
  | { enabled: false; reason: GovernanceLlmDisabledReason }
  | { enabled: true; backend: GovernanceLlmBackend; settings: GovernanceLlmSettings };

/** Resolve the boot-time enablement decision (pure; unit-tested fail-closed). */
export function resolveGovernanceLlmDecision(input: GovernanceLlmEnvInput): GovernanceLlmDecision {
  if (input.provider !== 'anthropic' && input.provider !== 'local') {
    return { enabled: false, reason: 'not_requested' };
  }

  const settings = { ...DEFAULT_GOVERNANCE_LLM_SETTINGS };
  const modelId = input.modelId?.trim();

  if (input.provider === 'anthropic') {
    const apiKey = input.apiKey?.trim() ?? '';
    if (apiKey.length === 0) return { enabled: false, reason: 'missing_api_key' };
    if (modelId) settings.modelId = modelId;
    return { enabled: true, backend: { kind: 'anthropic', apiKey }, settings };
  }

  // 'local': the loopback-only same-host backend.
  const baseUrl = input.localBaseUrl?.trim() ?? '';
  if (baseUrl.length === 0) return { enabled: false, reason: 'missing_local_url' };
  if (!isLoopbackHttpUrl(baseUrl)) return { enabled: false, reason: 'local_url_not_loopback' };
  if (!modelId) return { enabled: false, reason: 'missing_local_model' };
  settings.modelId = modelId;
  return { enabled: true, backend: { kind: 'local', baseUrl }, settings };
}
