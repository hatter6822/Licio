// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The DEV boot's per-lane simulated-runtime substitution (the 2026-07-21
// vLLM-default-everywhere posture): dev resolves the SAME 'local' defaults as
// production, the boot probes each lane's (URL, model) pair, and ONLY a lane
// whose real runtime is not serving its model is pointed at the simulated
// runtime — real vLLM is preferred per lane, and the overlay's per-lane keys
// outrank a stale legacy URL so a simulated lane can never be pulled back off
// the simulator by leftover env.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GOVERNANCE_LLM_ADJUDICATION_MODEL_ID,
  DEFAULT_GOVERNANCE_LLM_ADJUDICATION_URL,
  DEFAULT_GOVERNANCE_LLM_MODERATION_MODEL_ID,
  DEFAULT_GOVERNANCE_LLM_MODERATION_URL,
  type GovernanceLlmEnvInput,
  resolveGovernanceLlmDecision,
  SIMULATED_GOVERNANCE_LLM_MODEL_ID,
} from '../ai-governance/llm/config.js';
import {
  DEV_SIMULATED_DEBATE_BUDGET_PER_HOUR,
  devSimulatedLanes,
  overlaySimulatedLanes,
} from '../ai-governance/llm/dev-lanes.js';
import { type CatalogFetchLike, probeLaneRuntime } from '../ai-governance/llm/runtime-catalog.js';

const SIM_URL = 'http://127.0.0.1:3117/v1';

const devEnvInput = (over: Partial<GovernanceLlmEnvInput> = {}): GovernanceLlmEnvInput => ({
  provider: undefined,
  apiKey: undefined,
  nodeEnv: 'development',
  ...over,
});

describe('devSimulatedLanes', () => {
  it('substitutes exactly the lanes that are not fully live', () => {
    expect(devSimulatedLanes({ moderation: 'live', adjudication: 'live' })).toEqual({
      moderation: false,
      adjudication: false,
    });
    expect(devSimulatedLanes({ moderation: 'down', adjudication: 'live' })).toEqual({
      moderation: true,
      adjudication: false,
    });
    // A listening runtime WITHOUT the lane's model substitutes exactly like a
    // down one — every completion against it would 404.
    expect(devSimulatedLanes({ moderation: 'live', adjudication: 'no_model' })).toEqual({
      moderation: false,
      adjudication: true,
    });
    expect(devSimulatedLanes({ moderation: 'down', adjudication: 'down' })).toEqual({
      moderation: true,
      adjudication: true,
    });
  });
});

describe('overlaySimulatedLanes', () => {
  it('no substitution ⇒ the env input is returned untouched', () => {
    const envInput = devEnvInput();
    expect(
      overlaySimulatedLanes(envInput, { moderation: false, adjudication: false }, SIM_URL),
    ).toBe(envInput);
  });

  it('leaves the PROVIDER untouched, so `providerDefaulted` stays honest (the backend defaulted in — it was never an explicit choice)', () => {
    const overlaid = overlaySimulatedLanes(
      devEnvInput(),
      { moderation: true, adjudication: true },
      SIM_URL,
    );
    expect(overlaid.provider).toBeUndefined();
    const decision = resolveGovernanceLlmDecision(overlaid);
    expect(decision.enabled).toBe(true);
    if (decision.enabled) expect(decision.providerDefaulted).toBe(true);
    const partial = resolveGovernanceLlmDecision(
      overlaySimulatedLanes(devEnvInput(), { moderation: true, adjudication: false }, SIM_URL),
    );
    expect(partial.enabled).toBe(true);
    if (partial.enabled) expect(partial.providerDefaulted).toBe(true);
  });

  it('both lanes dead ⇒ both lanes resolve onto the simulator (single URL, sim model, raised debate budget)', () => {
    const decision = resolveGovernanceLlmDecision(
      overlaySimulatedLanes(devEnvInput(), { moderation: true, adjudication: true }, SIM_URL),
    );
    expect(decision.enabled).toBe(true);
    if (decision.enabled) {
      expect(decision.lanes.moderation.backend).toEqual({ kind: 'local', baseUrl: SIM_URL });
      expect(decision.lanes.adjudication.backend).toEqual({ kind: 'local', baseUrl: SIM_URL });
      expect(decision.lanes.moderation.settings.modelId).toBe(SIMULATED_GOVERNANCE_LLM_MODEL_ID);
      expect(decision.lanes.adjudication.settings.modelId).toBe(SIMULATED_GOVERNANCE_LLM_MODEL_ID);
      // The sim model id is not guard-family ⇒ the JSON dialect.
      expect(decision.moderationFormat).toBe('json');
      // Cost-free simulated adjudication ⇒ the raised dev debate budget.
      expect(decision.lanes.adjudication.settings.maxDebateJudgementsPerHour).toBe(
        DEV_SIMULATED_DEBATE_BUDGET_PER_HOUR,
      );
      expect(decision.runtimeUrls).toEqual([SIM_URL]);
    }
  });

  it('one dead lane ⇒ ONLY that lane moves to the simulator; the live lane keeps its real default', () => {
    const decision = resolveGovernanceLlmDecision(
      overlaySimulatedLanes(devEnvInput(), { moderation: true, adjudication: false }, SIM_URL),
    );
    expect(decision.enabled).toBe(true);
    if (decision.enabled) {
      expect(decision.lanes.moderation.backend).toEqual({ kind: 'local', baseUrl: SIM_URL });
      expect(decision.lanes.moderation.settings.modelId).toBe(SIMULATED_GOVERNANCE_LLM_MODEL_ID);
      expect(decision.lanes.adjudication.backend).toEqual({
        kind: 'local',
        baseUrl: DEFAULT_GOVERNANCE_LLM_ADJUDICATION_URL,
      });
      expect(decision.lanes.adjudication.settings.modelId).toBe(
        DEFAULT_GOVERNANCE_LLM_ADJUDICATION_MODEL_ID,
      );
      // A REAL adjudication lane keeps the reviewed ADR-6 debate budget.
      expect(decision.lanes.adjudication.settings.maxDebateJudgementsPerHour).toBe(60);
      expect(decision.runtimeUrls).toEqual([SIM_URL, DEFAULT_GOVERNANCE_LLM_ADJUDICATION_URL]);
    }
  });

  it('a live lane keeps its real default when the OTHER lane simulates (moderation stays real)', () => {
    const decision = resolveGovernanceLlmDecision(
      overlaySimulatedLanes(devEnvInput(), { moderation: false, adjudication: true }, SIM_URL),
    );
    expect(decision.enabled).toBe(true);
    if (decision.enabled) {
      expect(decision.lanes.moderation.backend).toEqual({
        kind: 'local',
        baseUrl: DEFAULT_GOVERNANCE_LLM_MODERATION_URL,
      });
      expect(decision.lanes.moderation.settings.modelId).toBe(
        DEFAULT_GOVERNANCE_LLM_MODERATION_MODEL_ID,
      );
      // The real guard default keeps its native dialect even while the
      // adjudication lane simulates.
      expect(decision.moderationFormat).toBe('qwen3guard');
      expect(decision.lanes.adjudication.backend).toEqual({ kind: 'local', baseUrl: SIM_URL });
      // Simulated adjudication ⇒ the raised dev debate budget.
      expect(decision.lanes.adjudication.settings.maxDebateJudgementsPerHour).toBe(
        DEV_SIMULATED_DEBATE_BUDGET_PER_HOUR,
      );
    }
  });

  it('a stale legacy GOVERNANCE_LLM_LOCAL_URL cannot pull a simulated lane off the simulator (per-lane keys outrank it)', () => {
    const decision = resolveGovernanceLlmDecision(
      overlaySimulatedLanes(
        devEnvInput({ localBaseUrl: 'http://127.0.0.1:11434/v1', modelId: 'llama3.3' }),
        { moderation: true, adjudication: false },
        SIM_URL,
      ),
    );
    expect(decision.enabled).toBe(true);
    if (decision.enabled) {
      // The simulated lane points at the sim (per-lane key wins)…
      expect(decision.lanes.moderation.backend).toEqual({ kind: 'local', baseUrl: SIM_URL });
      expect(decision.lanes.moderation.settings.modelId).toBe(SIMULATED_GOVERNANCE_LLM_MODEL_ID);
      // …while the live lane still honours the operator's legacy keys.
      expect(decision.lanes.adjudication.backend).toEqual({
        kind: 'local',
        baseUrl: 'http://127.0.0.1:11434/v1',
      });
      expect(decision.lanes.adjudication.settings.modelId).toBe('llama3.3');
    }
  });

  it('an explicit GOVERNANCE_LLM_DEBATE_BUDGET_PER_HOUR still wins over the raised dev budget', () => {
    const decision = resolveGovernanceLlmDecision(
      overlaySimulatedLanes(
        devEnvInput({ debateBudgetPerHour: 7 }),
        { moderation: true, adjudication: true },
        SIM_URL,
      ),
    );
    expect(decision.enabled).toBe(true);
    if (decision.enabled) {
      expect(decision.lanes.adjudication.settings.maxDebateJudgementsPerHour).toBe(7);
    }
  });
});

describe('probeLaneRuntime', () => {
  const fetchFor =
    (byUrl: Record<string, string[] | 'down' | 'http500'>): CatalogFetchLike =>
    async (url) => {
      const base = url.replace(/\/models$/, '');
      const models = byUrl[base];
      if (models === undefined || models === 'down') throw new Error('connection refused');
      if (models === 'http500') return { ok: false, status: 500, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ object: 'list', data: models.map((id) => ({ id })) }),
      };
    };
  const MOD_URL = 'http://127.0.0.1:8001/v1';

  it("'live' iff the runtime lists the lane's model; 'no_model' when listening without it", async () => {
    const fetchImpl = fetchFor({ [MOD_URL]: ['Qwen/Qwen3Guard-Gen-4B'] });
    expect(await probeLaneRuntime(MOD_URL, 'Qwen/Qwen3Guard-Gen-4B', { fetchImpl })).toBe('live');
    expect(await probeLaneRuntime(MOD_URL, 'Qwen/Qwen3.6-27B', { fetchImpl })).toBe('no_model');
  });

  it("'down' on connection failure, a non-2xx answer, or a malformed listing", async () => {
    expect(
      await probeLaneRuntime(MOD_URL, 'm', { fetchImpl: fetchFor({ [MOD_URL]: 'down' }) }),
    ).toBe('down');
    expect(
      await probeLaneRuntime(MOD_URL, 'm', { fetchImpl: fetchFor({ [MOD_URL]: 'http500' }) }),
    ).toBe('down');
    const malformed: CatalogFetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ nonsense: true }),
    });
    expect(await probeLaneRuntime(MOD_URL, 'm', { fetchImpl: malformed })).toBe('down');
  });
});
