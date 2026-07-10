// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The LLM-backed summariser registers + deploys through the REAL WS-K gate
// (risk assessment + lineage + evaluation harness + registry deployment gate),
// idempotently and self-sufficiently (no dependence on the dev seed having
// run). Each backend carries its own registry identity with an honest model
// card — and secrets (the API key) NEVER enter the hashed identity config.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GOVERNANCE_LLM_SETTINGS,
  type GovernanceLlmBackend,
  type GovernanceLlmSettings,
} from '../ai-governance/llm/config.js';
import {
  buildGovernanceLlmIdentity,
  buildGovernanceModerationProposerIdentity,
  ensureGovernanceLlmDeployed,
  GOVERNANCE_LLM_LINEAGE_ID,
} from '../ai-governance/llm/registration.js';
import { seedAiGovernance } from '../ai-governance/seed.js';
import {
  type AiGovernanceServices,
  createInMemoryAiGovernanceServices,
} from '../ai-governance/services.js';
import { createInMemoryEventPipelineServices } from '../events/services.js';

const NOW = () => Date.parse('2026-07-01T00:00:00.000Z');
const SETTINGS: GovernanceLlmSettings = { ...DEFAULT_GOVERNANCE_LLM_SETTINGS };
const API_KEY = 'sk-ant-secret-key-never-recorded';
const LOCAL_URL = 'http://127.0.0.1:11434/v1';
const ANTHROPIC = { kind: 'anthropic', apiKey: API_KEY } as const satisfies GovernanceLlmBackend;
const LOCAL = { kind: 'local', baseUrl: LOCAL_URL } as const satisfies GovernanceLlmBackend;

function freshServices(): AiGovernanceServices {
  const events = createInMemoryEventPipelineServices({ now: NOW });
  return createInMemoryAiGovernanceServices(events, { now: NOW });
}

let services: AiGovernanceServices;
beforeEach(() => {
  services = freshServices();
});

describe('ensureGovernanceLlmDeployed (the real WS-K gate)', () => {
  it('registers and DEPLOYS the model without the seed having run (self-sufficient)', async () => {
    const identity = buildGovernanceLlmIdentity(SETTINGS, ANTHROPIC);
    expect(await ensureGovernanceLlmDeployed(services, identity)).toBe(true);

    const registered = await services.registry.getVersion(identity.name, identity.version);
    expect(registered?.status).toBe('deployed');
    expect(registered?.deployed_at).not.toBeNull();

    // The gate preconditions were satisfied by the ensure itself.
    expect(await services.lineage.get(GOVERNANCE_LLM_LINEAGE_ID, '1.0.0')).not.toBeNull();
    const decision = await services.evaluations.latest(identity.name, identity.version);
    expect(decision?.decision).toBe('deploy');
  });

  it('is idempotent: a second call neither re-registers nor duplicates versions', async () => {
    const identity = buildGovernanceLlmIdentity(SETTINGS, ANTHROPIC);
    expect(await ensureGovernanceLlmDeployed(services, identity)).toBe(true);
    expect(await ensureGovernanceLlmDeployed(services, identity)).toBe(true);
    expect(await services.registry.listVersions(identity.name)).toHaveLength(1);
  });

  it('coexists with the standard seed (no name/lineage collisions)', async () => {
    await seedAiGovernance(services);
    const identity = buildGovernanceLlmIdentity(SETTINGS, ANTHROPIC);
    expect(await ensureGovernanceLlmDeployed(services, identity)).toBe(true);
    // The deterministic governance summariser stays deployed alongside it.
    expect((await services.registry.getDeployed('governance-summarizer'))?.status).toBe('deployed');
    expect((await services.registry.getDeployed(identity.name))?.status).toBe('deployed');
  });

  it('each backend + config carries its own registry identity, so a switch never leaves a stale card', async () => {
    const anthropic = buildGovernanceLlmIdentity(SETTINGS, ANTHROPIC);
    const local = buildGovernanceLlmIdentity({ ...SETTINGS, modelId: 'llama3.3:70b' }, LOCAL);
    // The name folds in a config hash: distinct backend (and config) ⇒ distinct name.
    expect(anthropic.name).toMatch(/^governance-summarizer-llm-anthropic-[0-9a-f]{12}$/);
    expect(local.name).toMatch(/^governance-summarizer-llm-local-[0-9a-f]{12}$/);
    expect(anthropic.name).not.toBe(local.name);
    expect(await ensureGovernanceLlmDeployed(services, anthropic)).toBe(true);
    expect(await ensureGovernanceLlmDeployed(services, local)).toBe(true);
    expect((await services.registry.getDeployed(anthropic.name))?.status).toBe('deployed');
    expect((await services.registry.getDeployed(local.name))?.status).toBe('deployed');
  });

  it('a CHANGED config mints a new identity that re-clears the WS-K gate (R2-1)', async () => {
    const before = buildGovernanceLlmIdentity(SETTINGS, ANTHROPIC);
    const after = buildGovernanceLlmIdentity(
      { ...SETTINGS, modelId: 'claude-haiku-4-5' },
      ANTHROPIC,
    );
    // Same backend, different model ⇒ different config hash ⇒ different name, so
    // ensureGovernanceLlmDeployed cannot early-return the old (stale) card.
    expect(after.name).not.toBe(before.name);
    expect(await ensureGovernanceLlmDeployed(services, before)).toBe(true);
    expect(await ensureGovernanceLlmDeployed(services, after)).toBe(true);
    const beforeCard = await services.registry.getVersion(before.name, before.version);
    const afterCard = await services.registry.getVersion(after.name, after.version);
    expect(beforeCard?.card.name).toBe(before.name);
    expect(afterCard?.card.name).toBe(after.name);
    // Each ran its own admission (a distinct evaluation record per identity).
    expect((await services.evaluations.latest(after.name, after.version))?.decision).toBe('deploy');
  });

  it('anthropic: honest card; the API key NEVER enters the hashed identity config', async () => {
    const settings: GovernanceLlmSettings = { ...SETTINGS, modelId: 'claude-haiku-4-5' };
    const identity = buildGovernanceLlmIdentity(settings, ANTHROPIC);
    expect(identity.config['model_id']).toBe('claude-haiku-4-5');
    expect(identity.config['method']).toBe('hosted-llm');
    expect(identity.config['provider']).toBe('anthropic');
    expect(typeof identity.config['system_prompt_version']).toBe('number');
    expect(typeof identity.config['quality_gate_version']).toBe('number');
    expect(JSON.stringify(identity.config)).not.toContain(API_KEY);

    expect(await ensureGovernanceLlmDeployed(services, identity)).toBe(true);
    const registered = await services.registry.getVersion(identity.name, identity.version);
    expect(registered?.card.training_data_summary).toContain('Externally hosted');
    expect(registered?.card.limitations).toContain('Stochastic hosted backend');
    expect(registered?.card.limitations).toContain('explicit operator opt-in');
    expect(registered?.card.use_case_id).toBe('governance_assistance');
    expect(JSON.stringify(registered?.card)).not.toContain(API_KEY);
  });

  it('local: honest card; the loopback base URL is pinned into the config surface', async () => {
    const settings: GovernanceLlmSettings = { ...SETTINGS, modelId: 'llama3.3:70b' };
    const identity = buildGovernanceLlmIdentity(settings, LOCAL);
    expect(identity.config['method']).toBe('local-llm');
    expect(identity.config['provider']).toBe('local');
    expect(identity.config['local_base_url']).toBe(LOCAL_URL);
    expect(identity.config['model_id']).toBe('llama3.3:70b');

    expect(await ensureGovernanceLlmDeployed(services, identity)).toBe(true);
    const registered = await services.registry.getVersion(identity.name, identity.version);
    expect(registered?.card.training_data_summary).toContain('Locally hosted');
    expect(registered?.card.training_data_summary).toContain('loopback-only');
    expect(registered?.card.limitations).toContain('Stochastic locally hosted backend');
  });

  it('deploys the in-room moderation model through the same gate with its own identity + card', async () => {
    const identity = buildGovernanceModerationProposerIdentity(SETTINGS, ANTHROPIC);
    expect(identity.name).toMatch(/^governance-moderation-llm-anthropic-[0-9a-f]{12}$/);
    expect(identity.useCaseId).toBe('toxicity_safety_triage');
    expect(identity.modalities).toEqual(['classification']);
    expect(typeof identity.config['system_prompt_version']).toBe('number');

    // A high-risk classification model needs the FULL harness set — it must
    // still clear the real deployment gate.
    expect(await ensureGovernanceLlmDeployed(services, identity)).toBe(true);
    const registered = await services.registry.getVersion(identity.name, identity.version);
    expect(registered?.status).toBe('deployed');
    expect(registered?.card.use_case_id).toBe('toxicity_safety_triage');
    expect(registered?.card.purpose).toContain('in-room moderation model');
    expect(registered?.card.purpose).toContain('escalate-to-human-review');

    // It coexists with the summariser (distinct registry identity).
    const summariser = buildGovernanceLlmIdentity(SETTINGS, ANTHROPIC);
    expect(await ensureGovernanceLlmDeployed(services, summariser)).toBe(true);
    expect((await services.registry.getDeployed(summariser.name))?.status).toBe('deployed');
    expect((await services.registry.getDeployed(identity.name))?.status).toBe('deployed');
  });
});
