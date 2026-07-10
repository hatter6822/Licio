// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The ADR-3 provider port on the GovernanceService: with an injected LLM
// provider, facilitateSummary serves the provider's draft — conditioned by the
// room's member-ratified prompt and the bundle's template/style — while the
// capability gate, the audit log, and the deterministic FALLBACK on any
// provider failure stay exactly as before. The provider gains no authority:
// an ungranted capability refuses BEFORE the provider is ever consulted.
import { summarizeProposal } from '@licio/governance';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveGovernanceConfig } from '../governance/config.js';
import {
  createDeterministicNlProvider,
  type GovernanceNlProvider,
  type LawmakingSummaryRequest,
} from '../governance/nl-provider.js';
import type { GovernanceService } from '../governance/service.js';
import { createGovernanceService } from '../governance/services.js';
import { createInMemoryGovernanceStores, type GovernanceStores } from '../governance/stores.js';

const ROOM = 'room-law-llm';
const STEWARD = 'steward-law-llm';

const PROPOSAL = {
  proposalId: 'prop-llm-1',
  title: 'Adopt a weekly digest',
  body: 'An opt-in weekly digest of the room.',
  options: ['Yes', 'No'],
};

interface FakeLlm {
  provider: GovernanceNlProvider;
  requests: LawmakingSummaryRequest[];
  failNext: { on: boolean };
}

function makeFakeLlm(): FakeLlm {
  const requests: LawmakingSummaryRequest[] = [];
  const failNext = { on: false };
  return {
    requests,
    failNext,
    provider: {
      kind: 'llm',
      async summarizeProposal(request) {
        requests.push(request);
        if (failNext.on) throw new Error('backend unavailable');
        return {
          proposalId: request.proposal.proposalId,
          headline: 'LLM headline',
          optionCount: request.proposal.options.length,
          summary: 'LLM summary of the weekly digest proposal.',
        };
      },
    },
  };
}

interface Harness {
  svc: GovernanceService;
  stores: GovernanceStores;
}

function makeService(nlProvider?: GovernanceNlProvider): Harness {
  let n = 0;
  const stores = createInMemoryGovernanceStores();
  const svc = createGovernanceService({
    stores,
    config: resolveGovernanceConfig({}),
    now: () => new Date('2026-07-01T00:00:00.000Z'),
    uuid: () => `id-${++n}`,
    ...(nlProvider ? { nlProvider } : {}),
  });
  return { svc, stores };
}

/** A bundle clearing the admission gate, with a lawmaking template + style. */
function bundle(capabilities: string[]) {
  return {
    bundleId: 'law-llm',
    version: '1',
    name: 'Lawmaking-capable (LLM-conditioned)',
    moderationPrompt:
      'Route link-heavy, spammy, or otherwise suspicious contributions to human review; allow civil on-topic content.',
    promptTemplates: { 'lawmaking.summarize': 'Lead with what changes for members.' },
    config: { summaryStyle: 'neutral_detailed' },
    requestedCapabilities: capabilities,
  };
}

function lawPack(capabilities: string[]) {
  return {
    lawPackId: 'lp-llm',
    version: '1',
    allowedProposalTypes: ['model_prompt_approval'],
    permittedCapabilities: capabilities,
    treasury: {
      caps: [],
      minIntervalSeconds: 0,
      timelockSeconds: 0,
      materialThreshold: 0,
      requireCoiFor: [],
      investment: null,
    },
    election: {
      weightModel: 'one_civic_account_one_vote',
      perAccountCap: 1,
      minQuorum: 1,
      minTurnout: 0,
      termSeconds: 1,
    },
  };
}

async function activate(h: Harness, capabilities: string[]): Promise<void> {
  await h.svc.bootstrapSeat(ROOM, STEWARD);
  const lp = await h.svc.proposeLawPack(ROOM, STEWARD, lawPack(capabilities));
  if (!lp.ok) throw new Error('law-pack');
  const proposed = await h.svc.proposeModel(
    ROOM,
    STEWARD,
    bundle(capabilities),
    'The room prizes sourced, courteous argument.',
  );
  if (!proposed.ok) throw new Error('propose');
  await h.svc.evaluateModel(proposed.value.modelId);
  const approved = await h.svc.approveModel(ROOM, proposed.value.modelId, null, lp.value.lawPackId);
  if (!approved.ok) throw new Error('approve');
}

describe('GovernanceService.facilitateSummary — the ADR-3 provider port', () => {
  let llm: FakeLlm;
  let h: Harness;
  beforeEach(() => {
    llm = makeFakeLlm();
    h = makeService(llm.provider);
  });

  it('serves the LLM draft and logs it as the facilitation action', async () => {
    await activate(h, ['moderate.flag', 'lawmaking.summarize']);
    const res = await h.svc.facilitateSummary(ROOM, PROPOSAL);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.headline).toBe('LLM headline');
      expect(res.value.summary).toBe('LLM summary of the weekly digest proposal.');
      expect(res.value.proposalId).toBe(PROPOSAL.proposalId);
      expect(res.value.optionCount).toBe(2);
    }
    const actions = await h.svc.recentAgentActions(ROOM, 10);
    expect(actions[0]?.actionType).toBe('lawmaking.summarize');
    expect(actions[0]?.statementOfReasons).toBe('LLM summary of the weekly digest proposal.');
  });

  it('conditions the provider with the ratified room prompt + bundle template/style', async () => {
    await activate(h, ['moderate.flag', 'lawmaking.summarize']);
    await h.svc.facilitateSummary(ROOM, PROPOSAL);
    expect(llm.requests).toHaveLength(1);
    const request = llm.requests[0];
    expect(request?.roomId).toBe(ROOM);
    expect(request?.roomPromptText).toBe('The room prizes sourced, courteous argument.');
    expect(request?.promptTemplate).toBe('Lead with what changes for members.');
    expect(request?.summaryStyle).toBe('neutral_detailed');
  });

  it('falls back to the DETERMINISTIC summary when the provider throws (and still audits)', async () => {
    await activate(h, ['moderate.flag', 'lawmaking.summarize']);
    llm.failNext.on = true;
    const res = await h.svc.facilitateSummary(ROOM, PROPOSAL);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const deterministic = summarizeProposal({ ...PROPOSAL });
      expect(res.value).toEqual(deterministic);
    }
    const actions = await h.svc.recentAgentActions(ROOM, 10);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.actionType).toBe('lawmaking.summarize');
  });

  it('never consults the provider without the granted capability (authority outside the model)', async () => {
    await activate(h, ['moderate.flag']); // no lawmaking capability
    const res = await h.svc.facilitateSummary(ROOM, PROPOSAL);
    expect(!res.ok && res.code).toBe('no_capability');
    expect(llm.requests).toHaveLength(0);
  });

  it('never consults the provider for an invalid proposal', async () => {
    await activate(h, ['moderate.flag', 'lawmaking.summarize']);
    const res = await h.svc.facilitateSummary(ROOM, { title: 'missing id' });
    expect(!res.ok && res.code).toBe('invalid_proposal');
    expect(llm.requests).toHaveLength(0);
  });

  it('an injected deterministic provider keeps the pure path (no provider call, identical output)', async () => {
    const det = makeService(createDeterministicNlProvider());
    await activate(det, ['moderate.flag', 'lawmaking.summarize']);
    const res = await det.svc.facilitateSummary(ROOM, PROPOSAL);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual(summarizeProposal({ ...PROPOSAL }));
  });
});
