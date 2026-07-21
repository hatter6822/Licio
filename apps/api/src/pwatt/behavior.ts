// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot-prevention layer 2: the per-actor behavior fold + the authenticity
// assessment job (the operational side of @licio/invariants behavior math).
//
//   • foldActorBehaviorWindows — a pure projection of the SAME deduplicated
//     window fold PWAtt scores into per-ACTOR snapshots (per-item MAX buckets
//     counted into histograms).  Only identifiable actors are recorded; the
//     coarse privacy-bucket actor is never profiled (anonymity is never
//     penalized, WS-O.4.5 doctrine).
//   • runBehaviorAuthenticityJob — the hourly batch assessment: coherence per
//     actor (variety / breadth / rhythm), cross-account duplication via the
//     frozen MinHash family over the canonical behavior stream, deterministic
//     cluster ids, and the effective multiplier upsert PWAtt scoring reads.
//
// Everything is idempotent and deterministic for a given store state
// (§30.6): snapshots upsert on (actor, window); assessments upsert on actor;
// cluster ids hash their sorted membership.
import { createHash } from 'node:crypto';
import {
  type ActorBehaviorWindow,
  assessAuthenticity,
  type BehaviorAuthenticityConfig,
  behaviorStreamText,
  effectiveAuthenticity,
  estimateJaccard,
  lshBandHashes,
  minhashSignature,
} from '@licio/invariants';
import type { DwellBucket, ReplyDepthBucket, ReturnVisitBucket } from '@licio/shared';
import type { EventPipelineServices } from '../events/services.js';
import {
  type ActorBehaviorWindowRecord,
  PRIVACY_BUCKET,
  PSEUDONYMOUS_USER_ID,
} from '../events/stores.js';
import type { WindowAggregationResult } from './aggregation.js';

/** Synthetic actor keys that are NEVER profiled by the behavior fold: the
 *  coarse minimum-privacy bucket (anonymity), and the deletion pseudonym that
 *  account hard-purge stamps onto surviving public contributions (§19.2). The
 *  pseudonym pools many deleted users into one id and — critically — has no
 *  `users` row, so folding it would violate the production `actor_ref` FK and
 *  crash the window run (the InMemory adapter would accept it silently, hiding
 *  the fault in dev). Skipping both keeps the fold to genuine, identifiable
 *  actors, matching the PWAtt trust-factor's anonymity treatment. */
const UNPROFILED_ACTOR_KEYS: ReadonlySet<string> = new Set([PRIVACY_BUCKET, PSEUDONYMOUS_USER_ID]);

/** Assessment lookback: 7 days of hourly windows (≤ 168 per actor). */
export const BEHAVIOR_LOOKBACK_MS = 7 * 24 * 3_600_000;

/** Snapshot retention: 2× the lookback, pruned by the hourly job. */
export const BEHAVIOR_WINDOW_RETENTION_MS = 14 * 24 * 3_600_000;

/** Minimum ACTIVE windows before an actor's stream enters duplication
 *  clustering — signatures over tiny streams are noise, and a fleet needs a
 *  sustained shared shape to be a fleet. */
export const MIN_SIGNATURE_WINDOWS = 12;

function increment<K extends string>(
  histogram: Partial<Record<K, number>>,
  bucket: K | undefined,
): void {
  if (bucket === undefined || bucket === ('none' as K)) return;
  histogram[bucket] = (histogram[bucket] ?? 0) + 1;
}

/**
 * Project one scored window's per-(actor, item) folds into per-ACTOR behavior
 * snapshots.  Pure: same aggregation ⇒ same records (windowStart comes from
 * the aggregation itself), so a window re-score converges by upsert.
 */
export function foldActorBehaviorWindows(
  aggregation: WindowAggregationResult,
): ActorBehaviorWindowRecord[] {
  const byActor = new Map<string, ActorBehaviorWindowRecord>();
  for (const item of aggregation.items.values()) {
    for (const [actorKey, fold] of item.actors) {
      if (UNPROFILED_ACTOR_KEYS.has(actorKey)) continue; // anonymity + deletion pseudonym
      let record = byActor.get(actorKey);
      if (!record) {
        record = {
          actorRef: actorKey,
          windowStart: aggregation.windowStart,
          eventCount: 0,
          itemsTouched: 0,
          dwellHistogram: {},
          replyDepthHistogram: {},
          returnHistogram: {},
          sourceOpens: 0,
          contextOpens: 0,
          saves: 0,
          contributions: 0,
        };
        byActor.set(actorKey, record);
      }
      record.eventCount += fold.eventCount;
      record.itemsTouched += 1;
      increment<DwellBucket>(record.dwellHistogram, fold.dwellBucket);
      increment<ReplyDepthBucket>(record.replyDepthHistogram, fold.branchDepthBucket);
      increment<ReturnVisitBucket>(record.returnHistogram, fold.returnVisitBucket);
      if (fold.sawMeaningfulSourceOpen) record.sourceOpens += 1;
      if (fold.contextOpened) record.contextOpens += 1;
      if (fold.saved) record.saves += 1;
      record.contributions += Object.values(fold.contributions).reduce(
        (sum, n) => sum + (n ?? 0),
        0,
      );
    }
  }
  return [...byActor.values()].sort((a, b) => a.actorRef.localeCompare(b.actorRef));
}

/** Deterministic cluster id: a digest of the sorted membership, so re-runs
 *  and replicas agree without coordination. */
function clusterIdOf(members: readonly string[]): string {
  const digest = createHash('sha256');
  digest.update('behavior-cluster-v1');
  for (const member of [...members].sort()) digest.update(`|${member}`);
  return digest.digest('hex').slice(0, 32);
}

/** Union-find over actor indices (path-halving; order-independent result). */
class UnionFind {
  readonly #parent: number[];
  constructor(size: number) {
    this.#parent = Array.from({ length: size }, (_, i) => i);
  }
  find(x: number): number {
    let root = x;
    while (this.#parent[root] !== root) {
      const parent = this.#parent[root] as number;
      this.#parent[root] = this.#parent[parent] as number;
      root = parent;
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.#parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

export interface BehaviorAuthenticityReport {
  actorsAssessed: number;
  flagged: number;
  clusterCount: number;
  largestClusterSize: number;
}

/**
 * The hourly assessment: coherence per active actor, LSH-candidate + verified
 * Jaccard duplication clustering, effective-multiplier upserts, and snapshot
 * retention pruning.  Deterministic for a given store state.
 */
export async function runBehaviorAuthenticityJob(
  events: EventPipelineServices,
  config: BehaviorAuthenticityConfig,
  nowMs: number = events.now(),
): Promise<BehaviorAuthenticityReport> {
  const sinceIso = new Date(nowMs - BEHAVIOR_LOOKBACK_MS).toISOString();
  const windows = await events.behaviorStore.listWindowsSince(sinceIso);
  const byActor = new Map<string, ActorBehaviorWindow[]>();
  for (const record of windows) {
    const list = byActor.get(record.actorRef) ?? [];
    list.push(record);
    byActor.set(record.actorRef, list);
  }

  // --- Coherence per actor (pure) -----------------------------------------
  const actors = [...byActor.keys()].sort();
  const assessments = new Map<string, ReturnType<typeof assessAuthenticity>>();
  for (const actorRef of actors) {
    assessments.set(actorRef, assessAuthenticity(byActor.get(actorRef) ?? [], config));
  }

  // --- Cross-account duplication (MinHash + LSH candidates, verified) ------
  const eligible = actors.filter(
    (actorRef) =>
      (byActor.get(actorRef) ?? []).filter((w) => w.eventCount > 0).length >= MIN_SIGNATURE_WINDOWS,
  );
  const signatures = new Map<string, Uint32Array>();
  for (const actorRef of eligible) {
    signatures.set(actorRef, minhashSignature(behaviorStreamText(byActor.get(actorRef) ?? [])));
  }
  const unionFind = new UnionFind(eligible.length);
  const buckets = new Map<string, number[]>();
  eligible.forEach((actorRef, index) => {
    const signature = signatures.get(actorRef) as Uint32Array;
    lshBandHashes(signature).forEach((bandHash, band) => {
      const key = `${band}:${bandHash}`;
      const bucket = buckets.get(key) ?? [];
      bucket.push(index);
      buckets.set(key, bucket);
    });
  });
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const a = bucket[i] as number;
        const b = bucket[j] as number;
        if (unionFind.find(a) === unionFind.find(b)) continue;
        const sigA = signatures.get(eligible[a] as string) as Uint32Array;
        const sigB = signatures.get(eligible[b] as string) as Uint32Array;
        if (estimateJaccard(sigA, sigB) >= config.duplicationJaccard) unionFind.union(a, b);
      }
    }
  }
  const componentMembers = new Map<number, string[]>();
  eligible.forEach((actorRef, index) => {
    const root = unionFind.find(index);
    const members = componentMembers.get(root) ?? [];
    members.push(actorRef);
    componentMembers.set(root, members);
  });
  const clusterByActor = new Map<string, { clusterId: string; clusterSize: number }>();
  let clusterCount = 0;
  let largestClusterSize = 0;
  for (const members of componentMembers.values()) {
    if (members.length < config.minClusterSize) continue;
    clusterCount += 1;
    largestClusterSize = Math.max(largestClusterSize, members.length);
    const clusterId = clusterIdOf(members);
    for (const member of members) {
      clusterByActor.set(member, { clusterId, clusterSize: members.length });
    }
  }

  // --- Effective multipliers + upsert --------------------------------------
  const computedAt = new Date(nowMs).toISOString();
  let flagged = 0;
  const records = actors.map((actorRef) => {
    const assessment = assessments.get(actorRef) as ReturnType<typeof assessAuthenticity>;
    const cluster = clusterByActor.get(actorRef) ?? { clusterId: null, clusterSize: 1 };
    const score = effectiveAuthenticity(assessment.coherence, cluster.clusterSize, config);
    const flags = [
      ...assessment.flags,
      ...(cluster.clusterSize >= config.minClusterSize ? ['behavior_duplication'] : []),
    ];
    if (score < 1) flagged += 1;
    return {
      actorRef,
      score,
      coherence: assessment.coherence,
      components: {
        dwell_variety: assessment.components.dwellVariety.score,
        interaction_breadth: assessment.components.interactionBreadth.score,
        temporal_rhythm: assessment.components.temporalRhythm.score,
      },
      flags,
      evidence: assessment.evidence,
      clusterId: cluster.clusterId,
      clusterSize: cluster.clusterSize,
      computedAt,
    };
  });
  if (records.length > 0) await events.behaviorStore.upsertAuthenticity(records);

  // --- Retention: BOTH planes (self-limiting state) ------------------------
  // Snapshots older than the retention horizon, AND assessments not refreshed
  // since it (their actor went fully dormant — the job only re-upserts actors
  // with a window in the lookback, so a dormant actor's `computedAt` freezes).
  // Pruning both keeps the population statistics + the tables bounded to the
  // recently-active population the BAI invariant claims to describe, rather than
  // accumulating every actor ever assessed.
  const cutoffIso = new Date(nowMs - BEHAVIOR_WINDOW_RETENTION_MS).toISOString();
  const windowsPruned = await events.behaviorStore.deleteWindowsOlderThan(cutoffIso);
  const assessmentsPruned = await events.behaviorStore.deleteAuthenticityOlderThan(cutoffIso);

  const report: BehaviorAuthenticityReport = {
    actorsAssessed: records.length,
    flagged,
    clusterCount,
    largestClusterSize,
  };
  events.metrics.increment('behavior.assessed', records.length);
  events.metrics.increment('behavior.flagged', flagged);
  events.metrics.increment('behavior.clusters', clusterCount);
  events.log('behavior.authenticity.assessed', {
    actors: records.length,
    flagged,
    clusters: clusterCount,
    largest_cluster: largestClusterSize,
    windows_pruned: windowsPruned,
    assessments_pruned: assessmentsPruned,
  });
  return report;
}
