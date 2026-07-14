// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M slice-4 foundation: the chained audit writer, the versioned charter,
// law-pack registration/validation/adoption, the freeze/pause guard, the
// extended readiness checklist, and the full mode-transition machine.

import type { LawPack } from '@licio/governance';
import type { GovernanceMode } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import {
  InMemoryBindingStore,
  InMemoryLawPackStore,
  InMemoryModelStore,
  InMemorySeatStore,
} from '../governance/stores.js';
import { InMemoryAuditStore } from '../identity/audit.js';
import { DEFAULT_KNOMOSIS_CONFIG } from '../knomosis/config.js';
import { defaultCompliancePort, defaultRegionResolverPort } from '../knomosis/ports.js';
import type { RoomModePort } from '../knomosis/readiness.js';
import { InMemoryComprehensionStore, InMemoryGovernanceAuditStore } from '../knomosis/stores.js';
import { appendChainedAudit, computeEntryHash, verifyAuditChain } from '../treasury/audit-chain.js';
import { charterContentHash, createCharterVersion } from '../treasury/charter.js';
import {
  activeLawPack,
  adoptLawPack,
  registerLawPack,
  validateLawPackDocument,
} from '../treasury/law-packs.js';
import {
  assertGovernanceWritable,
  ensureProfile,
  setGovernanceFreeze,
  setGovernancePause,
} from '../treasury/profile.js';
import {
  buildWsmReadinessChecklistPort,
  evaluateWsmReadiness,
  recordReadinessAttestation,
  requestWsmModeTransition,
  type WsmReadinessDeps,
} from '../treasury/readiness.js';
import {
  InMemoryAttestationStore,
  InMemoryCharterStore,
  InMemoryGovernanceProfileStore,
  InMemoryTreasuryStore,
} from '../treasury/stores.js';

const ROOM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STEWARD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const SECTION =
  'This section is written in plain language. It explains the rule simply. Everyone can read it.';
const SECTIONS = {
  purpose: SECTION,
  decision_making: SECTION,
  fund_management: SECTION,
  member_rights: SECTION,
  dispute_resolution: SECTION,
  amendment_process: SECTION,
  safety_override_acknowledgment: SECTION,
  appeals_path: SECTION,
};

/** A complete WS-M law-pack document + covering fixture corpus. */
const fullLawPackDocument = (): Record<string, unknown> => ({
  lawPackId: 'placeholder',
  version: '1.0.0',
  allowedProposalTypes: ['capped_grant'],
  permittedCapabilities: ['treasury.grant'],
  treasury: {
    caps: [
      { category: 'grant', perActionMax: '1000', perWindowMax: '5000', windowSeconds: 86_400 },
    ],
    minIntervalSeconds: 0,
    timelockSeconds: 3_600,
    materialThreshold: '500',
    requireCoiFor: ['grant'],
    investment: null,
  },
  election: {
    weightModel: 'one_civic_account_one_vote',
    perAccountCap: 1,
    minQuorum: 1,
    minTurnout: 0,
    termSeconds: 31_536_000,
  },
  humanSummary: 'Grants up to 1000 minor units with COI review.',
  quorumRules: { capped_grant: { basis: 'eligible_voters', minFraction: 0.2 } },
  thresholdRules: { capped_grant: { minAffirmativeFraction: 0.5 } },
  timelockRules: { capped_grant: { seconds: 172_800 } },
  weightModel: 'one_civic_account_one_vote',
  maxVotingWeightPerAccount: 1,
  eligibility: {
    minMembershipDays: 0,
    minContributions: 0,
    requireVerifiedIdentity: false,
    newWalletCoolingOffDays: 7,
  },
  coiRequirements: {
    disclosureTriggers: ['financial relationship'],
    recusalRequired: true,
    independentReviewFor: ['capped_grant'],
  },
  appealRules: {
    whoCanAppeal: ['any_member'],
    timelineSeconds: 604_800,
    process: 'Platform floor.',
  },
  forkExitRules: {
    conditions: 'Supermajority.',
    process: 'Fork.',
    fundHandling: 'Return deposits.',
  },
  emergencyConstraints: { freezeTriggers: ['divergence'], escalation: 'Platform security.' },
  actionBudgetRules: {
    costs: { proposal_submission: 5 },
    refill: { periodSeconds: 86_400, units: 10, max: 100 },
  },
  testFixtureCorpusRef: 'corpus-1',
});

const fixtureCorpus = (): Record<string, unknown> => ({
  fixtures: [
    {
      kind: 'treasury_action',
      label: 'grant within caps accepts',
      action: {
        category: 'grant',
        amount: '900',
        asset: 'USDC',
        coiDeclared: true,
        proposedAt: '2026-07-01T00:00:00.000Z',
        targetAllocation: null,
      },
      history: [],
      now: '2026-07-02T00:00:00.000Z',
      expect: 'accepted',
    },
    {
      kind: 'proposal_tally',
      label: 'grant passes majority',
      proposalType: 'capped_grant',
      votes: [
        { voterUserId: 'a', choice: 'approve', weightSnapshot: 1 },
        { voterUserId: 'b', choice: 'approve', weightSnapshot: 1 },
        { voterUserId: 'c', choice: 'reject', weightSnapshot: 1 },
      ],
      eligibleCount: 10,
      deadlinePassed: true,
      expect: 'passed',
    },
    {
      kind: 'eligibility',
      label: 'cooling-off recusal',
      facts: {
        userId: 'v1',
        membershipDays: 60,
        contributionCount: 10,
        verifiedIdentity: true,
        newestWalletAgeDays: 2,
        walletClusterId: null,
        hasDisclosedConflict: false,
        roleClasses: [],
        reputationScore: 0,
        tokenVoteUnits: 0,
        isDesignatedSigner: false,
      },
      treasuryControlling: true,
      recusalRequired: false,
      clustersAlreadyVoted: [],
      expect: 'wallet_cooling_off',
    },
  ],
});

function buildDeps(overrides: Partial<WsmReadinessDeps> = {}): WsmReadinessDeps & {
  mode: { value: GovernanceMode };
} {
  let clock = Date.parse('2026-07-13T00:00:00.000Z');
  const mode = { value: 'ordinary' as GovernanceMode };
  const roomMode: RoomModePort = {
    currentMode: async () => mode.value,
    setMode: async (_r, m) => {
      mode.value = m;
      return true;
    },
    setModeIf: async (_r, expected, next) => {
      if (mode.value !== expected) return false;
      mode.value = next;
      return true;
    },
  };
  const deps: WsmReadinessDeps = {
    profiles: new InMemoryGovernanceProfileStore(),
    treasuries: new InMemoryTreasuryStore(),
    charters: new InMemoryCharterStore(),
    attestations: new InMemoryAttestationStore(),
    rooms: {
      roomGovernance: async () => ({ mode: mode.value, name: 'Test Room' }),
      isMember: async () => true,
      isSteward: async () => true,
      contentVisibleToUser: async () => true,
    },
    lawPacks: new InMemoryLawPackStore(),
    seats: new InMemorySeatStore(),
    bindings: new InMemoryBindingStore(),
    models: new InMemoryModelStore(),
    comprehension: new InMemoryComprehensionStore(),
    governanceAudit: new InMemoryGovernanceAuditStore(),
    compliance: defaultCompliancePort,
    regionResolver: defaultRegionResolverPort,
    roomMode,
    identityAudit: new InMemoryAuditStore(),
    config: () => ({ ...DEFAULT_KNOMOSIS_CONFIG }),
    now: () => {
      clock += 1;
      return clock;
    },
    uuid: () => crypto.randomUUID(),
    ...overrides,
  };
  return Object.assign(deps, { mode });
}

/** Bring a room to a fully-ready state for testnet. */
async function makeTestnetReady(deps: WsmReadinessDeps & { mode: { value: GovernanceMode } }) {
  await createCharterVersion(deps, { roomId: ROOM, sections: SECTIONS, actorUserId: STEWARD });
  await deps.seats.put({
    roomId: ROOM,
    holderUserId: STEWARD,
    termStart: '2026-07-01T00:00:00.000Z',
    termEnd: '2027-07-01T00:00:00.000Z',
    bootstrap: true,
    currentElectionId: null,
    updatedAt: '2026-07-01T00:00:00.000Z',
  });
  const registered = await registerLawPack(deps, {
    roomId: ROOM,
    document: fullLawPackDocument(),
    fixtures: fixtureCorpus(),
    actorUserId: STEWARD,
  });
  if (!('ok' in registered) || registered.ok !== true) throw new Error('law pack should register');
  await adoptLawPack(deps, {
    roomId: ROOM,
    lawPackId: registered.record.lawPackId,
    actorUserId: STEWARD,
  });
  await recordReadinessAttestation(deps, {
    roomId: ROOM,
    item: 'safety_override_acknowledged',
    note: 'Platform-moderation supremacy acknowledged.',
    actorUserId: STEWARD,
    isPlatformStaff: false,
  });
  await deps.comprehension.record(STEWARD, '1', true, '2026-07-01T00:00:00.000Z');
  for (let i = 0; i < DEFAULT_KNOMOSIS_CONFIG.readinessMinSimActions; i += 1) {
    await deps.governanceAudit.append({
      entryId: crypto.randomUUID(),
      roomId: ROOM,
      actionType: 'vote_cast',
      actorUserId: STEWARD,
      actionDetails: {},
      simulationMode: true,
      createdAt: '2026-07-01T00:00:00.000Z',
    });
  }
}

describe('audit chain (WS-M.4.3c)', () => {
  it('appends a verifiable genesis + children and verifies the chain', async () => {
    const deps = buildDeps();
    const first = await appendChainedAudit(deps, {
      roomId: ROOM,
      actionType: 'charter_version_created',
      actorUserId: STEWARD,
      details: { version: 1 },
    });
    expect(first.prevHash).toBeNull();
    const second = await appendChainedAudit(deps, {
      roomId: ROOM,
      actionType: 'law_pack_registered',
      actorUserId: STEWARD,
      details: { version: '1.0.0' },
    });
    expect(second.prevHash).toBe(first.integrityHash);
    const verification = await verifyAuditChain(deps, ROOM);
    expect(verification).toMatchObject({ valid: true, chainedEntries: 2 });
  });

  it('hashes are deterministic, tamper-evident, and BIND the attribution (W13)', async () => {
    const ACTOR_A = '88888888-8888-4888-8888-888888888888';
    const ACTOR_B = '99999999-9999-4999-8999-999999999999';
    const hash = computeEntryHash(
      null,
      'charter_version_created',
      { a: 1 },
      'T',
      ROOM,
      ACTOR_A,
      null,
      null,
    );
    expect(hash).toBe(
      computeEntryHash(null, 'charter_version_created', { a: 1 }, 'T', ROOM, ACTOR_A, null, null),
    );
    expect(hash).not.toBe(
      computeEntryHash(null, 'charter_version_created', { a: 2 }, 'T', ROOM, ACTOR_A, null, null),
    );
    // Re-attributing the actor or the proposal/treasury refs changes the hash.
    expect(hash).not.toBe(
      computeEntryHash(null, 'charter_version_created', { a: 1 }, 'T', ROOM, ACTOR_B, null, null),
    );
    expect(hash).not.toBe(
      computeEntryHash(null, 'charter_version_created', { a: 1 }, 'T', ROOM, ACTOR_A, 'p-1', null),
    );
  });

  it('detects a tampered chain on verification', async () => {
    const deps = buildDeps();
    await appendChainedAudit(deps, {
      roomId: ROOM,
      actionType: 'charter_version_created',
      actorUserId: STEWARD,
      details: { version: 1 },
    });
    // Tamper: append a forged chained row directly with a wrong hash.
    await deps.governanceAudit.appendChained({
      entryId: crypto.randomUUID(),
      roomId: ROOM,
      actionType: 'law_pack_registered',
      actorUserId: null,
      actionDetails: { forged: true },
      simulationMode: false,
      createdAt: new Date().toISOString(),
      prevHash: (await deps.governanceAudit.chainHead(ROOM))?.integrityHash ?? null,
      integrityHash: `0x${'f'.repeat(64)}`,
    });
    const verification = await verifyAuditChain(deps, ROOM);
    expect(verification.valid).toBe(false);
    expect(verification.problems.some((p) => p.includes('does not recompute'))).toBe(true);
  });

  it('two children of one parent collide (fork-proof)', async () => {
    const deps = buildDeps();
    const genesis = await appendChainedAudit(deps, {
      roomId: ROOM,
      actionType: 'charter_version_created',
      actorUserId: null,
      details: {},
    });
    const forged = await deps.governanceAudit.appendChained({
      entryId: crypto.randomUUID(),
      roomId: ROOM,
      actionType: 'law_pack_registered',
      actorUserId: null,
      actionDetails: {},
      simulationMode: false,
      createdAt: new Date().toISOString(),
      prevHash: null, // second genesis
      integrityHash: `0x${'e'.repeat(64)}`,
    });
    expect(forged).toBeNull();
    const child = await appendChainedAudit(deps, {
      roomId: ROOM,
      actionType: 'law_pack_registered',
      actorUserId: null,
      details: {},
    });
    expect(child.prevHash).toBe(genesis.integrityHash);
  });
});

describe('charter versions (WS-M.1.2a)', () => {
  it('publishes sequential hash-committed versions and links the profile', async () => {
    const deps = buildDeps();
    const v1 = await createCharterVersion(deps, {
      roomId: ROOM,
      sections: SECTIONS,
      actorUserId: STEWARD,
    });
    expect(v1).toMatchObject({ ok: true });
    if (!('charter' in v1)) throw new Error('expected charter');
    expect(v1.charter.version).toBe(1);
    expect(v1.charter.contentHash).toBe(charterContentHash(v1.charter.sections));
    const v2 = await createCharterVersion(deps, {
      roomId: ROOM,
      sections: { ...SECTIONS, purpose: `${SECTION} Updated purpose text here.` },
      actorUserId: STEWARD,
    });
    if (!('charter' in v2)) throw new Error('expected charter');
    expect(v2.charter.version).toBe(2);
    const profile = await ensureProfile(deps, ROOM);
    expect(profile.charterVersionId).toBe(v2.charter.charterVersionId);
    expect((await deps.charters.listByRoom(ROOM)).map((c) => c.version)).toEqual([2, 1]);
  });

  it('rejects an incomplete charter with the missing sections named', async () => {
    const deps = buildDeps();
    const { appeals_path, ...missing } = SECTIONS;
    void appeals_path;
    const result = await createCharterVersion(deps, {
      roomId: ROOM,
      sections: missing,
      actorUserId: STEWARD,
    });
    expect(result).toMatchObject({ ok: false, code: 'charter_incomplete' });
    if (!('message' in result)) throw new Error('expected error');
    expect(result.message).toContain('appeals_path');
  });

  it('rejects legalese walls (readability heuristic)', async () => {
    const deps = buildDeps();
    const wall = `${'whereas the party of the first part shall '.repeat(30)}end`;
    const result = await createCharterVersion(deps, {
      roomId: ROOM,
      sections: { ...SECTIONS, dispute_resolution: wall },
      actorUserId: STEWARD,
    });
    expect(result).toMatchObject({ ok: false, code: 'charter_unreadable' });
  });
});

describe('law-pack registration + adoption (WS-M.1.3)', () => {
  it('registers a fully-valid pack with a recomputable hash commitment', async () => {
    const deps = buildDeps();
    const result = await registerLawPack(deps, {
      roomId: ROOM,
      document: fullLawPackDocument(),
      fixtures: fixtureCorpus(),
      actorUserId: STEWARD,
    });
    expect(result).toMatchObject({ ok: true });
    if (!('record' in result)) throw new Error('expected record');
    expect(result.record.published).toBe(true);
    expect(result.hashCommitment).toMatch(/^[0-9a-f]{64}$/);
    const stored = result.record.lawPack as LawPack;
    expect(stored.hashCommitment).toBe(result.hashCommitment);
  });

  it('rejects structural problems and fixture failures fail-closed', async () => {
    const deps = buildDeps();
    const overlapping = fullLawPackDocument();
    overlapping['disallowedProposalTypes'] = ['capped_grant'];
    expect(
      await registerLawPack(deps, {
        roomId: ROOM,
        document: overlapping,
        fixtures: null,
        actorUserId: STEWARD,
      }),
    ).toMatchObject({ ok: false, code: 'law_pack_invalid' });

    const badCorpus = fixtureCorpus();
    (badCorpus['fixtures'] as Record<string, unknown>[])[0] = {
      ...(badCorpus['fixtures'] as Record<string, unknown>[])[0],
      expect: 'per_window_cap_exceeded',
    } as Record<string, unknown>;
    expect(
      await registerLawPack(deps, {
        roomId: ROOM,
        document: fullLawPackDocument(),
        fixtures: badCorpus,
        actorUserId: STEWARD,
      }),
    ).toMatchObject({ ok: false, code: 'law_pack_fixtures_failed' });
  });

  it('adoption pins the profile refs; foreign/unpublished packs reject', async () => {
    const deps = buildDeps();
    const registered = await registerLawPack(deps, {
      roomId: ROOM,
      document: fullLawPackDocument(),
      fixtures: fixtureCorpus(),
      actorUserId: STEWARD,
    });
    if (!('record' in registered)) throw new Error('expected record');
    const adopted = await adoptLawPack(deps, {
      roomId: ROOM,
      lawPackId: registered.record.lawPackId,
      actorUserId: STEWARD,
    });
    expect(adopted).toMatchObject({ ok: true });
    const profile = await ensureProfile(deps, ROOM);
    expect(profile.lawPackId).toBe(registered.record.lawPackId);
    expect(profile.quorumPolicyRef).toEqual({
      lawPackId: registered.record.lawPackId,
      section: 'quorumRules',
    });
    const active = await activeLawPack(deps, ROOM);
    expect(active?.pack.treasury.caps).toHaveLength(1);
    expect(
      await adoptLawPack(deps, {
        roomId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        lawPackId: registered.record.lawPackId,
        actorUserId: STEWARD,
      }),
    ).toMatchObject({ ok: false, code: 'law_pack_not_found' });
  });

  it('validateLawPackDocument reports zod shape problems structurally', () => {
    const report = validateLawPackDocument({ not: 'a pack' }, null);
    expect(report.pack).toBeNull();
    expect(report.structuralProblems.length).toBeGreaterThan(0);
  });
});

describe('freeze, pause, and the writability guard (WS-M.2.4a/b)', () => {
  it('a room freeze blocks every operation with safe status text', async () => {
    const deps = buildDeps();
    const frozen = await setGovernanceFreeze(deps, {
      roomId: ROOM,
      action: 'freeze',
      scope: 'room',
      source: 'platform_security',
      reason: 'Paused pending review.',
      actorUserId: STEWARD,
      isPlatformStaff: true,
    });
    expect(frozen).toMatchObject({ ok: true });
    for (const op of ['deposits', 'proposals', 'executions', 'voting', 'configuration'] as const) {
      const denial = await assertGovernanceWritable(deps, ROOM, op);
      expect(denial).toMatchObject({ code: 'governance_frozen' });
      expect(denial?.message).not.toContain('compromise');
    }
  });

  it('granular pause blocks only its own operation class', async () => {
    const deps = buildDeps();
    await setGovernancePause(deps, {
      roomId: ROOM,
      patch: { deposits: true },
      reason: 'maintenance',
      actorUserId: STEWARD,
    });
    expect(await assertGovernanceWritable(deps, ROOM, 'deposits')).toMatchObject({
      code: 'deposits_paused',
    });
    expect(await assertGovernanceWritable(deps, ROOM, 'proposals')).toBeNull();
    expect(await assertGovernanceWritable(deps, ROOM, 'voting')).toBeNull();
  });

  it('stewards can freeze but never unfreeze; platform sources need staff', async () => {
    const deps = buildDeps();
    expect(
      await setGovernanceFreeze(deps, {
        roomId: ROOM,
        action: 'freeze',
        scope: 'room',
        source: 'steward',
        reason: 'Anomalous activity.',
        actorUserId: STEWARD,
        isPlatformStaff: false,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await setGovernanceFreeze(deps, {
        roomId: ROOM,
        action: 'unfreeze',
        scope: 'room',
        source: 'steward',
        reason: 'All clear.',
        actorUserId: STEWARD,
        isPlatformStaff: false,
      }),
    ).toMatchObject({ ok: false, code: 'platform_review_required' });
    expect(
      await setGovernanceFreeze(deps, {
        roomId: ROOM,
        action: 'freeze',
        scope: 'room',
        source: 'legal',
        reason: 'Court order.',
        actorUserId: STEWARD,
        isPlatformStaff: false,
      }),
    ).toMatchObject({ ok: false, code: 'source_not_authorized' });
  });
});

describe('extended readiness (WS-M.1.2e)', () => {
  it('a fresh room fails every required testnet item with actionable text', async () => {
    const deps = buildDeps();
    const result = await evaluateWsmReadiness(deps, ROOM, STEWARD, 'testnet');
    expect(result.ready).toBe(false);
    const codes = result.unmet.map((u) => u.requirement);
    expect(codes).toEqual(
      expect.arrayContaining([
        'charter_present',
        'stewards_designated',
        'treasury_policy_defined',
        'safety_override_acknowledged',
        'comprehension_passed',
        'simulation_track_record',
        'law_pack_valid',
      ]),
    );
    // Production-only items must NOT block a testnet evaluation.
    expect(codes).not.toContain('jurisdiction_supported');
    expect(codes).not.toContain('external_audit_passed');
  });

  it('a fully-prepared room passes testnet but fails capped production on jurisdiction (fail-closed WS-N seam)', async () => {
    const deps = buildDeps();
    await makeTestnetReady(deps);
    const testnet = await evaluateWsmReadiness(deps, ROOM, STEWARD, 'testnet');
    expect(testnet.unmet).toEqual([]);
    expect(testnet.ready).toBe(true);
    const capped = await evaluateWsmReadiness(deps, ROOM, STEWARD, 'capped_production');
    expect(capped.ready).toBe(false);
    expect(capped.unmet.map((u) => u.requirement)).toContain('jurisdiction_supported');
  });

  it('governance_model_ratified is not_applicable without AI governance and fails with an unratified model', async () => {
    const deps = buildDeps();
    await makeTestnetReady(deps);
    let items = (await evaluateWsmReadiness(deps, ROOM, STEWARD, 'testnet')).items;
    expect(items.find((i) => i.requirement === 'governance_model_ratified')?.status).toBe(
      'not_applicable',
    );
    await deps.models.insert({
      modelId: crypto.randomUUID(),
      roomId: ROOM,
      artifactDigest: 'digest-1',
      bundle: {
        bundleId: 'bundle-1',
        version: '1',
        name: 'test bundle',
        moderationPrompt: 'moderate fairly',
        promptTemplates: {},
        config: { summaryStyle: 'neutral_brief', explanationVerbosity: 'standard' },
        requestedCapabilities: [],
      },
      cardRef: null,
      proposedByUserId: STEWARD,
      status: 'proposed',
      evaluationRef: null,
      admittedBackendId: null,
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    items = (await evaluateWsmReadiness(deps, ROOM, STEWARD, 'testnet')).items;
    expect(items.find((i) => i.requirement === 'governance_model_ratified')?.status).toBe('fail');
  });

  it('external audit is attestable by platform staff only', async () => {
    const deps = buildDeps();
    expect(
      await recordReadinessAttestation(deps, {
        roomId: ROOM,
        item: 'external_audit_passed',
        note: 'Audit report ref.',
        actorUserId: STEWARD,
        isPlatformStaff: false,
      }),
    ).toMatchObject({ ok: false, code: 'platform_review_required' });
    expect(
      await recordReadinessAttestation(deps, {
        roomId: ROOM,
        item: 'external_audit_passed',
        note: 'Audit report ref.',
        actorUserId: STEWARD,
        isPlatformStaff: true,
      }),
    ).toMatchObject({ ok: true });
  });

  it('the checklist port reports the four WS-M-owned items from live data', async () => {
    const deps = buildDeps();
    const port = buildWsmReadinessChecklistPort(deps);
    expect(await port.checklist(ROOM)).toEqual({
      charterPresent: false,
      stewardsDesignated: false,
      treasuryPolicyDefined: false,
      safetyOverrideAcknowledged: false,
    });
    await makeTestnetReady(deps);
    expect(await port.checklist(ROOM)).toEqual({
      charterPresent: true,
      stewardsDesignated: true,
      treasuryPolicyDefined: true,
      safetyOverrideAcknowledged: true,
    });
  });
});

describe('mode transitions (WS-M.1.1b)', () => {
  const transition = (
    deps: WsmReadinessDeps,
    targetMode: GovernanceMode,
    isPlatformStaff = false,
  ) =>
    requestWsmModeTransition(deps, {
      roomId: ROOM,
      targetMode,
      userId: STEWARD,
      reason: 'audited transition',
      isPlatformStaff,
    });

  it('walks the full escalation ladder for a ready room', async () => {
    const deps = buildDeps();
    await makeTestnetReady(deps);
    expect(await transition(deps, 'simulated')).toMatchObject({ ok: true }); // free
    expect(deps.mode.value).toBe('simulated');
    expect(await transition(deps, 'testnet')).toMatchObject({ ok: true }); // readiness
    // capped production blocks on the fail-closed jurisdiction seam.
    const capped = await transition(deps, 'capped_production');
    expect(capped).toMatchObject({ ok: false, code: 'readiness_unmet' });
    // With a positive jurisdiction verdict + platform attestation it proceeds.
    deps.compliance = { ...defaultCompliancePort, jurisdiction: async () => 'allowed' };
    expect(await transition(deps, 'capped_production')).toMatchObject({ ok: true });
    // mature production additionally needs the external audit.
    const mature = await transition(deps, 'mature_production');
    expect(mature).toMatchObject({ ok: false, code: 'readiness_unmet' });
    await recordReadinessAttestation(deps, {
      roomId: ROOM,
      item: 'external_audit_passed',
      note: 'External audit complete.',
      actorUserId: STEWARD,
      isPlatformStaff: true,
    });
    expect(await transition(deps, 'mature_production')).toMatchObject({ ok: true });
  });

  it('rejects illegal edges (mode skips) and unknown rooms', async () => {
    const deps = buildDeps();
    expect(await transition(deps, 'testnet')).toMatchObject({
      ok: false,
      code: 'transition_not_permitted',
    });
    const orphanDeps = buildDeps({
      roomMode: {
        currentMode: async () => null,
        setMode: async () => false,
        setModeIf: async () => false,
      },
    });
    expect(await transition(orphanDeps, 'simulated')).toMatchObject({ ok: false, status: 404 });
  });

  it('the emergency edge freezes governance and the frozen recovery path is platform-gated', async () => {
    const deps = buildDeps();
    await transition(deps, 'simulated');
    expect(await transition(deps, 'frozen')).toMatchObject({ ok: true });
    expect(deps.mode.value).toBe('frozen');
    expect(await assertGovernanceWritable(deps, ROOM, 'proposals')).toMatchObject({
      code: 'governance_frozen',
    });
    expect(await transition(deps, 'migrating', false)).toMatchObject({
      ok: false,
      code: 'platform_review_required',
    });
    expect(await transition(deps, 'migrating', true)).toMatchObject({ ok: true });
    expect(await transition(deps, 'ordinary')).toMatchObject({ ok: true }); // rollback
  });

  it('a raced transition loses the CAS and reports the conflict', async () => {
    const deps = buildDeps();
    const flaky: RoomModePort = {
      currentMode: async () => 'ordinary',
      setMode: async () => true,
      setModeIf: async () => false, // someone else already moved the mode
    };
    deps.roomMode = flaky;
    expect(await transition(deps, 'simulated')).toMatchObject({
      ok: false,
      code: 'concurrent_transition',
    });
  });

  it('every accepted transition writes chained request + applied audit entries', async () => {
    const deps = buildDeps();
    await transition(deps, 'simulated');
    const chain = await deps.governanceAudit.listChainedByRoom(ROOM);
    const types = chain.map((e) => e.actionType);
    expect(types).toContain('mode_transition_requested');
    expect(types).toContain('mode_transition_applied');
    expect((await verifyAuditChain(deps, ROOM)).valid).toBe(true);
  });
});
