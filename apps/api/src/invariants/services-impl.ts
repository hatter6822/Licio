// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H — the eleven InvariantService implementations.
//
// Each service conforms to the @licio/invariants `InvariantService`
// interface: it ASSEMBLES inputs from the real WS-D/E/F/G stores (data.ts),
// runs the pure mathematics, and returns confidence/coverage/reason-coded
// computations. Persistence, guarding (timeouts, degraded envelopes), and
// health observation happen in the platform runner — services stay
// side-effect-free reads + math. Every output the platform persists is
// SHADOW (WS-H.1.2e): these computations carry zero enforcement authority
// until promoted.

import {
  analystCaseSummary,
  appealSummary,
  assertGaugeInvariantBoundary,
  assessTension,
  braidEntropyEstimate,
  braidWordFromSnapshots,
  buildConversationComplex,
  buildMetricMeasureSpace,
  buildSparseTable,
  buildTimingMatrix,
  cidReleaseGate,
  classifySessionHealth,
  computeMeri,
  contextStateForScore,
  counterfactualInvarianceDefect,
  DEFAULT_GAMING_DETECTION,
  describeMargins,
  detectGaming,
  detectNarrowLoop,
  detectSynchronizedCascade,
  effectiveRepeatThreshold,
  experienceMetrics,
  fiberTest,
  generateGroup,
  gwDistanceWithStability,
  type HealthMetrics,
  helmholtzDecompose,
  holonomyCycleFromWalk,
  type InvariantCard,
  type InvariantComputation,
  type InvariantService,
  type InvariantTarget,
  type InvariantTimeWindow,
  InvariantType,
  loopHolonomy,
  MFCI_AXES,
  phiScore,
  reebGraph,
  riskStateForScore,
  scoiEnergy,
  suppressBelowK,
  type TierDeclaration,
} from '@licio/invariants';
import type { EventPipelineServices } from '../events/services.js';
import type { ForumServices } from '../forum/services.js';
import type { IdentityServices } from '../identity/services.js';
import type { IngestionServices } from '../ingestion/services.js';
import { deterministicEventId } from '../pwatt/scoring.js';
import { INVARIANT_CARDS } from './cards.js';
import type { InvariantsRuntimeConfig } from './config.js';
import {
  assembleActivitySnapshots,
  assembleCohorts,
  assembleConversationInteractions,
  assembleEngagementLandscape,
  assembleMeriCandidates,
  assembleMfciActions,
  assemblePhiTopicData,
  assembleScoiStructure,
  assembleTopicCascade,
  sessionEventsFromSequence,
} from './data.js';
import { HealthRecorder } from './runner.js';
import type { SessionTopicSequenceStore } from './stores.js';

/** The fixed target id for global-feed-scoped invariants. */
export const GLOBAL_FEED_TARGET_ID = '00000000-0000-4000-8000-0000000feed1';

export interface InvariantDeps {
  events: EventPipelineServices;
  identity: IdentityServices;
  ingestion: IngestionServices;
  forum: ForumServices;
  sessions: SessionTopicSequenceStore;
  config: () => InvariantsRuntimeConfig;
  now: () => number;
}

/** Common service plumbing: card, tiers, health. */
abstract class BaseInvariantService implements InvariantService {
  abstract readonly invariantType: InvariantType;
  abstract readonly tiers: TierDeclaration;
  readonly health = new HealthRecorder();
  protected readonly deps: InvariantDeps;

  constructor(deps: InvariantDeps) {
    this.deps = deps;
  }

  abstract computeBatch(
    targets: readonly InvariantTarget[],
    window: InvariantTimeWindow,
  ): Promise<InvariantComputation[]>;

  /** Default real-time path: an honest "batch-only" degraded computation. */
  async computeRealtime(target: InvariantTarget): Promise<InvariantComputation> {
    const card = this.getCard();
    return {
      invariantType: this.invariantType,
      target,
      window: {
        start: new Date(this.deps.now()).toISOString(),
        end: new Date(this.deps.now()).toISOString(),
      },
      score_vector: {},
      confidence: 0,
      coverage: 0,
      reason_codes: ['INSUFFICIENT_COVERAGE'],
      fallback_used: false,
      version: card.version,
      explanationSummary: 'batch-only invariant: no real-time approximation',
    };
  }

  getCard(): InvariantCard {
    return INVARIANT_CARDS[this.invariantType];
  }

  getHealthMetrics(): HealthMetrics {
    return this.health.snapshot();
  }

  protected computation(
    target: InvariantTarget,
    window: InvariantTimeWindow,
    scoreVector: Record<string, unknown>,
    confidence: number,
    coverage: number,
    reasonCodes: string[],
    explanationSummary: string | null,
  ): InvariantComputation {
    return {
      invariantType: this.invariantType,
      target,
      window,
      score_vector: scoreVector,
      confidence: Math.min(1, Math.max(0, confidence)),
      coverage: Math.min(1, Math.max(0, coverage)),
      reason_codes: reasonCodes,
      fallback_used: reasonCodes.some((code) =>
        [
          'APPROXIMATION_FALLBACK',
          'MATROID_FALLBACK',
          'MATRIX_LOG_FALLBACK',
          'TIMEOUT',
          'COMPUTE_ERROR',
        ].includes(code),
      ),
      version: this.getCard().version,
      explanationSummary,
    };
  }
}

// --------------------------------------------------------------------------
// MERI
// --------------------------------------------------------------------------

export class MeriService extends BaseInvariantService {
  readonly invariantType = InvariantType.MERI;
  readonly tiers: TierDeclaration = { realtime: true, nearRealtime: true, batch: true };

  async computeBatch(
    targets: readonly InvariantTarget[],
    window: InvariantTimeWindow,
  ): Promise<InvariantComputation[]> {
    const config = this.deps.config();
    const out: InvariantComputation[] = [];
    for (const target of targets) {
      const candidates = await assembleMeriCandidates(
        this.deps.ingestion,
        null,
        config.meriCandidateLimit,
        config.meriNearDuplicateThreshold,
      );
      const result = computeMeri(candidates, {
        similarityThreshold: config.meriNearDuplicateThreshold,
      });
      out.push(
        this.computation(
          target,
          window,
          {
            meri: result.meri,
            marginal_gains: Object.fromEntries(
              Object.entries(result.marginalGains).map(([k, v]) => [k, v]),
            ),
            approximation: result.approximation,
            per_class_bounds: Object.fromEntries(result.classes.map((c) => [c.classId, c.bound])),
            group_ids: result.groupIds,
          },
          result.confidence,
          result.coverage,
          result.reasonCodes,
          `Normalized exposure rank ${result.meri.toFixed(3)} over ${candidates.length} candidates (${result.selectedIds.length} independent).`,
        ),
      );
    }
    return out;
  }

  override async computeRealtime(target: InvariantTarget): Promise<InvariantComputation> {
    const window = {
      start: new Date(this.deps.now() - 3_600_000).toISOString(),
      end: new Date(this.deps.now()).toISOString(),
    };
    const [single] = await this.computeBatch([target], window);
    if (single) return single;
    return super.computeRealtime(target);
  }

  /** WS-E hook closure: redundancy ∈ [0, 1] for an item (1 = redundant). */
  async redundancyOf(itemId: string): Promise<number> {
    const latest = await this.deps.events.invariantStore.latest(
      InvariantType.MERI,
      GLOBAL_FEED_TARGET_ID,
    );
    if (!latest) return 0;
    const gains = latest.scoreVector['marginal_gains'];
    if (typeof gains !== 'object' || gains === null) return 0;
    const gain = (gains as Record<string, unknown>)[itemId];
    if (typeof gain !== 'number') return 0;
    return Math.min(1, Math.max(0, 1 - gain));
  }
}

// --------------------------------------------------------------------------
// MFCI
// --------------------------------------------------------------------------

export class MfciService extends BaseInvariantService {
  readonly invariantType = InvariantType.MFCI;
  readonly tiers: TierDeclaration = { realtime: true, nearRealtime: true, batch: true };

  async computeBatch(
    targets: readonly InvariantTarget[],
    window: InvariantTimeWindow,
  ): Promise<InvariantComputation[]> {
    const config = this.deps.config();
    const { observations } = await assembleMfciActions(
      this.deps.events,
      this.deps.identity,
      this.deps.ingestion,
      window.start,
      window.end,
    );
    if (observations.length < 5) {
      return targets.map((target) =>
        this.computation(target, window, {}, 0, 0, ['INSUFFICIENT_COVERAGE'], null),
      );
    }
    // Axis label sets from the observed data (margins condition on them).
    const labelSets = MFCI_AXES.map((_, axis) => [
      ...new Set(observations.map((o) => o.labels[axis] ?? 'unknown')),
    ]);
    const table = buildSparseTable(
      MFCI_AXES.map((name, i) => ({ name, labels: labelSets[i] ?? [] })),
      observations,
    );
    const margins = describeMargins(table);
    const out: InvariantComputation[] = [];
    for (const target of targets) {
      const seedName = `MFCI:${target.targetId}:${window.start}`;
      const result = fiberTest(table, 'target_concentration', {
        samples: config.mfciSamples,
        burnIn: config.mfciBurnIn,
        thinning: config.mfciThinning,
        seed: seedFromName(seedName),
      });
      const riskState = riskStateForScore(result.mfci, config.mfciRiskThresholds);
      const reasonCodes = result.converged ? [] : ['SAMPLER_NONCONVERGENCE'];
      const facts = {
        statistic: result.statistic,
        mfci: result.mfci,
        pHat: result.pHat,
        sampleCount: result.sampleCount,
        riskState,
        conditionedMargins: margins.axes,
        targetCount: 1,
      };
      out.push(
        this.computation(
          target,
          window,
          {
            mfci: result.mfci,
            p_hat: result.pHat,
            statistic: result.statistic,
            sample_count: result.sampleCount,
            fixed_margins_ref: `margins:${target.targetId}:${window.start}`,
            risk_state: riskState,
          },
          result.converged ? 0.9 : 0.4,
          1,
          reasonCodes,
          analystCaseSummary(facts),
        ),
      );
    }
    return out;
  }

  /** Appeal-facing rationale for a case (WS-H.3.4c; identifier-free). */
  appealSummaryFor(facts: Parameters<typeof appealSummary>[0]): string {
    return appealSummary(facts);
  }
}

function seedFromName(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// --------------------------------------------------------------------------
// GWEI
// --------------------------------------------------------------------------

export class GweiService extends BaseInvariantService {
  readonly invariantType = InvariantType.GWEI;
  readonly tiers: TierDeclaration = { realtime: false, nearRealtime: false, batch: true };

  async computeBatch(
    _targets: readonly InvariantTarget[],
    window: InvariantTimeWindow,
  ): Promise<InvariantComputation[]> {
    const config = this.deps.config();
    const cohorts = await assembleCohorts(
      this.deps.events,
      this.deps.identity,
      this.deps.ingestion,
      this.deps.now(),
    );
    const out: InvariantComputation[] = [];
    const eligible = cohorts.filter(
      (c) => c.size >= config.gweiMinCohortSize && c.gwItems.length >= 2,
    );
    for (let i = 0; i < eligible.length; i += 1) {
      for (let j = i + 1; j < eligible.length; j += 1) {
        const a = eligible[i];
        const b = eligible[j];
        if (!a || !b) continue;
        const pairId = deterministicEventId(`gwei:${a.cohortKey}|${b.cohortKey}`);
        const target: InvariantTarget = { targetType: 'cohort', targetId: pairId };
        const suppressedA = suppressBelowK(
          a.size,
          config.gweiKAnonymity,
          experienceMetrics(a.items),
        );
        const suppressedB = suppressBelowK(
          b.size,
          config.gweiKAnonymity,
          experienceMetrics(b.items),
        );
        if (suppressedA.suppressed || suppressedB.suppressed) {
          out.push(this.computation(target, window, {}, 0, 0, ['SUPPRESSED_K_ANONYMITY'], null));
          continue;
        }
        const stability = gwDistanceWithStability(
          buildMetricMeasureSpace(a.gwItems),
          buildMetricMeasureSpace(b.gwItems),
          {
            seeds: config.gweiSeeds,
            epsilons: config.gweiEpsilons,
            outerIterations: 25,
            sinkhornIterations: 300,
          },
        );
        const metricBreakdown: Record<string, number> = {};
        for (const [key, value] of Object.entries(suppressedA.metrics)) {
          metricBreakdown[`a_${key}`] = value;
        }
        for (const [key, value] of Object.entries(suppressedB.metrics)) {
          metricBreakdown[`b_${key}`] = value;
        }
        out.push(
          this.computation(
            target,
            window,
            {
              gw2: stability.gw2,
              ci_low: stability.ciLow,
              ci_high: stability.ciHigh,
              seed_count: stability.seedCount,
              regularization: stability.regularization,
              cohort_a: a.cohortKey,
              cohort_b: b.cohortKey,
              metric_breakdown: metricBreakdown,
            },
            // Stability interval width drives confidence.
            Math.max(0.2, 1 - (stability.ciHigh - stability.ciLow)),
            1,
            [],
            `GW₂ ≈ ${stability.gw2.toFixed(3)} between ${a.cohortKey} and ${b.cohortKey} (stability [${stability.ciLow.toFixed(3)}, ${stability.ciHigh.toFixed(3)}]).`,
          ),
        );
      }
    }
    return out;
  }
}

// --------------------------------------------------------------------------
// SCOI
// --------------------------------------------------------------------------

export class ScoiService extends BaseInvariantService {
  readonly invariantType = InvariantType.SCOI;
  readonly tiers: TierDeclaration = { realtime: false, nearRealtime: true, batch: true };

  async computeBatch(
    targets: readonly InvariantTarget[],
    window: InvariantTimeWindow,
  ): Promise<InvariantComputation[]> {
    const config = this.deps.config();
    const out: InvariantComputation[] = [];
    for (const target of targets) {
      const { structure, lensesWithData, lensesTotal } = await assembleScoiStructure(
        this.deps.ingestion,
        this.deps.forum,
        target.targetId,
      );
      if (lensesWithData < 2) {
        out.push(
          this.computation(
            target,
            window,
            {},
            0,
            lensesTotal === 0 ? 0 : lensesWithData / lensesTotal,
            ['INSUFFICIENT_COVERAGE'],
            'Fewer than two lenses carry interpretations; no overlap to measure.',
          ),
        );
        continue;
      }
      const energy = scoiEnergy(structure);
      const state = contextStateForScore(energy.scoi, false, config.scoiStateThresholds);
      const coverage = lensesTotal === 0 ? 0 : lensesWithData / lensesTotal;
      out.push(
        this.computation(
          target,
          window,
          {
            scoi: energy.scoi,
            normalizer: energy.normalizer,
            overlap_count: energy.overlapCount,
            lens_count: energy.lensCount,
            context_state: state,
            per_overlap_energy: Object.fromEntries(
              energy.perOverlap.map((o) => [`${o.lensA}~${o.lensB}`, o.energy]),
            ),
          },
          Math.min(1, 0.4 + 0.15 * lensesWithData),
          coverage,
          [],
          `Interpretations across ${energy.lensCount} lenses are ${state} (normalized disagreement ${energy.scoi.toFixed(2)}).`,
        ),
      );
    }
    return out;
  }
}

// --------------------------------------------------------------------------
// PHI
// --------------------------------------------------------------------------

export class PhiService extends BaseInvariantService {
  readonly invariantType = InvariantType.PHI;
  readonly tiers: TierDeclaration = { realtime: true, nearRealtime: true, batch: true };

  async computeBatch(
    _targets: readonly InvariantTarget[],
    window: InvariantTimeWindow,
  ): Promise<InvariantComputation[]> {
    const config = this.deps.config();
    const nowMs = this.deps.now();
    const sequences = await this.deps.sessions.listLive(nowMs);

    // Two detection passes (PHI-3, WS-H.6.2d): the stricter (lower) repeat
    // threshold is honored when the flagged cluster turns out to be a
    // sensitive topic. Minor strictness stays CLIENT-side by design — the
    // server session store is keyed by opaque digest and carries no
    // identity to resolve an age band against.
    const strictRepeats = effectiveRepeatThreshold(
      { sensitiveTopic: true, isMinor: false },
      config.phiThresholds,
    );
    const candidates: Array<{
      sessionKey: string;
      base: ReturnType<typeof detectNarrowLoop>;
      strict: ReturnType<typeof detectNarrowLoop>;
    }> = [];
    const clusterIds = new Set<string>();
    for (const { sessionKey, sequence } of sequences) {
      const base = detectNarrowLoop(sequence, nowMs, config.phiNarrowLoop);
      const strict =
        strictRepeats < config.phiNarrowLoop.repeatThreshold
          ? detectNarrowLoop(sequence, nowMs, {
              ...config.phiNarrowLoop,
              repeatThreshold: strictRepeats,
            })
          : base;
      if (!base.detected && !strict.detected) continue;
      candidates.push({ sessionKey, base, strict });
      for (const id of [...base.loopPath, ...strict.loopPath]) clusterIds.add(id);
    }
    if (candidates.length === 0) return [];

    // One assembly for every candidate cluster: behavioral structures from
    // topic content (the PAIR-transport estimator — per-topic frames would
    // telescope to the identity) + WS-F sensitivity labels.
    const topicData = await assemblePhiTopicData(this.deps.ingestion, [...clusterIds]);

    const out: InvariantComputation[] = [];
    for (const { sessionKey, base, strict } of candidates) {
      const strictIsSensitive =
        strict.detected &&
        strict.topicClusterId !== null &&
        topicData.sensitive.get(strict.topicClusterId) === true;
      const detection = strictIsSensitive ? strict : base;
      if (!detection.detected || detection.loopPath.length < 2) continue;
      const target: InvariantTarget = {
        targetType: 'session',
        targetId: deterministicEventId(`phi:${sessionKey}`),
      };
      const sensitive = detection.loopPath.some(
        (cluster) => topicData.sensitive.get(cluster) === true,
      );

      // Backtrack reduction: star-shaped revisit walks bound no area, so
      // their holonomy is the identity for ANY symmetric connection — PHI 0
      // with full confidence is the honest score, not a coverage gap.
      const cycle = holonomyCycleFromWalk(detection.loopPath);
      if (!cycle) {
        const scoreVector = {
          phi: 0,
          rotation_angles: [],
          loop_path: [...detection.loopPath],
          fallback_log: false,
          sensitive,
          loop_length: detection.loopPath.length,
          cycle_content: false,
        };
        assertGaugeInvariantBoundary(scoreVector);
        out.push(
          this.computation(
            target,
            window,
            scoreVector,
            0.7,
            1,
            [],
            `Revisit loop over ${new Set(detection.loopPath).size} topic contexts carries no multi-topic cycle; the preference frame is unchanged.`,
          ),
        );
        continue;
      }

      const distinct = [...new Set(cycle.slice(0, -1))];
      const structuresAvailable = distinct.filter((cluster) =>
        topicData.structures.has(cluster),
      ).length;
      const coverage = distinct.length === 0 ? 0 : structuresAvailable / distinct.length;
      const loop = coverage < 1 ? null : loopHolonomy(topicData.structures, cycle);
      if (!loop) {
        // Missing structures or a degenerate (rank-deficient) pair
        // alignment: no transport is estimable — degrade, never invent.
        out.push(
          this.computation(
            target,
            window,
            {},
            0,
            coverage < 1 ? coverage : Math.max(0, (distinct.length - 1) / distinct.length),
            ['INSUFFICIENT_COVERAGE'],
            null,
          ),
        );
        continue;
      }
      const score = phiScore(loop.h);
      const scoreVector = {
        phi: score.phi,
        rotation_angles: score.rotationAngles,
        loop_path: cycle,
        fallback_log: score.fallback,
        sensitive,
        trace: score.trace,
        loop_length: detection.loopPath.length,
        alignment_conditioning: loop.conditioning,
        cycle_content: true,
      };
      assertGaugeInvariantBoundary(scoreVector);
      out.push(
        this.computation(
          target,
          window,
          scoreVector,
          score.fallback ? 0.5 : 0.85,
          coverage,
          score.reasonCodes,
          `Cycle over ${distinct.length} topic contexts rotated the preference frame by PHI ${score.phi.toFixed(3)}.`,
        ),
      );
    }
    return out;
  }
}

// --------------------------------------------------------------------------
// Supporting invariants
// --------------------------------------------------------------------------

export class HodgeService extends BaseInvariantService {
  readonly invariantType = InvariantType.HodgeTension;
  readonly tiers: TierDeclaration = { realtime: false, nearRealtime: true, batch: true };

  async computeBatch(
    targets: readonly InvariantTarget[],
    window: InvariantTimeWindow,
  ): Promise<InvariantComputation[]> {
    const out: InvariantComputation[] = [];
    for (const target of targets) {
      const { interactions, total, resolvable } = await assembleConversationInteractions(
        this.deps.forum,
        target.targetId,
      );
      if (interactions.length === 0) {
        out.push(this.computation(target, window, {}, 0, 0, ['INSUFFICIENT_COVERAGE'], null));
        continue;
      }
      const decomposition = helmholtzDecompose(buildConversationComplex(interactions));
      // WS-J hostility seam: defaults to 0 — harmonic tension alone NEVER
      // penalizes (the HarmfulTensionRisk contract).
      const tension = assessTension({
        harmonicFraction: decomposition.harmonicFraction,
        curlFraction:
          decomposition.flowMagnitude > 0
            ? (decomposition.curlMagnitude / decomposition.flowMagnitude) ** 2
            : 0,
        hostilitySignal: 0,
      });
      out.push(
        this.computation(
          target,
          window,
          {
            gradient_magnitude: decomposition.gradientMagnitude,
            curl_magnitude: decomposition.curlMagnitude,
            harmonic_magnitude: decomposition.harmonicMagnitude,
            harmonic_fraction: decomposition.harmonicFraction,
            harmful_tension_risk: tension.harmfulTensionRisk,
            label: tension.label,
          },
          0.7,
          total === 0 ? 0 : resolvable / total,
          [],
          `Conversation flow decomposes to ${(decomposition.harmonicFraction * 100).toFixed(0)}% structural conflict (${tension.label}).`,
        ),
      );
    }
    return out;
  }
}

export class TropicalService extends BaseInvariantService {
  readonly invariantType = InvariantType.TropicalCascade;
  readonly tiers: TierDeclaration = { realtime: false, nearRealtime: true, batch: true };

  async computeBatch(
    _targets: readonly InvariantTarget[],
    window: InvariantTimeWindow,
  ): Promise<InvariantComputation[]> {
    const recent = await this.deps.ingestion.stories.listRecent(200);
    const topics = [...new Set(recent.flatMap((s) => s.topicIds))].sort();
    const out: InvariantComputation[] = [];
    for (const topicId of topics) {
      const cascade = await assembleTopicCascade(this.deps.ingestion, topicId);
      if (cascade.length === 0) continue;
      const matrix = buildTimingMatrix(cascade);
      const detection = detectSynchronizedCascade(matrix);
      const multiSeedFamilies = matrix.nodeIds.filter(
        (_, j) => matrix.arrivals.filter((row) => Number.isFinite(row[j] ?? Infinity)).length >= 2,
      ).length;
      out.push(
        this.computation(
          { targetType: 'feed', targetId: deterministicEventId(`tropical:${topicId}`) },
          window,
          {
            synchronized_fraction: detection.synchronizedFraction,
            arrival_profile_rank: detection.arrivalProfileRank,
            seed_count: detection.seedCount,
            coordinated_drop_count: detection.coordinatedDropNodes.length,
            detected: detection.detected,
          },
          detection.confidence,
          matrix.nodeIds.length === 0 ? 0 : multiSeedFamilies / matrix.nodeIds.length,
          [],
          detection.detected
            ? `Unusually synchronized arrivals across ${detection.seedCount} sources in topic ${topicId}.`
            : null,
        ),
      );
    }
    return out;
  }
}

export class BraidService extends BaseInvariantService {
  readonly invariantType = InvariantType.BraidDynamics;
  readonly tiers: TierDeclaration = { realtime: false, nearRealtime: false, batch: true };

  async computeBatch(
    _targets: readonly InvariantTarget[],
    window: InvariantTimeWindow,
  ): Promise<InvariantComputation[]> {
    const snapshots = await assembleActivitySnapshots(
      this.deps.events,
      this.deps.ingestion,
      this.deps.now(),
    );
    if (snapshots.length < 2) {
      return [
        this.computation(
          { targetType: 'feed', targetId: GLOBAL_FEED_TARGET_ID },
          window,
          {},
          0,
          0,
          ['INSUFFICIENT_COVERAGE'],
          null,
        ),
      ];
    }
    const { word, crossingNumber, strands } = braidWordFromSnapshots(snapshots);
    const entropy = braidEntropyEstimate(strands, word);
    const gaming = detectGaming(snapshots, 3, DEFAULT_GAMING_DETECTION);
    return [
      this.computation(
        { targetType: 'feed', targetId: GLOBAL_FEED_TARGET_ID },
        window,
        {
          crossing_number: crossingNumber,
          entropy,
          crossing_rate: crossingNumber / Math.max(1, snapshots.length - 1),
          strands,
          manufactured_churn: gaming.manufacturedChurn,
          threshold_gaming_count: gaming.thresholdGamingTopics.length,
        },
        0.7,
        1,
        [],
        `Agenda turbulence: ${crossingNumber} crossings over ${snapshots.length} windows (entropy bound ${entropy.toFixed(3)}).`,
      ),
    ];
  }
}

export class ReebService extends BaseInvariantService {
  readonly invariantType = InvariantType.ReebLandscape;
  readonly tiers: TierDeclaration = { realtime: false, nearRealtime: false, batch: true };

  async computeBatch(
    _targets: readonly InvariantTarget[],
    window: InvariantTimeWindow,
  ): Promise<InvariantComputation[]> {
    const { nodes, edges } = await assembleEngagementLandscape(
      this.deps.events,
      this.deps.ingestion,
      this.deps.now(),
    );
    if (nodes.length === 0) {
      return [
        this.computation(
          { targetType: 'feed', targetId: GLOBAL_FEED_TARGET_ID },
          window,
          {},
          0,
          0,
          ['INSUFFICIENT_COVERAGE'],
          null,
        ),
      ];
    }
    const graph = reebGraph(nodes, edges);
    const connected = new Set(edges.flatMap((e) => [e.a, e.b]));
    return [
      this.computation(
        { targetType: 'feed', targetId: GLOBAL_FEED_TARGET_ID },
        window,
        {
          peak_count: graph.peaks.length,
          merge_count: graph.merges.length,
          split_count: graph.splits.length,
          fragile_saddle_count: graph.bridgePrompts.length,
          final_basin_count: graph.finalBasins.length,
        },
        0.6,
        nodes.length === 0 ? 0 : connected.size / nodes.length,
        [],
        `${graph.peaks.length} attention basins; ${graph.bridgePrompts.length} fragile saddles (bridge prompts).`,
      ),
    ];
  }
}

export class CidService extends BaseInvariantService {
  readonly invariantType = InvariantType.CounterfactualDefect;
  readonly tiers: TierDeclaration = { realtime: false, nearRealtime: false, batch: true };

  async computeBatch(
    _targets: readonly InvariantTarget[],
    window: InvariantTimeWindow,
  ): Promise<InvariantComputation[]> {
    // The v0 freshness ranking ignores every protected attribute BY
    // CONSTRUCTION; the audit certifies that and exercises the gate the
    // WS-I models will face. The ranking representation here mirrors the
    // v0 inputs: creation recency only.
    const group = generateGroup([
      { id: 'locale:swap', attribute: 'locale', mapping: { en: 'es', es: 'en' } },
      {
        id: 'age_band:swap',
        attribute: 'age_band',
        mapping: { adult: 'unknown', unknown: 'adult' },
      },
    ]);
    const stories = await this.deps.ingestion.stories.listRecent(20);
    const nowMs = this.deps.now();
    let worst = 0;
    let evaluated = 0;
    for (const story of stories) {
      // v0 ranking feature: freshness only — attribute-blind AND a pure
      // function per story (the clock is captured once; a per-call clock
      // read would smuggle nondeterminism into the audit itself).
      const freshness = Date.parse(story.createdAt) / nowMs;
      const result = counterfactualInvarianceDefect(
        () => freshness,
        { topic: story.topicIds[0] ?? 'untagged' },
        { locale: 'en', age_band: 'adult' },
        group,
      );
      worst = Math.max(worst, result.cid);
      evaluated += 1;
    }
    const gate = cidReleaseGate(worst, 0.05);
    return [
      this.computation(
        { targetType: 'feed', targetId: GLOBAL_FEED_TARGET_ID },
        window,
        {
          cid: worst,
          element_count: group.length,
          threshold: gate.threshold,
          blocked: gate.blocked,
        },
        evaluated > 0 ? 0.9 : 0,
        evaluated > 0 ? 1 : 0,
        [],
        `Worst-case ranking deviation under protected-attribute transformations: ${worst.toFixed(4)}.`,
      ),
    ];
  }
}

export class PathSignatureService extends BaseInvariantService {
  readonly invariantType = InvariantType.PathSignatureWellbeing;
  readonly tiers: TierDeclaration = { realtime: true, nearRealtime: true, batch: true };

  async computeBatch(
    _targets: readonly InvariantTarget[],
    window: InvariantTimeWindow,
  ): Promise<InvariantComputation[]> {
    const nowMs = this.deps.now();
    const sequences = await this.deps.sessions.listLive(nowMs);
    const out: InvariantComputation[] = [];
    for (const { sessionKey, sequence } of sequences) {
      if (sequence.length < 2) continue;
      const events = sessionEventsFromSequence(sequence);
      const health = classifySessionHealth(events);
      out.push(
        this.computation(
          { targetType: 'session', targetId: deterministicEventId(`pathsig:${sessionKey}`) },
          window,
          {
            classification: health.classification,
            event_count: health.features.eventCount,
            distinct_topics: health.features.distinctTopics,
            deep_action_share: health.features.deepActionShare,
            rapid_return_count: health.features.rapidReturnCount,
            action_time_area: health.features.actionTimeArea,
          },
          Math.min(0.9, 0.3 + 0.05 * health.features.eventCount),
          1,
          [],
          `Session pattern classified ${health.classification}.`,
        ),
      );
    }
    return out;
  }
}
