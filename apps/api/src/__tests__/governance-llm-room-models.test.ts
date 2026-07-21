// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The room-model resolver (WS-U model candidacy): catalog location → WS-K
// register/deploy through the REAL gate → cached loopback completion. Null on
// every failure edge (unlocated, hosted backend, gate refusal with a bounded
// retry cooldown), so callers fail closed; guard-family hub selections
// auto-detect their native moderation dialect; the identity pins the immutable
// hub revision (not the serving URL) as the decision surface.
import type { HubModelRef } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import type { GovernanceLlmLane } from '../ai-governance/llm/config.js';
import { DEFAULT_GOVERNANCE_LLM_SETTINGS } from '../ai-governance/llm/config.js';
import { createRoomModelResolver } from '../ai-governance/llm/room-models.js';
import type { RuntimeCatalog } from '../ai-governance/llm/runtime-catalog.js';
import {
  type AiGovernanceServices,
  createInMemoryAiGovernanceServices,
} from '../ai-governance/services.js';
import { createInMemoryEventPipelineServices } from '../events/services.js';

const SHA = 'd'.repeat(40);
const GUARD_REF: HubModelRef = {
  source: 'huggingface',
  repoId: 'Qwen/Qwen3Guard-Gen-8B',
  revision: SHA,
};
const GENERAL_REF: HubModelRef = {
  source: 'huggingface',
  repoId: 'Qwen/Qwen3.6-27B',
  revision: SHA,
};

function makeServices(): AiGovernanceServices {
  const now = () => Date.parse('2026-07-01T00:00:00.000Z');
  return createInMemoryAiGovernanceServices(createInMemoryEventPipelineServices({ now }), { now });
}

function lanes(kind: 'local' | 'anthropic' = 'local'): {
  moderation: GovernanceLlmLane;
  adjudication: GovernanceLlmLane;
} {
  const backend =
    kind === 'local'
      ? ({ kind: 'local', baseUrl: 'http://127.0.0.1:8001/v1' } as const)
      : ({ kind: 'anthropic', apiKey: 'sk-test' } as const);
  const settings = { ...DEFAULT_GOVERNANCE_LLM_SETTINGS, modelId: 'lane-model' };
  return {
    moderation: { backend, settings },
    adjudication: { backend, settings },
  };
}

function catalogServing(models: Record<string, string>): RuntimeCatalog {
  return {
    async locate(servedModelId) {
      const baseUrl = models[servedModelId];
      return baseUrl === undefined ? null : { baseUrl, servedModelId };
    },
  };
}

describe('createRoomModelResolver', () => {
  it('resolves a served hub model: WS-K-deployed identity, hub-revision pin, guard dialect auto-detected', async () => {
    const services = makeServices();
    const resolver = createRoomModelResolver({
      services,
      catalog: catalogServing({ 'Qwen/Qwen3Guard-Gen-8B': 'http://127.0.0.1:9001/v1' }),
      lanes: lanes(),
    });
    const resolved = await resolver.resolveModeration(GUARD_REF);
    expect(resolved).not.toBeNull();
    if (!resolved) return;
    expect(resolved.format).toBe('qwen3guard');
    expect(resolved.backendId).toMatch(/^llm:governance-moderation-llm-hub-[0-9a-f]{12}$/);
    expect(resolved.identity.config['hub_repo_id']).toBe('Qwen/Qwen3Guard-Gen-8B');
    expect(resolved.identity.config['hub_revision']).toBe(SHA);
    // The serving URL is NOT part of the pinned decision surface (the catalog
    // relocates dynamically; the immutable revision is what provenance pins).
    expect(resolved.identity.config['local_base_url']).toBeUndefined();
    // The identity went through the REAL registry gate.
    const registered = await services.registry.getVersion(
      resolved.identity.name,
      resolved.identity.version,
    );
    expect(registered?.status).toBe('deployed');
  });

  it('respects servedModelId (a GGUF re-serve) and keeps guard detection on the repo family', async () => {
    const resolver = createRoomModelResolver({
      services: makeServices(),
      catalog: catalogServing({ 'guard-gguf:q8': 'http://127.0.0.1:9001/v1' }),
      lanes: lanes(),
    });
    const resolved = await resolver.resolveModeration({
      ...GUARD_REF,
      servedModelId: 'guard-gguf:q8',
    });
    expect(resolved?.settings.modelId).toBe('guard-gguf:q8');
    expect(resolved?.format).toBe('qwen3guard');
  });

  it('adjudication resolution is always the strict-JSON dialect', async () => {
    const resolver = createRoomModelResolver({
      services: makeServices(),
      catalog: catalogServing({ 'Qwen/Qwen3.6-27B': 'http://127.0.0.1:9002/v1' }),
      lanes: lanes(),
    });
    const resolved = await resolver.resolveAdjudication(GENERAL_REF);
    expect(resolved?.format).toBe('json');
    expect(resolved?.backendId).toMatch(/^llm:governance-debate-llm-hub-[0-9a-f]{12}$/);
  });

  it('null on an unlocated model and under the hosted backend (hub models are local-only)', async () => {
    const unlocated = createRoomModelResolver({
      services: makeServices(),
      catalog: catalogServing({}),
      lanes: lanes(),
    });
    expect(await unlocated.resolveModeration(GUARD_REF)).toBeNull();
    const hosted = createRoomModelResolver({
      services: makeServices(),
      catalog: catalogServing({ 'Qwen/Qwen3Guard-Gen-8B': 'http://127.0.0.1:9001/v1' }),
      lanes: lanes('anthropic'),
    });
    expect(await hosted.resolveModeration(GUARD_REF)).toBeNull();
  });

  it('a WS-K gate fault resolves null (fire-safe, never a throw) and retries only after the cooldown', async () => {
    let nowMs = Date.parse('2026-07-01T00:00:00.000Z');
    const services = createInMemoryAiGovernanceServices(
      createInMemoryEventPipelineServices({ now: () => nowMs }),
      { now: () => nowMs },
    );
    // Break the registry so ensureGovernanceLlmDeployed faults.
    let registryDown = true;
    const realGet = services.registry.getVersion.bind(services.registry);
    services.registry.getVersion = async (name, version) => {
      if (registryDown) throw new Error('registry down');
      return realGet(name, version);
    };
    const resolver = createRoomModelResolver({
      services,
      catalog: catalogServing({ 'Qwen/Qwen3Guard-Gen-8B': 'http://127.0.0.1:9001/v1' }),
      lanes: lanes(),
    });
    expect(await resolver.resolveModeration(GUARD_REF)).toBeNull();
    // The registry recovers, but the cooldown still holds the retry back…
    registryDown = false;
    expect(await resolver.resolveModeration(GUARD_REF)).toBeNull();
    // …and after the cooldown the same selection resolves.
    nowMs += 61_000;
    expect(await resolver.resolveModeration(GUARD_REF)).not.toBeNull();
  });
});
