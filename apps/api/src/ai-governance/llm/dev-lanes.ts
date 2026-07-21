// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The DEV boot's PER-LANE simulated-runtime substitution plan (pure; the boot
// probes each lane's runtime and passes the verdicts here). The 2026-07-21
// vLLM-default-everywhere posture: development resolves the same 'local'
// backend defaults as production (the two vLLM lanes), the boot probes each
// lane's (URL, model) pair via the standard /v1/models listing, and ONLY a
// lane whose real runtime is not actually serving its model is pointed at the
// DEV-ONLY simulated loopback runtime — real vLLM (or any provisioned local
// runtime) is preferred whenever it is up, and the simulator stands in per
// lane otherwise, so `pnpm dev` always has live AI moderation and
// adjudication with zero setup and zero egress.
//
// This module is PURE planning over `GovernanceLlmEnvInput` (no simulator
// import, no I/O) — the SIMULATED_GOVERNANCE_LLM_MODEL_ID pattern: production
// code never pulls simulator code in, and the plan is unit-testable without a
// process. The boot only starts the simulator when the plan says a lane needs
// it (`needsSimulator` on the probe summary).

import { type GovernanceLlmEnvInput, SIMULATED_GOVERNANCE_LLM_MODEL_ID } from './config.js';
import type { LaneRuntimeProbe } from './runtime-catalog.js';

/** The per-lane boot-probe verdicts (runtime-catalog `probeLaneRuntime`). */
export interface DevLaneProbes {
  moderation: LaneRuntimeProbe;
  adjudication: LaneRuntimeProbe;
}

/** Which lanes the plan points at the simulated runtime. */
export interface DevSimulatedLanes {
  moderation: boolean;
  adjudication: boolean;
}

/** A lane needs the simulator unless its real runtime is fully live —
 *  `no_model` (listening, wrong/absent model) would fail every completion, so
 *  it substitutes exactly like `down` (the log states which it was). */
export function devSimulatedLanes(probes: DevLaneProbes): DevSimulatedLanes {
  return {
    moderation: probes.moderation !== 'live',
    adjudication: probes.adjudication !== 'live',
  };
}

/** The raised dev debate budget when the ADJUDICATION lane is simulated (the
 *  simulated runtime is cost-free, so the ADR-6 budget must never cap a dev
 *  challenge-resolution throughput run; the env override still wins). */
export const DEV_SIMULATED_DEBATE_BUDGET_PER_HOUR = 100_000;

/**
 * Overlay the env input so every lane the probes found dead points at the
 * simulated runtime, while live lanes keep their real (env-resolved)
 * configuration untouched. Per-lane keys outrank the legacy single-lane keys
 * in the resolver, so setting them here redirects EXACTLY the simulated lanes
 * — a stale legacy `GOVERNANCE_LLM_LOCAL_URL` in a dev shell cannot pull a
 * simulated lane back off the simulator, and a live lane's own per-lane
 * overrides keep applying verbatim.
 */
export function overlaySimulatedLanes(
  envInput: GovernanceLlmEnvInput,
  simulated: DevSimulatedLanes,
  simBaseUrl: string,
): GovernanceLlmEnvInput {
  if (!simulated.moderation && !simulated.adjudication) return envInput;
  return {
    ...envInput,
    provider: 'local',
    ...(simulated.moderation
      ? { moderationUrl: simBaseUrl, moderationModelId: SIMULATED_GOVERNANCE_LLM_MODEL_ID }
      : {}),
    ...(simulated.adjudication
      ? {
          adjudicationUrl: simBaseUrl,
          adjudicationModelId: SIMULATED_GOVERNANCE_LLM_MODEL_ID,
          debateBudgetPerHour: envInput.debateBudgetPerHour ?? DEV_SIMULATED_DEBATE_BUDGET_PER_HOUR,
        }
      : {}),
  };
}
