// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.1.1b + WS-M.1.2a-e — the EXTENDED readiness checklist and the full
// governance-mode transition gate, built on the shipped WS-L.4.1g machinery:
//
//  - The four WS-M-owned `ReadinessChecklistPort` items get REAL evaluators
//    (replacing the fail-closed defaults in knomosis/wiring.ts): the versioned
//    charter (WS-M.1.2a), the §16.5 elected steward seat + appeals path
//    (WS-M.1.2b), the bound law-pack treasury policy (WS-M.1.2c), and the
//    safety-override acknowledgment — charter section + steward attestation
//    (WS-M.1.2d).
//  - Four new items extend the vocabulary (WS-M.1.2e): `jurisdiction_supported`
//    (the fail-closed WS-N seam; production modes only), `law_pack_valid` (the
//    real-asset bar + fixture re-run), `governance_model_ratified` (the shipped
//    WS-U ratification state; not-applicable where the room adopts no AI
//    governance), and `external_audit_passed` (platform attestation; mature
//    production only).
//  - `requestWsmModeTransition` drives EVERY WS-M.1.1b edge through the pure
//    @licio/governance edge table, evaluates readiness LIVE for the target
//    (per-item requiredFor — no cached pass, no TOCTOU: the mode write is a
//    COMPARE-AND-SET against the mode the checklist was evaluated under), and
//    writes chained audit entries for the request and the application.

import {
  fixtureCoverageProblems,
  type LawPack,
  lawPackFixtureCorpusSchema,
  modeTransitionGate,
  runLawPackFixtures,
  validateLawPackForRealAssets,
} from '@licio/governance';
import {
  type GovernanceMode,
  READINESS_TARGET_MODES,
  type ReadinessItem,
  type ReadinessRequirement,
  type ReadinessTargetMode,
} from '@licio/shared';
import type { BindingStore, ModelStore, SeatStore } from '../governance/stores.js';
import type { AuditStore } from '../identity/audit.js';
import type { KnomosisRuntimeConfig } from '../knomosis/config.js';
import type { CompliancePort, RegionResolverPort } from '../knomosis/ports.js';
import type { RoomGovernancePort } from '../knomosis/preflight.js';
import type { ReadinessChecklistPort, RoomModePort } from '../knomosis/readiness.js';
import { hasPassedComprehension } from '../knomosis/simulation.js';
import type { ComprehensionStore } from '../knomosis/stores.js';
import { appendChainedAudit } from './audit-chain.js';
import { activeLawPack, type LawPackDeps } from './law-packs.js';
import {
  assertGovernanceWritable,
  setGovernanceFreeze,
  type TreasuryGovernanceError,
  tgErr,
} from './profile.js';
import type { AttestationStore, CharterStore } from './stores.js';

export interface WsmReadinessDeps extends LawPackDeps {
  charters: CharterStore;
  attestations: AttestationStore;
  rooms: RoomGovernancePort;
  seats: SeatStore;
  bindings: BindingStore;
  models: ModelStore;
  comprehension: ComprehensionStore;
  compliance: CompliancePort;
  regionResolver: RegionResolverPort;
  roomMode: RoomModePort;
  identityAudit: AuditStore;
  config: () => KnomosisRuntimeConfig;
}

/** Which target modes each item is REQUIRED for (WS-M.1.2e `requiredFor`).
 *  `simulated` requires nothing — entering simulation is the safe direction
 *  (shipped WS-L.4.1g behavior; SPEC §16.5). */
const REQUIRED_FOR: Readonly<Record<ReadinessRequirement, readonly ReadinessTargetMode[]>> = {
  charter_present: ['testnet', 'capped_production', 'mature_production'],
  stewards_designated: ['testnet', 'capped_production', 'mature_production'],
  treasury_policy_defined: ['testnet', 'capped_production', 'mature_production'],
  safety_override_acknowledged: ['testnet', 'capped_production', 'mature_production'],
  comprehension_passed: ['testnet'],
  simulation_track_record: ['testnet'],
  jurisdiction_supported: ['capped_production', 'mature_production'],
  law_pack_valid: ['testnet', 'capped_production', 'mature_production'],
  governance_model_ratified: ['testnet', 'capped_production', 'mature_production'],
  external_audit_passed: ['mature_production'],
};

interface ItemEvaluation {
  status: 'pass' | 'fail' | 'not_applicable';
  description: string;
}

async function evaluateLawPackValidity(
  deps: WsmReadinessDeps,
  roomId: string,
): Promise<ItemEvaluation> {
  const active = await activeLawPack(deps, roomId);
  if (active === null) {
    return { status: 'fail', description: 'No published law-pack is adopted for this room.' };
  }
  const problems = validateLawPackForRealAssets(active.pack);
  if (problems.length > 0) {
    const first = problems[0];
    return {
      status: 'fail',
      description: `Law-pack incomplete for real assets: ${first?.path} — ${first?.problem}`,
    };
  }
  if (active.record.fixtures === null || active.record.fixtures === undefined) {
    return { status: 'fail', description: 'The law-pack has no fixture corpus (WS-M.1.3c).' };
  }
  const corpus = lawPackFixtureCorpusSchema.safeParse(active.record.fixtures);
  if (!corpus.success) {
    return { status: 'fail', description: 'The stored fixture corpus does not parse.' };
  }
  // Re-run the corpus through the SAME engines the runtime executes — a live
  // re-check, never a cached pass (WS-M.1.2e evaluates live).
  const run = runLawPackFixtures(active.pack as LawPack, corpus.data);
  if (!run.passed) {
    return { status: 'fail', description: `Fixture "${run.failures[0]?.label}" fails.` };
  }
  const coverage = fixtureCoverageProblems(active.pack as LawPack, corpus.data);
  if (coverage.length > 0) {
    return { status: 'fail', description: `Fixture coverage gap: ${coverage[0]?.problem}` };
  }
  return { status: 'pass', description: 'The adopted law-pack is complete, proven, and covered.' };
}

async function evaluateItem(
  deps: WsmReadinessDeps,
  roomId: string,
  userId: string,
  requirement: ReadinessRequirement,
): Promise<ItemEvaluation> {
  switch (requirement) {
    case 'charter_present': {
      const charter = await deps.charters.latestByRoom(roomId);
      return charter !== null
        ? { status: 'pass', description: `Charter v${charter.version} is published.` }
        : { status: 'fail', description: 'The room needs a plain-language charter (WS-M.1.2a).' };
    }
    case 'stewards_designated': {
      const seat = await deps.seats.get(roomId);
      if (seat === null || seat.holderUserId === null) {
        return {
          status: 'fail',
          description: 'The elected steward seat is vacant (§16.6 — one seat per room).',
        };
      }
      // The appeals path lives as a REQUIRED charter section (schema-enforced),
      // so a published charter structurally carries it.
      const charter = await deps.charters.latestByRoom(roomId);
      if (charter === null) {
        return {
          status: 'fail',
          description: 'The appeals path to the platform legal floor needs a published charter.',
        };
      }
      return { status: 'pass', description: 'Elected steward seated; appeals path documented.' };
    }
    case 'treasury_policy_defined': {
      const active = await activeLawPack(deps, roomId);
      if (active === null) {
        return { status: 'fail', description: 'No law-pack carries a treasury policy yet.' };
      }
      if (active.pack.treasury.caps.length === 0) {
        return {
          status: 'fail',
          description: 'The law-pack must define permitted spend categories with caps (§16.5).',
        };
      }
      return { status: 'pass', description: 'Treasury policy with spend categories and caps.' };
    }
    case 'safety_override_acknowledged': {
      const charter = await deps.charters.latestByRoom(roomId);
      if (charter === null) {
        return {
          status: 'fail',
          description: 'The safety-override acknowledgment needs a published charter section.',
        };
      }
      const attested = await deps.attestations.get(roomId, 'safety_override_acknowledged');
      if (attested === null) {
        return {
          status: 'fail',
          description:
            'A steward must attest the platform-moderation-supremacy acknowledgment (WS-M.1.2d).',
        };
      }
      return { status: 'pass', description: 'Platform legal floor acknowledged and attested.' };
    }
    case 'comprehension_passed': {
      const passed = await hasPassedComprehension({ comprehension: deps.comprehension }, userId);
      return passed
        ? { status: 'pass', description: 'The requesting steward passed the comprehension check.' }
        : {
            status: 'fail',
            description: 'The requesting steward must pass the simulation-comprehension check.',
          };
    }
    case 'simulation_track_record': {
      const count = await deps.governanceAudit.countQualifyingByRoom(roomId);
      const required = deps.config().readinessMinSimActions;
      return count >= required
        ? { status: 'pass', description: `${count} simulated governance actions recorded.` }
        : {
            status: 'fail',
            description: `The room needs at least ${required} simulated governance actions (currently ${count}).`,
          };
    }
    case 'jurisdiction_supported': {
      const region = await deps.regionResolver.regionForUser(userId);
      const verdict = await deps.compliance.jurisdiction({
        userId,
        region,
        // Region-WIDE by intent: this item asks whether the region is cleared
        // for real-asset governance at all, not whether one action's cell is
        // — so it names no cell and no asset, and `allowed` still requires
        // both real-funds cells enabled with a verified basis.
        featureCell: null,
        asset: null,
      });
      // Fail-closed: 'unknown' (no WS-N engine) and 'blocked' both fail —
      // production modes require a POSITIVE jurisdiction determination.
      return verdict === 'allowed'
        ? { status: 'pass', description: 'Jurisdiction verified for real-asset governance.' }
        : {
            status: 'fail',
            description: 'Jurisdiction could not be positively verified (WS-N seam, fail-closed).',
          };
    }
    case 'law_pack_valid':
      return evaluateLawPackValidity(deps, roomId);
    case 'governance_model_ratified': {
      const binding = await deps.bindings.get(roomId);
      if (binding !== null) {
        if (binding.active && !binding.floorFrozen) {
          return { status: 'pass', description: 'A member-ratified governance agent is active.' };
        }
        return {
          status: 'fail',
          description: binding.floorFrozen
            ? 'The room’s agent is floor-frozen; resolve the platform review first.'
            : 'The room’s agent binding is inactive (ratification incomplete).',
        };
      }
      const models = await deps.models.listByRoom(roomId);
      if (models.length === 0) {
        // The room adopts no AI governance — §16.5 makes the model requirement
        // conditional ("where the room adopts AI governance").
        return { status: 'not_applicable', description: 'This room adopts no AI governance.' };
      }
      return {
        status: 'fail',
        description: 'Proposed governance models exist but none is member-ratified (§16.5).',
      };
    }
    case 'external_audit_passed': {
      const attested = await deps.attestations.get(roomId, 'external_audit_passed');
      return attested !== null
        ? { status: 'pass', description: 'External audit sign-off recorded (§17.11).' }
        : {
            status: 'fail',
            description: 'Mature production requires a recorded external audit (§17.11).',
          };
    }
    default: {
      const exhaustive: never = requirement;
      throw new Error(`unhandled readiness requirement: ${String(exhaustive)}`);
    }
  }
}

export interface WsmReadinessResult {
  ready: boolean;
  items: ReadinessItem[];
  unmet: { requirement: ReadinessRequirement; description: string }[];
}

/** Evaluate the FULL checklist live for one target mode (WS-M.1.2e). */
export async function evaluateWsmReadiness(
  deps: WsmReadinessDeps,
  roomId: string,
  userId: string,
  targetMode: ReadinessTargetMode,
): Promise<WsmReadinessResult> {
  const items: ReadinessItem[] = [];
  const unmet: WsmReadinessResult['unmet'] = [];
  for (const requirement of Object.keys(REQUIRED_FOR) as ReadinessRequirement[]) {
    const requiredFor = REQUIRED_FOR[requirement];
    const evaluation = await evaluateItem(deps, roomId, userId, requirement);
    const item: ReadinessItem = {
      requirement,
      status: evaluation.status,
      description: evaluation.description,
      required_for: [...requiredFor],
      evaluated_at: new Date(deps.now()).toISOString(),
    };
    items.push(item);
    if (
      requiredFor.includes(targetMode) &&
      evaluation.status === 'fail' // not_applicable never blocks
    ) {
      unmet.push({ requirement, description: evaluation.description });
    }
  }
  return { ready: unmet.length === 0, items, unmet };
}

/** The real WS-M.1.2 checklist port (replaces the fail-closed defaults). */
export function buildWsmReadinessChecklistPort(deps: WsmReadinessDeps): ReadinessChecklistPort {
  return {
    checklist: async (roomId) => {
      const [charter, seat, active, attested] = await Promise.all([
        deps.charters.latestByRoom(roomId),
        deps.seats.get(roomId),
        activeLawPack(deps, roomId),
        deps.attestations.get(roomId, 'safety_override_acknowledged'),
      ]);
      return {
        charterPresent: charter !== null,
        stewardsDesignated: seat !== null && seat.holderUserId !== null && charter !== null,
        treasuryPolicyDefined: active !== null && active.pack.treasury.caps.length > 0,
        safetyOverrideAcknowledged: charter !== null && attested !== null,
      };
    },
  };
}

export type WsmModeTransitionOutcome =
  | { ok: true; mode: GovernanceMode }
  | (TreasuryGovernanceError & {
      unmet?: { requirement: ReadinessRequirement; description: string }[];
    });

export interface WsmModeTransitionInput {
  roomId: string;
  targetMode: GovernanceMode;
  userId: string;
  reason: string;
  /** Resolved by the route (platform security/legal/T&S roles). */
  isPlatformStaff: boolean;
}

const isReadinessTarget = (mode: GovernanceMode): mode is ReadinessTargetMode =>
  (READINESS_TARGET_MODES as readonly string[]).includes(mode);

/**
 * The full WS-M.1.1b transition machine.  Every edge consults the pure
 * @licio/governance edge table; readiness gates evaluate LIVE for the target;
 * the mode write is a CAS against the evaluated `from` mode (no TOCTOU); the
 * request and the application both land in the chained audit log.
 */
export async function requestWsmModeTransition(
  deps: WsmReadinessDeps,
  input: WsmModeTransitionInput,
): Promise<WsmModeTransitionOutcome> {
  const current = await deps.roomMode.currentMode(input.roomId);
  if (current === null) return tgErr(404, 'not_found', 'Resource not found');
  const gate = modeTransitionGate(current, input.targetMode);

  await appendChainedAudit(deps, {
    roomId: input.roomId,
    actionType: 'mode_transition_requested',
    actorUserId: input.userId,
    details: { from: current, to: input.targetMode, reason: input.reason, gate },
  });

  if (gate === null) {
    return tgErr(
      409,
      'transition_not_permitted',
      `A transition from "${current}" to "${input.targetMode}" is not permitted.`,
    );
  }
  if (gate === 'post_remediation' && !input.isPlatformStaff) {
    return tgErr(
      403,
      'platform_review_required',
      'Leaving the frozen state requires a platform remediation review.',
    );
  }
  // A GOVERNANCE-frozen room cannot change its mode mid-review: the freeze
  // pauses every WS-M mutation and the mode machine is no exception.  Three
  // corridors stay open: the emergency edge INTO frozen, the platform
  // remediation edge OUT of it, and the `migrating` wind-down that follows
  // remediation (the profile freeze is lifted separately by platform staff).
  if (gate !== 'post_remediation' && gate !== 'emergency' && current !== 'migrating') {
    const profile = await deps.profiles.get(input.roomId);
    if (profile?.freezeState === 'frozen') {
      return tgErr(
        403,
        'governance_frozen',
        profile.freezeReason ?? 'Governance actions in this room are paused pending review.',
      );
    }
  }
  if (gate === 'readiness' || gate === 'resume') {
    if (!isReadinessTarget(input.targetMode)) {
      return tgErr(409, 'transition_not_permitted', 'The target mode cannot be readiness-gated.');
    }
    // §28.3 expansion blocker: an unexplained treasury divergence hard-blocks
    // any escalation into (or within) the production modes.
    if (input.targetMode === 'capped_production' || input.targetMode === 'mature_production') {
      const treasury = await deps.treasuries.getByRoom(input.roomId);
      if (treasury !== null && treasury.reconciliationState === 'divergent') {
        return tgErr(
          409,
          'reconciliation_divergent',
          'Treasury reconciliation has an unexplained divergence; expansion is blocked (§28.3).',
        );
      }
    }
    const readiness = await evaluateWsmReadiness(
      deps,
      input.roomId,
      input.userId,
      input.targetMode,
    );
    await deps.identityAudit.append({
      actorUserId: input.userId,
      eventType: 'governance_mode_change',
      targetRef: input.roomId,
      context: {
        setting: `${current}->${input.targetMode}`,
        new_value: readiness.ready
          ? 'ready'
          : `unmet:${readiness.unmet.map((u) => u.requirement).join(',')}`.slice(0, 256),
      },
    });
    if (!readiness.ready) {
      return {
        ...tgErr(
          409,
          'readiness_unmet',
          'The room does not meet the readiness checklist for this transition.',
        ),
        unmet: readiness.unmet,
      };
    }
  }

  // CAS against the mode the gate was evaluated under (no TOCTOU window).
  const applied = await deps.roomMode.setModeIf(input.roomId, current, input.targetMode);
  if (!applied) {
    return tgErr(409, 'concurrent_transition', 'Another transition raced this one; re-check.');
  }

  // The emergency edge also freezes governance + treasury (WS-M.2.4a): the mode
  // AND the freeze flags travel together so every guard path halts.
  if (gate === 'emergency') {
    await setGovernanceFreeze(deps, {
      roomId: input.roomId,
      action: 'freeze',
      scope: 'room',
      source: input.isPlatformStaff ? 'platform_security' : 'steward',
      reason: input.reason,
      actorUserId: input.userId,
      isPlatformStaff: input.isPlatformStaff,
    });
  }

  await appendChainedAudit(deps, {
    roomId: input.roomId,
    actionType: 'mode_transition_applied',
    actorUserId: input.userId,
    details: { from: current, to: input.targetMode, gate },
  });
  return { ok: true, mode: input.targetMode };
}

/**
 * Record an attestable readiness item (WS-M.1.2d/e).  The safety-override
 * acknowledgment is a STEWARD action; the external-audit sign-off is PLATFORM
 * STAFF only (§17.11 — a room cannot self-certify its audit).  Both are
 * idempotent upserts and chain-audited.
 */
export async function recordReadinessAttestation(
  deps: WsmReadinessDeps,
  input: {
    roomId: string;
    item: 'safety_override_acknowledged' | 'external_audit_passed';
    note: string;
    actorUserId: string;
    isPlatformStaff: boolean;
  },
): Promise<TreasuryGovernanceError | { ok: true }> {
  if (input.item === 'external_audit_passed' && !input.isPlatformStaff) {
    return tgErr(
      403,
      'platform_review_required',
      'Only platform staff can record an external-audit sign-off.',
    );
  }
  // The safety-override acknowledgment is the ROOM's own commitment to the
  // platform-moderation supremacy — a room steward must record it; platform
  // staff cannot acknowledge it on the room's behalf.
  if (
    input.item === 'safety_override_acknowledged' &&
    !(await deps.rooms.isSteward(input.roomId, input.actorUserId))
  ) {
    return tgErr(403, 'steward_required', 'A room steward must record this acknowledgment.');
  }
  // Attestations feed the readiness checklist directly — a frozen room must
  // not accumulate production-readiness state mid-review (W12).
  const writable = await assertGovernanceWritable(deps, input.roomId, 'configuration');
  if (writable !== null) return writable;
  await deps.attestations.upsert({
    roomId: input.roomId,
    item: input.item,
    attestedByUserId: input.actorUserId,
    note: input.note,
    createdAt: new Date(deps.now()).toISOString(),
  });
  await appendChainedAudit(deps, {
    roomId: input.roomId,
    actionType: 'readiness_attested',
    actorUserId: input.actorUserId,
    details: { item: input.item },
  });
  return { ok: true };
}
