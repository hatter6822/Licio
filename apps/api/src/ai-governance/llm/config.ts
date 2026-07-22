// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U ADR-9 fail-closed enablement + settings for the LLM-backed governance
// surfaces. TWO backends exist behind the same governed seam:
//   - 'anthropic' — the hosted Claude API (official SDK); requires
//     ANTHROPIC_API_KEY. Sends governed-room proposal text off-host, making
//     the vendor an operator-chosen data processor — never a silent or
//     mandatory dependency (boot logs it loudly). Always an EXPLICIT opt-in.
//   - 'local'     — SAME-HOST inference servers speaking the OpenAI-compatible
//     /chat/completions protocol. vLLM is the reviewed DEFAULT runtime
//     (provisioned by `pnpm setup:llm` / the compose `llm` profile); Ollama,
//     llama.cpp server, and LM Studio are supported operator alternatives.
//     Every URL is loopback-only, so "local" provably means no third-party
//     egress.
//
// THE ROLE SPLIT (the 2026-07 revision): the backend runs TWO model LANES,
// because the governed roles fail differently — an over/under-blocking safety
// classifier is a moderation failure mode, a shallow-reasoning generalist an
// adjudication one:
//   - the MODERATION lane (the in-room moderation model) defaults to the
//     Qwen3Guard generative safety classifier;
//   - the ADJUDICATION lane (the WS-T debate adjudicator AND the advisory
//     lawmaking summariser — both generalist-reasoning surfaces) defaults to
//     the Qwen3.6 generalist.
// Lane precedence: per-lane env key → legacy single-lane key (both lanes; the
// single-runtime posture, e.g. one Ollama serving both models from one URL) →
// the reviewed per-lane default below.
//
// Environment defaults (the 2026-07-09 maintainer decisions, revised again
// 2026-07-21 — the vLLM-default-everywhere revision):
//   - PRODUCTION **and** DEVELOPMENT run the COMPLETE feature by default: an
//     unset GOVERNANCE_LLM_PROVIDER resolves to the 'local' backend with the
//     defaults above (the two vLLM lanes) in BOTH environments — the same
//     runtime posture everywhere, so dev exercises exactly what production
//     runs. If a runtime is absent, every governed surface fails CLOSED at
//     call time to its deterministic path (summary fallback, platform-baseline
//     moderation + deferred re-moderation, the deterministic debate
//     adjudicator), and recovers when it appears.
//   - The DEV BOOT additionally probes each defaulted lane's runtime and
//     points any lane that is NOT actually serving its model at the DEV-ONLY
//     simulated loopback runtime (simulator/governance-llm.ts) — real vLLM
//     lanes are preferred whenever they are up, and the simulator stands in
//     per lane otherwise, so `pnpm dev` always has live AI moderation and
//     adjudication with zero setup. LICIO_LLM_SIM=off disables the stand-in
//     (dev then behaves exactly like production: fail closed per call).
//   - Test runs (NODE_ENV=test / unset) resolve to `not_requested` — a test
//     process never grows a silent default backend.
//   - GOVERNANCE_LLM_PROVIDER=deterministic is the explicit opt-out anywhere.
// Any INVALID explicit value still resolves to the deterministic default, so
// a misconfiguration can never silently enable an unintended backend (the
// house fail-closed config posture).

import { isLoopbackHttpUrl } from '@licio/shared/env';
import { type ModerationOutputFormat, resolveModerationOutputFormat } from './guard-format.js';

/** The two governed model lanes (the moderation/adjudication role split). The
 *  lawmaking summariser rides the adjudication lane — drafting a neutral
 *  summary is generalist reasoning, not safety triage. */
export type GovernanceLlmRole = 'moderation' | 'adjudication';

export interface GovernanceLlmSettings {
  /** Model id — a Claude model for 'anthropic' (default claude-opus-4-8), the
   *  local runtime's served model name for 'local' (per-lane defaults below). */
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
  /** ADR-6 hourly budget for the WS-T debate-adjudication leg. Debates resolve
   *  once each on the 12h scheduler, so the natural rate is low; an exhausted
   *  budget falls back to the deterministic adjudicator (never a dropped
   *  verdict). PER-PROCESS window (like every ADR-6 budget): the debate
   *  scheduler's job lease scopes draining to one process per tick, so this
   *  approximates a deployment-wide cap, but a lease that migrates across
   *  replicas mid-hour multiplies the effective budget by the number of
   *  distinct holders. An exactly-global, shared-store window is a tracked
   *  residual (docs/ai-governance/README.md). */
  maxDebateJudgementsPerHour: number;
  /** Consecutive-failure count that opens the circuit breaker. */
  breakerFailureThreshold: number;
  /** Seconds the breaker stays open before a half-open retry. */
  breakerCooldownSeconds: number;
  /** LOCAL backend only: the OpenAI-compatible `reasoning_effort` sent with
   *  every completion. Reasoning models' latency is dominated by thinking
   *  tokens; `low` cuts a verdict's wall-clock materially and `none` disables
   *  thinking entirely — the unlock for the qwen3 family, whose thinking
   *  otherwise exhausts the output budget. The deterministic gates judge every
   *  output regardless. The completion layer NEGOTIATES per runtime: a
   *  400-rejected field is retried without and latched (e.g. the non-thinking
   *  Qwen3Guard line); a thinking-exhausted response retries once at `none`
   *  and latches (both logged + counted — never silent). Null ⇒ the field is
   *  never sent (always null for the hosted backend; the explicit `off`). */
  reasoningEffort: 'none' | 'low' | 'medium' | 'high' | null;
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
  reasoningEffort: null,
};

/** The reviewed default `reasoning_effort` for the LOCAL backend (measured
 *  latency cut per verdict at unchanged gate outcomes on reasoning models;
 *  auto-negotiated away on models that reject or exhaust it).
 *  GOVERNANCE_LLM_REASONING_EFFORT overrides ('off' ⇒ never send the field). */
export const DEFAULT_GOVERNANCE_LLM_LOCAL_REASONING_EFFORT = 'low' as const;

/** The reviewed default MODERATION-lane model: the Qwen3Guard generative
 *  safety classifier (Apache-2.0, 4B — single-GPU class). A guard model is a
 *  purpose-trained safety triage: its failure modes (over/under-blocking on a
 *  fixed taxonomy) are the moderation-shaped ones, and the proposer speaks its
 *  NATIVE Safety/Categories dialect (guard-format.ts) rather than forcing
 *  schema-guided JSON onto it. Operators override per deployment; the model id
 *  is folded into the lane's registry identity, so a swap mints a new identity
 *  that re-clears the WS-K gate and forces re-admission. */
export const DEFAULT_GOVERNANCE_LLM_MODERATION_MODEL_ID = 'Qwen/Qwen3Guard-Gen-4B';

/** The reviewed default ADJUDICATION-lane model (also serves the lawmaking
 *  summariser): the Qwen3.6 generalist (Apache-2.0, 27B) — debate adjudication
 *  and neutral summarisation are reasoning tasks a guard classifier cannot do.
 *  Same override/identity discipline as the moderation lane. */
export const DEFAULT_GOVERNANCE_LLM_ADJUDICATION_MODEL_ID = 'Qwen/Qwen3.6-27B';

/** The default per-lane 'local' base URLs: two loopback vLLM instances (vLLM
 *  serves ONE model per instance, so the two lanes get one each — the compose
 *  `llm` profile provisions exactly these). Operators running a multiplexing
 *  runtime (Ollama serves many models from one URL) point both lanes at it via
 *  GOVERNANCE_LLM_LOCAL_URL or the per-lane URL keys. */
export const DEFAULT_GOVERNANCE_LLM_MODERATION_URL = 'http://127.0.0.1:8001/v1';
export const DEFAULT_GOVERNANCE_LLM_ADJUDICATION_URL = 'http://127.0.0.1:8002/v1';

/** The conventional loopback URL of the OLLAMA alternative runtime (the
 *  single-URL multiplexing option `pnpm setup:llm --runtime ollama`
 *  provisions; docs + scripts reference it — NOT a lane default). */
export const OLLAMA_LOOPBACK_URL = 'http://127.0.0.1:11434/v1';

/** The DEV-ONLY simulated runtime's model id (the simulator serves all three
 *  governed surfaces under it; defined here so production modules — the boot
 *  rewrite, the runtime catalog's dev wildcard — never import simulator code). */
export const SIMULATED_GOVERNANCE_LLM_MODEL_ID = 'licio-governance-sim';

/** The transport a decision selected (the key/URL live here, NEVER in the
 *  model-identity config that gets hashed into output records). */
export type GovernanceLlmBackend =
  | { kind: 'anthropic'; apiKey: string }
  | { kind: 'local'; baseUrl: string };

/** One resolved model lane: the transport plus the lane's settings (whose
 *  `modelId`/`reasoningEffort` are lane-specific; the budget/breaker numbers
 *  are the shared reviewed defaults). */
export interface GovernanceLlmLane {
  backend: GovernanceLlmBackend;
  settings: GovernanceLlmSettings;
}

export interface GovernanceLlmEnvInput {
  /** GOVERNANCE_LLM_PROVIDER — 'anthropic' or 'local' opts in explicitly;
   *  'deterministic' opts out explicitly; UNSET defaults to 'local' in
   *  production AND development (the vLLM-default-everywhere posture; the dev
   *  boot then substitutes the simulated runtime per lane whose real runtime
   *  is absent) and to `not_requested` elsewhere (tests). */
  provider: string | undefined;
  /** ANTHROPIC_API_KEY (anthropic backend). */
  apiKey: string | undefined;
  /** GOVERNANCE_LLM_MODEL — the LEGACY single-lane model override; applies to
   *  BOTH lanes when the per-lane keys are unset (the single-runtime posture). */
  modelId?: string | undefined;
  /** GOVERNANCE_LLM_LOCAL_URL — the LEGACY single-lane URL override; applies to
   *  BOTH lanes when the per-lane URL keys are unset. Loopback-only. */
  localBaseUrl?: string | undefined;
  /** GOVERNANCE_LLM_MODERATION_MODEL / GOVERNANCE_LLM_ADJUDICATION_MODEL —
   *  per-lane model overrides (highest precedence). */
  moderationModelId?: string | undefined;
  adjudicationModelId?: string | undefined;
  /** GOVERNANCE_LLM_MODERATION_URL / GOVERNANCE_LLM_ADJUDICATION_URL —
   *  per-lane 'local' base URLs (highest precedence; loopback-only). */
  moderationUrl?: string | undefined;
  adjudicationUrl?: string | undefined;
  /** GOVERNANCE_LLM_EXTRA_RUNTIME_URLS (parsed) — additional loopback runtime
   *  base URLs the room-model resolver may locate ratified hub models on. */
  extraRuntimeUrls?: readonly string[] | undefined;
  /** GOVERNANCE_LLM_MODERATION_FORMAT — 'json' | 'guard' | 'auto' (default:
   *  auto-detect guard-family models by id; invalid values auto-detect). */
  moderationFormat?: string | undefined;
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
  /** GOVERNANCE_LLM_REASONING_EFFORT — the local backend's `reasoning_effort`
   *  ('none'|'low'|'medium'|'high'; 'off' ⇒ never send the field). Unset ⇒
   *  the reviewed default ('low'; the completion layer auto-negotiates per
   *  model family). Applies to both lanes; ignored for the hosted backend. */
  reasoningEffort?: string | undefined;
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
      /** The two resolved model lanes. The lawmaking summariser uses the
       *  adjudication lane (generalist reasoning). */
      lanes: { moderation: GovernanceLlmLane; adjudication: GovernanceLlmLane };
      /** The moderation lane's completion dialect ('auto' resolved against the
       *  lane's model id — guard-family models get their native profile). */
      moderationFormat: ModerationOutputFormat;
      /** The deduplicated loopback runtime base URLs (lane URLs + extras) the
       *  room-model resolver may probe for ratified hub models; empty for the
       *  hosted backend (hub models are local-runtime-only). */
      runtimeUrls: string[];
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

/** One governed surface's boot outcome on a lane (admitted + wired, or which
 *  fallback serves instead). */
export interface GovernanceLlmSurfaceStatus {
  surface: 'moderation' | 'debate' | 'summary';
  /** True when the LLM leg is admitted + wired for this surface this boot;
   *  false ⇒ the deterministic path serves it entirely (opt-out or WS-K
   *  admission refusal — `fallback` names it). */
  active: boolean;
  /** The deterministic path that serves when the LLM leg is inactive OR fails
   *  a call (always-on fail-closed floor). */
  fallback: 'platform_baseline' | 'deterministic_mlp' | 'deterministic_summary';
}

/** One lane's boot-resolved, observability-only status (never a key). */
export interface GovernanceLlmLaneStatus {
  role: GovernanceLlmRole;
  backend: 'anthropic' | 'local';
  modelId: string;
  /** The loopback base URL ('local' backend); null for the hosted backend. */
  baseUrl: string | null;
  /** True when the DEV simulated runtime stands in for this lane (never true
   *  in production — the simulator refuses to start there). */
  simulated: boolean;
  /** The moderation lane's completion dialect; null on the adjudication lane. */
  format: ModerationOutputFormat | null;
  surfaces: GovernanceLlmSurfaceStatus[];
}

/** The boot-resolved governed-LLM status summary: what backend/model each
 *  lane runs, whether the DEV simulator stands in, and which governed
 *  surfaces are active. Set ONCE at boot (it reports wiring, not liveness —
 *  per-call health lives in the breaker/metrics); served by the AI-team admin
 *  surface and the dev simulator status so "is the AI actually running?" has
 *  a first-class answer. */
export type GovernanceLlmStatusReport =
  | { enabled: false; reason: GovernanceLlmDisabledReason }
  | {
      enabled: true;
      /** True when the backend defaulted in (no explicit provider). */
      providerDefaulted: boolean;
      lanes: { moderation: GovernanceLlmLaneStatus; adjudication: GovernanceLlmLaneStatus };
    };

/** Resolve the boot-time enablement decision (pure; unit-tested fail-closed). */
export function resolveGovernanceLlmDecision(input: GovernanceLlmEnvInput): GovernanceLlmDecision {
  // The complete-feature default: an UNSET provider means the operator made no
  // choice — production AND development then run the full 'local' feature (the
  // vLLM-default-everywhere posture; deterministic paths remain the per-call
  // fail-closed fallback, and the dev boot substitutes the simulated runtime
  // per absent lane); anything explicit — the 'deterministic' opt-out and
  // every invalid value included — never defaults. Test runs never default.
  const provider =
    input.provider === undefined &&
    (input.nodeEnv === 'production' || input.nodeEnv === 'development')
      ? 'local'
      : input.provider;
  const providerDefaulted = provider !== input.provider;
  if (provider !== 'anthropic' && provider !== 'local') {
    return { enabled: false, reason: 'not_requested' };
  }

  const shared = { ...DEFAULT_GOVERNANCE_LLM_SETTINGS };
  if (
    input.debateBudgetPerHour !== undefined &&
    Number.isInteger(input.debateBudgetPerHour) &&
    input.debateBudgetPerHour > 0
  ) {
    shared.maxDebateJudgementsPerHour = input.debateBudgetPerHour;
  }
  const legacyModelId = input.modelId?.trim();
  const moderationModelOverride = input.moderationModelId?.trim();
  const adjudicationModelOverride = input.adjudicationModelId?.trim();
  const llmModeration = input.moderation?.trim().toLowerCase() !== 'off';
  const llmDebate = input.debate?.trim().toLowerCase() !== 'off';
  const flags = { llmModeration, llmDebate, providerDefaulted };
  const formatInput = ((): 'auto' | 'json' | 'guard' | undefined => {
    const value = input.moderationFormat?.trim().toLowerCase();
    return value === 'json' || value === 'guard' || value === 'auto' ? value : undefined;
  })();

  if (provider === 'anthropic') {
    const apiKey = input.apiKey?.trim() ?? '';
    if (apiKey.length === 0) return { enabled: false, reason: 'missing_api_key' };
    const backend: GovernanceLlmBackend = { kind: 'anthropic', apiKey };
    const moderationModel =
      moderationModelOverride || legacyModelId || DEFAULT_GOVERNANCE_LLM_SETTINGS.modelId;
    const adjudicationModel =
      adjudicationModelOverride || legacyModelId || DEFAULT_GOVERNANCE_LLM_SETTINGS.modelId;
    return {
      enabled: true,
      lanes: {
        moderation: { backend, settings: { ...shared, modelId: moderationModel } },
        adjudication: { backend, settings: { ...shared, modelId: adjudicationModel } },
      },
      // A forced `guard` override is IGNORED under the hosted backend: no
      // hosted Claude model speaks the Qwen3Guard block, so honouring it would
      // pin every moderation call into a parse-fail → deferred-re-moderation
      // loop. Auto-detection (which resolves hosted models to 'json') applies.
      moderationFormat: resolveModerationOutputFormat(
        moderationModel,
        formatInput === 'guard' ? undefined : formatInput,
      ),
      runtimeUrls: [],
      ...flags,
    };
  }

  // 'local': the loopback-only same-host backend. Every lane URL + model
  // carries a reviewed default (the two vLLM lane instances + the Qwen pair),
  // so `GOVERNANCE_LLM_PROVIDER=local` alone — or the production default — is
  // a complete configuration. EVERY provided URL is still loopback-enforced.
  const legacyUrl = input.localBaseUrl?.trim();
  const moderationUrl =
    input.moderationUrl?.trim() || legacyUrl || DEFAULT_GOVERNANCE_LLM_MODERATION_URL;
  const adjudicationUrl =
    input.adjudicationUrl?.trim() || legacyUrl || DEFAULT_GOVERNANCE_LLM_ADJUDICATION_URL;
  const extras = (input.extraRuntimeUrls ?? [])
    .map((url) => url.trim())
    .filter((u) => u.length > 0);
  for (const url of [moderationUrl, adjudicationUrl, ...extras]) {
    if (!isLoopbackHttpUrl(url)) return { enabled: false, reason: 'local_url_not_loopback' };
  }
  const effort = input.reasoningEffort?.trim().toLowerCase();
  const reasoningEffort =
    effort === 'off'
      ? null
      : effort === 'none' || effort === 'low' || effort === 'medium' || effort === 'high'
        ? effort
        : DEFAULT_GOVERNANCE_LLM_LOCAL_REASONING_EFFORT;
  const moderationModel =
    moderationModelOverride || legacyModelId || DEFAULT_GOVERNANCE_LLM_MODERATION_MODEL_ID;
  const adjudicationModel =
    adjudicationModelOverride || legacyModelId || DEFAULT_GOVERNANCE_LLM_ADJUDICATION_MODEL_ID;
  const runtimeUrls = [...new Set([moderationUrl, adjudicationUrl, ...extras])];
  return {
    enabled: true,
    lanes: {
      moderation: {
        backend: { kind: 'local', baseUrl: moderationUrl },
        settings: { ...shared, modelId: moderationModel, reasoningEffort },
      },
      adjudication: {
        backend: { kind: 'local', baseUrl: adjudicationUrl },
        settings: { ...shared, modelId: adjudicationModel, reasoningEffort },
      },
    },
    moderationFormat: resolveModerationOutputFormat(moderationModel, formatInput),
    runtimeUrls,
    ...flags,
  };
}
