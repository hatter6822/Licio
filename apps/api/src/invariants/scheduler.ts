// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H batch-tier scheduler (WS-H.1.2f), following the WS-E/F lease-guarded
// pattern: every instance ticks hourly, the Postgres job lease grants at
// most one executor per window, and each task is independent (one failure
// never blocks the others — the fallback wrapper guarantees that per
// invariant too). The nightly tick (hour 0 UTC) additionally runs the
// regression suite against the production algorithm versions and records
// the drift report (WS-H.1.2d-2).

import {
  buildNullCalibration,
  detectThresholdHugging,
  type InvariantTarget,
  runRegressionSuite,
  synchronyScore,
  targetConcentrationScore,
} from '@licio/invariants';
import type { EventPipelineServices } from '../events/services.js';
import { AlwaysGrantJobLeaseStore, type JobLeaseStore } from '../identity/job-lease.js';
import type { IngestionServices } from '../ingestion/services.js';
import type { InvariantsRuntimeConfig } from './config.js';
import { hourWindow, mapBounded, persistComputations, runGuarded } from './runner.js';
import type { InvariantPlatformServices } from './services.js';
import { GLOBAL_FEED_TARGET_ID } from './services-impl.js';

export const INVARIANTS_JOB_LEASE = 'invariants_hourly';
export const INVARIANTS_SCHEDULER_INTERVAL_MS = 3_600_000;

export type InvariantsSchedulerTask =
  | 'config_reload'
  | 'batch_compute'
  | 'threshold_hugging_scan'
  | 'session_sweep'
  | 'nightly_regression'
  | 'calibration_rebuild';

/**
 * The configuration slice an invariant's outputs were computed under —
 * persisted as `version_metadata.config` on every row so WS-H.1.1b version
 * comparisons can tell algorithm drift from configuration drift.
 */
export function configSnapshotFor(
  invariantType: string,
  config: InvariantsRuntimeConfig,
): Record<string, unknown> {
  const slices: Record<string, Record<string, unknown>> = {
    MERI: {
      candidate_limit: config.meriCandidateLimit,
      near_duplicate_threshold: config.meriNearDuplicateThreshold,
    },
    MFCI: {
      samples: config.mfciSamples,
      burn_in: config.mfciBurnIn,
      thinning: config.mfciThinning,
      risk_thresholds: config.mfciRiskThresholds,
    },
    GWEI: {
      seeds: config.gweiSeeds,
      epsilons: config.gweiEpsilons,
      k_anonymity: config.gweiKAnonymity,
      min_cohort_size: config.gweiMinCohortSize,
    },
    SCOI: {
      state_thresholds: config.scoiStateThresholds,
      needs_context_threshold: config.scoiNeedsContextThreshold,
    },
    PHI: {
      narrow_loop: config.phiNarrowLoop,
      thresholds: config.phiThresholds,
      sequence_cap: config.phiSequenceCap,
    },
  };
  return { config: slices[invariantType] ?? {} };
}

/** One scheduler tick: config reload → batch tier → sweeps → nightly drift. */
export async function runInvariantsTick(
  invariants: InvariantPlatformServices,
  events: EventPipelineServices,
  ingestion: IngestionServices,
  onError: (err: unknown, task: InvariantsSchedulerTask) => void = () => {},
  nowMs: number = invariants.now(),
): Promise<void> {
  try {
    await invariants.reloadConfig();
  } catch (err) {
    onError(err, 'config_reload');
  }

  try {
    await runBatchTier(invariants, events, ingestion, nowMs);
  } catch (err) {
    onError(err, 'batch_compute');
  }

  try {
    await runThresholdHuggingScan(invariants, events, nowMs);
  } catch (err) {
    onError(err, 'threshold_hugging_scan');
  }

  try {
    await invariants.sessions.sweepExpired(nowMs);
  } catch (err) {
    onError(err, 'session_sweep');
  }

  // Nightly (00:xx UTC): regression drift report against production code,
  // then the MFCI null-calibration rebuild from the trailing week's
  // ORGANIC baseline (so the cheap statistics judge against current
  // community behavior, not the bootstrap defaults).
  if (new Date(nowMs).getUTCHours() === 0) {
    try {
      const report = runRegressionSuite();
      invariants.log('invariants.regression.nightly', {
        pass: report.pass,
        checks: report.checks.length,
        failures: report.failures.map((f) => `${f.invariant}/${f.dataset}/${f.metric}`),
      });
      events.metrics.increment(
        report.pass ? 'invariants.regression.pass' : 'invariants.regression.drift',
      );
    } catch (err) {
      onError(err, 'nightly_regression');
    }
    try {
      await rebuildMfciCalibrations(invariants, events, nowMs);
    } catch (err) {
      onError(err, 'calibration_rebuild');
    }
  }
}

/** How far back the meta-monitor reads each invariant's recent outputs. */
const THRESHOLD_HUGGING_LOOKBACK_MS = 24 * 3_600_000;
/** Cap on outputs read per invariant type (a bounded, targeted read). */
const THRESHOLD_HUGGING_READ_LIMIT = 2_000;

/**
 * Threshold-bearing invariants the meta-monitor scans: the score key in the
 * `score_vector`, the public threshold from config, and whether a detection
 * routes the flagged targets to the exact MFCI fiber test. Cross-invariant
 * hugging of SCOI/PHI suggests manufactured near-divergence/near-loop worth a
 * COORDINATION re-check; MFCI's own borderline targets were already fiber-tested
 * (their `mfci` is the exact statistic), so MFCI only emits the metric.
 */
const THRESHOLD_BEARING: ReadonlyArray<{
  type: string;
  scoreKey: string;
  threshold: (c: InvariantsRuntimeConfig) => number;
  routeToMfci: boolean;
}> = [
  {
    type: 'MFCI',
    scoreKey: 'mfci',
    threshold: (c) => c.mfciRiskThresholds.elevated,
    routeToMfci: false,
  },
  {
    type: 'SCOI',
    scoreKey: 'scoi',
    threshold: (c) => c.scoiNeedsContextThreshold,
    routeToMfci: true,
  },
  {
    type: 'PHI',
    scoreKey: 'phi',
    threshold: (c) => c.phiThresholds.baseThreshold,
    routeToMfci: true,
  },
];

/**
 * WS-O.4.5 — the cross-invariant THRESHOLD-HUGGING meta-monitor. For each
 * threshold-bearing invariant it reads the recent score population across
 * targets and flags an anomalous mass JUST UNDER the (public, deterministic)
 * threshold — the signature of an attacker who read the open-source threshold
 * and tuned activity to sit a hair below the cliff. Knowing the threshold thus
 * becomes a LIABILITY: a detection emits a metric and routes the flagged targets
 * to the EXACT MFCI fiber test (the calibration-independent backstop), never a
 * direct action (the invariants are shadow-only). Read-only over
 * `invariant_outputs`, bounded per type, and FAIL-CLOSED (the primitive declines
 * to flag a small population or a no-spread/all-hugging distribution).
 */
export async function runThresholdHuggingScan(
  invariants: InvariantPlatformServices,
  events: EventPipelineServices,
  nowMs: number,
): Promise<void> {
  const config = invariants.config();
  const sinceIso = new Date(nowMs - THRESHOLD_HUGGING_LOOKBACK_MS).toISOString();
  for (const spec of THRESHOLD_BEARING) {
    const rows = await events.invariantStore.listByTypeSince(
      spec.type,
      sinceIso,
      THRESHOLD_HUGGING_READ_LIMIT,
    );
    // Latest score per target (rows are newest-first) — never count a target twice.
    const latestByTarget = new Map<string, number>();
    for (const row of rows) {
      if (latestByTarget.has(row.targetId)) continue;
      const raw = row.scoreVector[spec.scoreKey];
      if (typeof raw === 'number' && Number.isFinite(raw)) latestByTarget.set(row.targetId, raw);
    }
    const threshold = spec.threshold(config);
    const band = config.thresholdHuggingBandFraction * threshold;
    const result = detectThresholdHugging([...latestByTarget.values()], threshold, {
      band,
      minPopulation: config.thresholdHuggingMinPopulation,
      excessThreshold: config.thresholdHuggingExcess,
    });
    if (!result.detected) continue;
    const flagged = [...latestByTarget.entries()]
      .filter(([, score]) => score >= threshold - band && score < threshold)
      .map(([targetId]) => targetId);
    invariants.log('invariants.threshold_hugging.detected', {
      invariant: spec.type,
      excess: result.excess,
      band_count: result.bandCount,
      population: result.population,
      flagged: flagged.length,
    });
    events.metrics.increment('invariants.threshold_hugging.detected');
    // Cross-invariant escalation: route the hugging targets to the exact MFCI
    // fiber test (fail-toward-caution; never an auto-action).
    if (spec.routeToMfci && flagged.length > 0 && events.hooks.mfci) {
      await events.hooks.mfci({ target_ids: flagged.slice(0, 10) } as never);
    }
  }
}

const CALIBRATION_TOPICS = ['contribution.created', 'evidence.added', 'content.submitted'];

/**
 * Rebuild the MFCI null calibrations (WS-H.3.1a "precomputed null
 * calibrations established from historical baseline data"): hourly windows
 * over the trailing 7 days each contribute one (volume, rawValue) sample
 * per statistic — the SAME window size and action source the sub-minute
 * intake scores against, so the null conditions on exactly what the
 * statistic sees. Too few nonempty windows keeps the previous calibration
 * (never replace a baseline with noise).
 *
 * Contamination note: windows containing coordinated bursts are NOT
 * excluded from the baseline, so sustained attacks could gradually lift
 * the q99 and desensitize the CHEAP path. The exact fiber test is the
 * calibration-independent backstop (margins-conditioned, recomputed per
 * window), and analyst case review covers the residual. Window exclusion
 * keyed on opened cases is a deliberate hardening follow-up (WS-J owns
 * the case-lifecycle signals it would key on).
 */
export async function rebuildMfciCalibrations(
  invariants: InvariantPlatformServices,
  events: EventPipelineServices,
  nowMs: number,
  options: { lookbackHours?: number; minSamples?: number } = {},
): Promise<void> {
  const lookbackHours = options.lookbackHours ?? 7 * 24;
  const minSamples = options.minSamples ?? 6;
  const fromIso = new Date(nowMs - lookbackHours * 3_600_000).toISOString();
  const toIso = new Date(nowMs).toISOString();
  const rows = await events.eventStore.listByTopicsBetween(CALIBRATION_TOPICS, fromIso, toIso);
  const byHour = new Map<number, Array<{ actorRef: string; targetId: string; atMs: number }>>();
  for (const row of rows) {
    const targetId =
      typeof row.payload['story_id'] === 'string'
        ? row.payload['story_id']
        : typeof row.payload['thread_id'] === 'string'
          ? row.payload['thread_id']
          : null;
    if (!targetId) continue;
    const atMs = Date.parse(row.timestamp);
    const hour = Math.floor(atMs / 3_600_000);
    const list = byHour.get(hour) ?? [];
    list.push({ actorRef: row.ownerUserId ?? 'anonymous', targetId, atMs });
    byHour.set(hour, list);
  }
  // rawValue is calibration-independent; a bucketless neutral calibration
  // extracts it without scoring.
  const neutral = {
    statistic: 'target_concentration' as const,
    version: 'neutral',
    computedAtMs: nowMs,
    buckets: [],
  };
  const samples = {
    target_concentration: [] as Array<{ volume: number; rawValue: number }>,
    synchrony: [] as Array<{ volume: number; rawValue: number }>,
  };
  for (const actions of byHour.values()) {
    if (actions.length === 0) continue;
    samples.target_concentration.push({
      volume: actions.length,
      rawValue: targetConcentrationScore(actions, neutral, { nowMs }).rawValue,
    });
    samples.synchrony.push({
      volume: actions.length,
      rawValue: synchronyScore(actions, { ...neutral, statistic: 'synchrony' }, { nowMs }).rawValue,
    });
  }
  for (const statistic of ['target_concentration', 'synchrony'] as const) {
    const list = samples[statistic];
    if (list.length < minSamples) continue;
    const version = `auto:${new Date(nowMs).toISOString().slice(0, 10)}`;
    const calibration = buildNullCalibration(statistic, version, nowMs, list);
    if (calibration.buckets.length === 0) continue;
    await invariants.calibrations.upsert({
      calibrationKey: `mfci:${statistic}`,
      version,
      data: calibration as unknown as Record<string, unknown>,
      sampleCount: list.length,
      computedAt: new Date(nowMs).toISOString(),
    });
    invariants.log('invariants.mfci.calibration_rebuilt', {
      statistic,
      version,
      windows: list.length,
      buckets: calibration.buckets.length,
    });
  }
}

/** The batch tier: run every invariant guarded, persist shadow outputs. */
export async function runBatchTier(
  invariants: InvariantPlatformServices,
  events: EventPipelineServices,
  ingestion: IngestionServices,
  nowMs: number,
): Promise<void> {
  const config = invariants.config();
  const window = hourWindow(nowMs);
  const deps = {
    runMetadata: invariants.runMetadata,
    metrics: events.metrics,
    log: invariants.log,
    now: invariants.now,
  };

  // Target assembly per invariant family.
  const recentStories = await ingestion.stories.listRecent(50);
  const storyTargets = recentStories.map((s) => ({
    targetType: 'story' as const,
    targetId: s.storyId,
  }));
  const threadTargets: Array<{ targetType: 'thread'; targetId: string }> = [];
  for (const story of recentStories.slice(0, 25)) {
    const thread = await ingestion.stories.getThreadByStoryId(story.storyId);
    if (thread) threadTargets.push({ targetType: 'thread', targetId: thread.threadId });
  }
  const feedTarget = { targetType: 'feed' as const, targetId: GLOBAL_FEED_TARGET_ID };

  // One uniform job runner: guard → observe health → persist with the
  // invariant's CONFIG SNAPSHOT in version_metadata (WS-H.1.1b: version
  // comparisons can tell algorithm drift from configuration drift).
  type AnyService = ReturnType<InvariantPlatformServices['all']>[number];
  const runAndPersist = async (
    name: string,
    service: AnyService,
    target: InvariantTarget | null,
    work: () => Promise<Awaited<ReturnType<AnyService['computeBatch']>>>,
    afterPersist?: (outputs: Awaited<ReturnType<AnyService['computeBatch']>>) => Promise<void>,
  ): Promise<void> => {
    const run = await runGuarded(
      deps,
      name,
      service.getCard().version,
      'batch',
      target,
      config.wrapperTimeoutMs,
      work,
    );
    if (run.ok) {
      service.health.observe(run.durationMs, run.outputs);
      await persistComputations(
        events.invariantStore,
        deps,
        run.outputs,
        configSnapshotFor(service.invariantType, config),
      );
      await afterPersist?.(run.outputs);
    } else service.health.observeError();
  };

  const jobs: Array<() => Promise<void>> = [
    () =>
      runAndPersist('MERI', invariants.meri, feedTarget, () =>
        invariants.meri.computeBatch([feedTarget], window),
      ),
    async () => {
      // MFCI batch: the hottest recent stories (cap: 3 targets per tick).
      const targets = storyTargets.slice(0, 3);
      if (targets.length === 0) return;
      await runAndPersist('MFCI', invariants.mfci, targets[0] ?? null, () =>
        invariants.mfci.computeBatch(targets, window),
      );
    },
    () =>
      runAndPersist('GWEI', invariants.gwei, null, () => invariants.gwei.computeBatch([], window)),
    () =>
      runAndPersist('SCOI', invariants.scoi, null, () =>
        invariants.scoi.computeBatch(storyTargets, window),
      ),
    () => runAndPersist('PHI', invariants.phi, null, () => invariants.phi.computeBatch([], window)),
    () =>
      runAndPersist('hodge_tension', invariants.hodge, null, () =>
        invariants.hodge.computeBatch(threadTargets, window),
      ),
    () =>
      runAndPersist(
        'tropical_cascade',
        invariants.tropical,
        null,
        () => invariants.tropical.computeBatch([], window),
        async (outputs) => {
          // Tropical → MFCI feature feed: a DETECTED synchronized cascade
          // routes the topic's recent stories through the SAME cheap-stat
          // intake the WS-E integrity events use — the intake re-checks
          // each target and only opens a case when the statistics confirm
          // (fail-toward-caution; never an auto-action).
          if (!events.hooks.mfci) return;
          const targetIds = new Set<string>();
          for (const output of outputs) {
            if (output.score_vector['detected'] !== true) continue;
            const topicId = output.score_vector['topic_id'];
            if (typeof topicId !== 'string') continue;
            for (const story of recentStories) {
              if (story.topicIds.includes(topicId)) targetIds.add(story.storyId);
              if (targetIds.size >= 10) break;
            }
          }
          if (targetIds.size > 0) {
            await events.hooks.mfci({ target_ids: [...targetIds] } as never);
          }
        },
      ),
    () =>
      runAndPersist('braid_dynamics', invariants.braid, null, () =>
        invariants.braid.computeBatch([], window),
      ),
    () =>
      runAndPersist('reeb_landscape', invariants.reeb, null, () =>
        invariants.reeb.computeBatch([], window),
      ),
    () =>
      runAndPersist('counterfactual_defect', invariants.cid, null, () =>
        invariants.cid.computeBatch([], window),
      ),
    () =>
      runAndPersist('path_signature_wellbeing', invariants.pathsig, null, () =>
        invariants.pathsig.computeBatch([], window),
      ),
  ];
  // Bounded concurrency: the batch tier may never starve real-time work.
  await mapBounded(jobs, config.batchConcurrency, (job) => job());
}

/**
 * The REAL-TIME tier entry point (WS-H.1.2f): run one realtime-capable
 * invariant for a target under the configured latency budget. The budget is
 * ENFORCED — a slow computation times out into the standard degraded
 * envelope (TIMEOUT) and ranking proceeds with the feature ABSENT. Health
 * is observed on the same per-invariant recorder as the batch tier.
 * Batch-only invariants answer through their honest degraded default.
 * (WS-I consumes this at the ranking boundary; until then it serves the
 * admin surface and tests.)
 */
export async function runRealtimeTier(
  invariants: InvariantPlatformServices,
  events: EventPipelineServices,
  invariantType: string,
  target: InvariantTarget,
): Promise<
  | { ok: true; output: Awaited<ReturnType<InvariantPlatformServices['meri']['computeRealtime']>> }
  | { ok: false; reasonCodes: string[] }
> {
  const config = invariants.config();
  const service = invariants.all().find((s) => s.invariantType === invariantType);
  if (!service) return { ok: false, reasonCodes: ['COMPUTE_ERROR'] };
  const run = await runGuarded(
    {
      runMetadata: invariants.runMetadata,
      metrics: events.metrics,
      log: invariants.log,
      now: invariants.now,
    },
    invariantType,
    service.getCard().version,
    'realtime',
    target,
    config.realtimeLatencyBudgetMs,
    async () => [await service.computeRealtime(target)],
  );
  if (!run.ok) {
    service.health.observeError();
    return { ok: false, reasonCodes: run.degraded.reason_codes };
  }
  service.health.observe(run.durationMs, run.outputs);
  const output = run.outputs[0];
  if (!output) return { ok: false, reasonCodes: ['COMPUTE_ERROR'] };
  return { ok: true, output };
}

/** Start the hourly scheduler under the distributed lease. */
export function startInvariantsScheduler(
  invariants: InvariantPlatformServices,
  events: EventPipelineServices,
  ingestion: IngestionServices,
  onError: (err: unknown, task: InvariantsSchedulerTask | 'lease') => void = () => {},
  intervalMs: number = INVARIANTS_SCHEDULER_INTERVAL_MS,
  runner: { lease: JobLeaseStore; holder?: string } = { lease: new AlwaysGrantJobLeaseStore() },
): () => void {
  const holder = runner.holder ?? `invariants-${Math.random().toString(36).slice(2, 10)}`;
  const timer = setInterval(async () => {
    try {
      const granted = await runner.lease.tryAcquire(
        INVARIANTS_JOB_LEASE,
        Math.floor(intervalMs * 0.9),
        holder,
      );
      if (!granted) return;
    } catch (err) {
      onError(err, 'lease');
      return; // fail closed: no lease, no tick
    }
    await runInvariantsTick(invariants, events, ingestion, onError);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
