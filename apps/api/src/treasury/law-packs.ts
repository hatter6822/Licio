// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.1.3a-d — law-pack registration, validation, versioning, and adoption
// over the SHIPPED `room_law_pack` table (evolved by migration 0082, never a
// parallel entity).  Registration runs the FULL @licio/governance validation
// stack — zod shape, structural cross-field checks, and the fixture harness
// (the same engines the runtime executes) — and PUBLISHES the version, making
// it immutable at the database (trigger).  The hash commitment is computed
// server-side over the canonical bundle (the client can recompute it from the
// member-downloadable document).  Adoption pins the pack onto the room profile
// with the §22.2 policy refs; in-flight proposals keep their own pinned
// version (WS-M.1.3d — rules can never change mid-vote).

import { createHash } from 'node:crypto';
import {
  fixtureCoverageProblems,
  type LawPack,
  type LawPackFixtureCorpus,
  type LawPackProblem,
  lawPackCanonicalText,
  lawPackFixtureCorpusSchema,
  lawPackSchema,
  runLawPackFixtures,
  validateLawPackBundle,
  validateLawPackForRealAssets,
} from '@licio/governance';
import type { LawPackRecord, LawPackStore } from '../governance/stores.js';
import type { RoomModePort } from '../knomosis/readiness.js';
import { appendChainedAudit } from './audit-chain.js';
import {
  assertGovernanceWritable,
  ensureProfile,
  type ProfileDeps,
  type TreasuryGovernanceError,
  tgErr,
} from './profile.js';

export interface LawPackDeps extends ProfileDeps {
  lawPacks: LawPackStore;
  roomMode: RoomModePort;
}

export interface LawPackValidationReport {
  structuralProblems: LawPackProblem[];
  realAssetProblems: LawPackProblem[];
  fixtureFailures: { label: string; expected: string; actual: string }[];
  coverageProblems: LawPackProblem[];
  pack: LawPack | null;
  corpus: LawPackFixtureCorpus | null;
}

/** Dry-run the full WS-M.1.3c validation stack (also serves the routes). */
export function validateLawPackDocument(
  document: unknown,
  fixtures: unknown | null,
): LawPackValidationReport {
  const parsed = lawPackSchema.safeParse(document);
  if (!parsed.success) {
    return {
      structuralProblems: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        problem: issue.message,
      })),
      realAssetProblems: [],
      fixtureFailures: [],
      coverageProblems: [],
      pack: null,
      corpus: null,
    };
  }
  const pack = parsed.data;
  const structuralProblems = validateLawPackBundle(pack);
  const realAssetProblems = validateLawPackForRealAssets(pack);
  let corpus: LawPackFixtureCorpus | null = null;
  let fixtureFailures: LawPackValidationReport['fixtureFailures'] = [];
  let coverageProblems: LawPackProblem[] = [];
  if (fixtures !== null && fixtures !== undefined) {
    const parsedCorpus = lawPackFixtureCorpusSchema.safeParse(fixtures);
    if (!parsedCorpus.success) {
      coverageProblems = parsedCorpus.error.issues.map((issue) => ({
        path: `fixtures.${issue.path.join('.')}`,
        problem: issue.message,
      }));
    } else {
      corpus = parsedCorpus.data;
      fixtureFailures = runLawPackFixtures(pack, corpus).failures;
      coverageProblems = fixtureCoverageProblems(pack, corpus);
    }
  }
  return { structuralProblems, realAssetProblems, fixtureFailures, coverageProblems, pack, corpus };
}

/** SHA-256 hex over the canonical bundle minus its own hash field. */
export function computeLawPackHash(pack: LawPack): string {
  return createHash('sha256').update(lawPackCanonicalText(pack), 'utf8').digest('hex');
}

/**
 * Register (publish) a law-pack version (WS-M.1.3a/c/d).  Fail-closed: any
 * structural problem, fixture failure, or coverage gap blocks publication —
 * "a law-pack with any fixture failure cannot be published".  Real-asset
 * completeness is NOT required here (a simulated-mode room may iterate); the
 * `law_pack_valid` readiness item applies that bar before real assets.
 */
export async function registerLawPack(
  deps: LawPackDeps,
  input: { roomId: string; document: unknown; fixtures: unknown | null; actorUserId: string },
): Promise<TreasuryGovernanceError | { ok: true; record: LawPackRecord; hashCommitment: string }> {
  const report = validateLawPackDocument(input.document, input.fixtures);
  if (report.pack === null || report.structuralProblems.length > 0) {
    const first = report.structuralProblems[0];
    return tgErr(
      400,
      'law_pack_invalid',
      first ? `${first.path}: ${first.problem}` : 'The law-pack document is invalid.',
    );
  }
  if (report.fixtureFailures.length > 0) {
    const first = report.fixtureFailures[0];
    return tgErr(
      400,
      'law_pack_fixtures_failed',
      `Fixture "${first?.label}": expected ${first?.expected}, got ${first?.actual}.`,
    );
  }
  if (report.corpus !== null && report.coverageProblems.length > 0) {
    const first = report.coverageProblems[0];
    return tgErr(400, 'law_pack_coverage_gap', `${first?.path}: ${first?.problem}`);
  }
  const profile = await ensureProfile(deps, input.roomId);
  const lawPackId = deps.uuid();
  // The stored document carries its own id + the computed commitment so the
  // member-downloadable bundle is self-describing; the hash covers everything
  // EXCEPT the hash field itself.
  const withId: LawPack = { ...report.pack, lawPackId };
  const hashCommitment = computeLawPackHash(withId);
  const record: LawPackRecord = {
    lawPackId,
    roomId: input.roomId,
    version: report.pack.version,
    lawPack: { ...withId, hashCommitment },
    createdAt: new Date(deps.now()).toISOString(),
    hashCommitment,
    auditState: 'draft',
    fixtures: report.corpus !== null ? (report.corpus as unknown as Record<string, unknown>) : null,
    humanSummary: report.pack.humanSummary ?? null,
    published: true,
    effectiveAt: null,
    supersedesLawPackId: profile.lawPackId,
  };
  await deps.lawPacks.insert(record);
  await appendChainedAudit(deps, {
    roomId: input.roomId,
    actionType: 'law_pack_registered',
    actorUserId: input.actorUserId,
    details: {
      law_pack_id: lawPackId,
      version: record.version,
      hash_commitment: hashCommitment,
      supersedes: record.supersedesLawPackId,
    },
  });
  return { ok: true, record, hashCommitment };
}

/**
 * Adopt a registered law-pack as the room's active pack (WS-M.1.3d).  The
 * initial adoption is a steward action gated by the route; UPGRADES after
 * governance enablement go through the `law_pack_upgrade` proposal lifecycle,
 * whose execution calls this.  Adoption updates the profile refs only —
 * proposals in flight keep their own pinned version.
 */
export async function adoptLawPack(
  deps: LawPackDeps,
  input: { roomId: string; lawPackId: string; actorUserId: string | null },
): Promise<TreasuryGovernanceError | { ok: true; record: LawPackRecord }> {
  const record = await deps.lawPacks.get(input.lawPackId);
  if (record === null || record.roomId !== input.roomId) {
    return tgErr(404, 'law_pack_not_found', 'The law-pack does not belong to this room.');
  }
  if (record.published !== true) {
    return tgErr(409, 'law_pack_unpublished', 'Only a published law-pack can be adopted.');
  }
  // Adoption swaps the ACTIVE quorum/threshold/timelock rules — a frozen room
  // must not change its governance configuration during an emergency review
  // (the same guard charter publishing runs).
  const writable = await assertGovernanceWritable(deps, input.roomId, 'configuration');
  if (writable !== null) return writable;
  // Registration allows real-asset-INCOMPLETE packs (simulated rooms iterate);
  // a room already past the readiness gate must not adopt one — re-run the
  // real-asset validation here so a passed upgrade proposal cannot regress the
  // active pack below the production bar until the next mode transition.
  const mode = await deps.roomMode.currentMode(input.roomId);
  if (mode === 'testnet' || mode === 'capped_production' || mode === 'mature_production') {
    const parsed = lawPackSchema.safeParse(record.lawPack);
    const problems = parsed.success ? validateLawPackForRealAssets(parsed.data) : null;
    if (problems === null || problems.length > 0) {
      const first = problems?.[0];
      return tgErr(
        409,
        'law_pack_not_real_asset_ready',
        first
          ? `${first.path}: ${first.problem}`
          : 'The law-pack does not meet the real-asset bar.',
      );
    }
  }
  const profile = await ensureProfile(deps, input.roomId);
  await deps.profiles.upsert({
    ...profile,
    lawPackId: record.lawPackId,
    quorumPolicyRef: { lawPackId: record.lawPackId, section: 'quorumRules' },
    thresholdPolicyRef: { lawPackId: record.lawPackId, section: 'thresholdRules' },
    timelockPolicyRef: { lawPackId: record.lawPackId, section: 'timelockRules' },
    updatedAt: new Date(deps.now()).toISOString(),
  });
  await appendChainedAudit(deps, {
    roomId: input.roomId,
    actionType: 'law_pack_adopted',
    actorUserId: input.actorUserId,
    details: { law_pack_id: record.lawPackId, version: record.version },
  });
  return { ok: true, record };
}

/** The room's ACTIVE law-pack (profile-pinned), parsed and typed. */
export async function activeLawPack(
  deps: LawPackDeps,
  roomId: string,
): Promise<{ record: LawPackRecord; pack: LawPack } | null> {
  const profile = await deps.profiles.get(roomId);
  if (profile === null || profile.lawPackId === null) return null;
  const record = await deps.lawPacks.get(profile.lawPackId);
  if (record === null || record.roomId !== roomId) return null;
  const parsed = lawPackSchema.safeParse(record.lawPack);
  return parsed.success ? { record, pack: parsed.data } : null;
}
