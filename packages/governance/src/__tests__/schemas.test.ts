// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { canonicalize } from '../canonical-json.js';
import { lawPackSchema } from '../schemas/law-pack.js';
import { governancePolicyBundleSchema } from '../schemas/policy-bundle.js';
import { treasuryActionSchema, verdictSchema } from '../schemas/treasury.js';

describe('canonicalize', () => {
  it('is independent of object key order but preserves array order', () => {
    expect(canonicalize({ b: 1, a: { d: 4, c: 3 } })).toBe(
      canonicalize({ a: { c: 3, d: 4 }, b: 1 }),
    );
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalize('x')).toBe('"x"');
    expect(canonicalize(null)).toBe('null');
  });
});

describe('schemas', () => {
  it('parses a valid governance policy bundle', () => {
    const bundle = governancePolicyBundleSchema.parse({
      bundleId: 'b1',
      version: '1.0.0',
      name: 'Civility model',
      moderationPrompt: 'Flag uncivil or off-topic contributions for human review.',
      promptTemplates: { summary: 'Summarize: {{proposal}}' },
      config: {},
      requestedCapabilities: ['moderate.remove'],
    });
    expect(bundle.config.summaryStyle).toBe('neutral_brief');
    expect(bundle.requestedCapabilities).toEqual(['moderate.remove']);
  });

  it('rejects an unknown capability and a missing moderation prompt', () => {
    expect(
      governancePolicyBundleSchema.safeParse({
        bundleId: 'b',
        version: '1',
        name: 'x',
        moderationPrompt: 'be civil',
        promptTemplates: {},
        config: {},
        requestedCapabilities: ['floor.override_platform_safety'],
      }).success,
    ).toBe(false);
    // The moderation prompt is required (it IS the model the community ratifies).
    expect(
      governancePolicyBundleSchema.safeParse({
        bundleId: 'b',
        version: '1',
        name: 'x',
        promptTemplates: {},
        config: {},
        requestedCapabilities: ['moderate.flag'],
      }).success,
    ).toBe(false);
  });

  it('parses a law-pack and validates verdict + treasury action shapes', () => {
    const lp = lawPackSchema.parse({
      lawPackId: 'lp1',
      version: '1',
      allowedProposalTypes: ['charter_amendment'],
      permittedCapabilities: ['moderate.remove', 'treasury.report'],
      treasury: {
        caps: [{ category: 'grant', perActionMax: 1, perWindowMax: 1, windowSeconds: 1 }],
        minIntervalSeconds: 0,
        timelockSeconds: 0,
        materialThreshold: 0,
        requireCoiFor: [],
        investment: null,
      },
      election: {
        weightModel: 'one_civic_account_one_vote',
        minQuorum: 1,
        minTurnout: 0,
        termSeconds: 1,
      },
    });
    expect(lp.election.perAccountCap).toBe(1); // default applied
    expect(verdictSchema.parse({ accepted: true, evidence: { checks: [] } }).accepted).toBe(true);
    expect(
      treasuryActionSchema.safeParse({
        actionId: 'a',
        roomId: 'r',
        category: 'grant',
        amount: 1,
        asset: null,
        timestamp: 'not-a-date',
        proposedAt: '2026-06-19T00:00:00.000Z',
        coiDeclared: true,
        proposalRef: null,
      }).success,
    ).toBe(false);
  });
});
