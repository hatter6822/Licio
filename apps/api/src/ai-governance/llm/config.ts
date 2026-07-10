// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U ADR-9 fail-closed enablement + settings for the LLM-backed governance
// NL provider. TWO backends exist behind the same governed seam:
//   - 'anthropic' — the hosted Claude API (official SDK); requires
//     ANTHROPIC_API_KEY. Sends governed-room proposal text off-host, making
//     the vendor an operator-chosen data processor — never a silent or
//     mandatory dependency (boot logs it loudly). Always an EXPLICIT opt-in.
//   - 'local'     — a SAME-HOST inference server speaking the OpenAI-compatible
//     /chat/completions protocol (llama.cpp server, Ollama, vLLM, LM Studio).
//     GOVERNANCE_LLM_LOCAL_URL (loopback-only, so "local" provably means no
//     third-party egress) defaults to the Ollama loopback endpoint and
//     GOVERNANCE_LLM_MODEL to the reviewed default local model below.
// Environment defaults (the 2026-07-09 maintainer decisions, revised):
//   - PRODUCTION runs the COMPLETE feature by default: an unset
//     GOVERNANCE_LLM_PROVIDER resolves to the 'local' backend with the
//     defaults above — production is never silently LESS capable than
//     development. If the runtime is absent, every governed surface fails
//     CLOSED at call time to its reviewed deterministic path (summary
//     fallback, platform-baseline moderation + deferred re-moderation, the
//     deterministic debate adjudicator), and recovers when it appears.
//   - DEVELOPMENT with an unset provider resolves to `not_requested` here;
//     the dev boot then wires the DEV-ONLY simulated loopback runtime through
//     this same decision (simulator/governance-llm.ts), so dev fakes the
//     feature rather than running less of it.
//   - GOVERNANCE_LLM_PROVIDER=deterministic is the explicit opt-out anywhere.
// Any INVALID explicit value still resolves to the deterministic default, so
// a misconfiguration can never silently enable an unintended backend (the
// house fail-closed config posture).

import { isLoopbackHttpUrl } from '@licio/shared/env';

export interface GovernanceLlmSettings {
  /** Model id — a Claude model for 'anthropic' (default claude-opus-4-8), the
   *  local runtime's model name for 'local' (required; no default exists). */
  modelId: string;
  /** Hard per-response output-token ceiling. */
  maxOutputTokens: number;
  /** Per-request transport timeout (the summary surface). */
  timeoutMs: number;
  /** Tighter per-request timeout for the INLINE moderation path — it sits on the
   *  contribution hot path, so a slow model must fail to the platform baseline
   *  quickly (the deferred re-moderation sweep retries later). */
  moderationTimeoutMs: number;
  /** ADR-6 per-room invocation budget for the summary leg (fixed hourly window,
   *  identity-free: keyed by room, never by user or address). */
  maxCallsPerRoomPerHour: number;
  /** ADR-6 per-room budget for the SHADOW moderation leg (slice 2). Moderation
   *  runs per-contribution, so its natural rate is higher than the
   *  steward-triggered summary; excess simply goes un-shadowed (a natural,
   *  honest per-room sampling cap). */
  maxModerationCallsPerRoomPerHour: number;
  /** ADR-6 GLOBAL hourly budget for the WS-T debate-adjudication leg. Debates
   *  resolve once each on the 12h scheduler, so the natural rate is low; an
   *  exhausted budget falls back to the deterministic adjudicator (never a
   *  dropped verdict). Global, not per-room: the scheduler drains arenas
   *  process-wide. */
  maxDebateJudgementsPerHour: number;
  /** Consecutive-failure count that opens the circuit breaker. */
  breakerFailureThreshold: number;
  /** Seconds the breaker stays open before a half-open retry. */
  breakerCooldownSeconds: number;
}

export const DEFAULT_GOVERNANCE_LLM_SETTINGS: GovernanceLlmSettings = {
  modelId: 'claude-opus-4-8',
  maxOutputTokens: 1024,
  timeoutMs: 30_000,
  moderationTimeoutMs: 8_000,
  maxCallsPerRoomPerHour: 30,
  maxModerationCallsPerRoomPerHour: 120,
  maxDebateJudgementsPerHour: 60,
  breakerFailureThreshold: 3,
  breakerCooldownSeconds: 300,
};

/** The default 'local' base URL: the Ollama loopback endpoint (the most common
 *  local runtime; llama.cpp/vLLM/LM Studio operators set their own URL). */
export const DEFAULT_GOVERNANCE_LLM_LOCAL_URL = 'http://127.0.0.1:11434/v1';

/** The reviewed DEFAULT LOCAL MODEL both production and development use when
 *  GOVERNANCE_LLM_MODEL is unset for the 'local' backend: gpt-oss:20b — an
 *  Apache-2.0 open-weight reasoning model that Ollama, vLLM, llama.cpp and
 *  LM Studio all serve, strong at the strict-JSON structured outputs the three
 *  governed surfaces require, and small enough (MoE, ~16 GB) for a single
 *  production host. Operators override it per deployment; the model id is
 *  folded into each registry identity's config hash, so a swap mints a new
 *  identity that re-clears the WS-K gate. */
export const DEFAULT_GOVERNANCE_LLM_LOCAL_MODEL_ID = 'gpt-oss:20b';

/** The transport a decision selected (the key/URL live here, NEVER in the
 *  model-identity config that gets hashed into output records). */
export type GovernanceLlmBackend =
  | { kind: 'anthropic'; apiKey: string }
  | { kind: 'local'; baseUrl: string };

export interface GovernanceLlmEnvInput {
  /** GOVERNANCE_LLM_PROVIDER — 'anthropic' or 'local' opts in explicitly;
   *  'deterministic' opts out explicitly; UNSET defaults to 'local' in
   *  production (the production-complete default) and to `not_requested`
   *  elsewhere (the dev boot then wires the simulated runtime). */
  provider: string | undefined;
  /** ANTHROPIC_API_KEY (anthropic backend). */
  apiKey: string | undefined;
  /** GOVERNANCE_LLM_MODEL (optional for both backends: anthropic defaults to
   *  the reviewed Claude model; local to DEFAULT_GOVERNANCE_LLM_LOCAL_MODEL_ID). */
  modelId?: string | undefined;
  /** GOVERNANCE_LLM_LOCAL_URL (local backend; loopback-only OpenAI-compatible
   *  base URL; defaults to DEFAULT_GOVERNANCE_LLM_LOCAL_URL). */
  localBaseUrl?: string | undefined;
  /** GOVERNANCE_LLM_MODERATION — 'off' keeps the deterministic default
   *  moderation proposer even when a backend is configured (the backend then
   *  serves only the other surfaces). Any other value (incl. absent) uses the
   *  LLM as the in-room moderation model when a backend is enabled. */
  moderation?: string | undefined;
  /** GOVERNANCE_LLM_DEBATE — 'off' keeps the deterministic MLP debate
   *  adjudicator even when a backend is configured. Any other value (incl.
   *  absent) uses the LLM as the debate adjudicator when a backend is enabled
   *  (the deterministic MLP remains the per-call fail-closed fallback). */
  debate?: string | undefined;
  /** GOVERNANCE_LLM_DEBATE_BUDGET_PER_HOUR — overrides the ADR-6 global hourly
   *  debate-adjudication budget (default 60). The dev boot raises it for the
   *  cost-free simulated runtime; operators raise it for throughput testing
   *  against a real local runtime. Non-positive/invalid values are ignored. */
  debateBudgetPerHour?: number | undefined;
  /** NODE_ENV — drives the production-complete default above. Absent ⇒ treated
   *  as non-production (no silent default backend). */
  nodeEnv?: string | undefined;
}

export type GovernanceLlmDisabledReason =
  | 'not_requested'
  | 'missing_api_key'
  | 'local_url_not_loopback';

export type GovernanceLlmDecision =
  | { enabled: false; reason: GovernanceLlmDisabledReason }
  | {
      enabled: true;
      backend: GovernanceLlmBackend;
      settings: GovernanceLlmSettings;
      /** Whether the LLM is the in-room moderation model (ON unless
       *  GOVERNANCE_LLM_MODERATION=off — then the deterministic default proposer
       *  is used and the backend serves the other surfaces only). */
      llmModeration: boolean;
      /** Whether the LLM is the WS-T debate adjudicator (ON unless
       *  GOVERNANCE_LLM_DEBATE=off — the deterministic MLP is the per-call
       *  fail-closed fallback either way). */
      llmDebate: boolean;
      /** True when the backend was the PRODUCTION DEFAULT (no explicit
       *  GOVERNANCE_LLM_PROVIDER) rather than an operator choice — the boot
       *  log tells the operator exactly what runtime is expected where. */
      providerDefaulted: boolean;
    };

/** Resolve the boot-time enablement decision (pure; unit-tested fail-closed). */
export function resolveGovernanceLlmDecision(input: GovernanceLlmEnvInput): GovernanceLlmDecision {
  // The production-complete default: an UNSET provider means the operator made
  // no choice — production then runs the full 'local' feature (deterministic
  // paths remain the per-call fail-closed fallback); anything explicit — the
  // 'deterministic' opt-out and every invalid value included — never defaults.
  const provider =
    input.provider === undefined && input.nodeEnv === 'production' ? 'local' : input.provider;
  const providerDefaulted = provider !== input.provider;
  if (provider !== 'anthropic' && provider !== 'local') {
    return { enabled: false, reason: 'not_requested' };
  }

  const settings = { ...DEFAULT_GOVERNANCE_LLM_SETTINGS };
  if (
    input.debateBudgetPerHour !== undefined &&
    Number.isInteger(input.debateBudgetPerHour) &&
    input.debateBudgetPerHour > 0
  ) {
    settings.maxDebateJudgementsPerHour = input.debateBudgetPerHour;
  }
  const modelId = input.modelId?.trim();
  const llmModeration = input.moderation?.trim().toLowerCase() !== 'off';
  const llmDebate = input.debate?.trim().toLowerCase() !== 'off';
  const flags = { llmModeration, llmDebate, providerDefaulted };

  if (provider === 'anthropic') {
    const apiKey = input.apiKey?.trim() ?? '';
    if (apiKey.length === 0) return { enabled: false, reason: 'missing_api_key' };
    if (modelId) settings.modelId = modelId;
    return { enabled: true, backend: { kind: 'anthropic', apiKey }, settings, ...flags };
  }

  // 'local': the loopback-only same-host backend. URL + model both carry
  // reviewed defaults (the Ollama loopback endpoint + the default local model),
  // so `GOVERNANCE_LLM_PROVIDER=local` alone — or the production default — is a
  // complete configuration. A PROVIDED URL is still loopback-enforced.
  const baseUrl = input.localBaseUrl?.trim() || DEFAULT_GOVERNANCE_LLM_LOCAL_URL;
  if (!isLoopbackHttpUrl(baseUrl)) return { enabled: false, reason: 'local_url_not_loopback' };
  settings.modelId = modelId || DEFAULT_GOVERNANCE_LLM_LOCAL_MODEL_ID;
  return { enabled: true, backend: { kind: 'local', baseUrl }, settings, ...flags };
}
