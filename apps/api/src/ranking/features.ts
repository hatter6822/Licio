// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2.1d — the feature-store population pipeline: real-time (a durable
// router consumer on `invariant.run.completed`) and batch (the scheduler
// tick) both assemble feature vectors through THIS one function, and every
// write passes the same schema + denylist gate inside the store — there is
// no privileged path around validation.
//
// ABSENT-feature semantics (WS-H.1.2c): a missing, degraded (fallback with
// TIMEOUT/COMPUTE_ERROR), or insufficient-coverage invariant output leaves
// its fields OFF the vector entirely. Ranking proceeds with the contribution
// omitted; nothing is fabricated.
//
// Field sources (WS-I.2.1a provenance):
//   PWAtt_v1/v0 story rows → active_attention, constructive_participation
//   MERI feed row          → exposure_independence (marginal gain),
//                            meri_rank (rank among gains)
//   WS-E redundancy hook   → redundancy_penalty
//   MFCI risk-state store + story row → mfci_score, mfci_risk_state
//   Hodge thread row       → hodge_harmonic_tension, harmful_tension_risk
//   Tropical topic rows    → tropical_cascade_rank (max synchronized share)
//   WS-F freshness store   → freshness_decay
//   WS-F source profile    → source_reliability
//   WS-F claims/evidence   → source_evidence_completeness
//   WS-F MinHash near-dups → duplicate_cluster_id (min-id over mutual hits;
//                            the exact components are MERI's concern — this
//                            key only feeds the per-page cluster cap)

import { createHash } from 'node:crypto';
import { lshBandHashes } from '@licio/invariants';
import {
  FEATURE_SCHEMA_VERSION,
  type FeatureVector,
  type InvariantVersionEntry,
  type MfciRiskStateFeature,
  sourceReliabilityFromHistory,
} from '@licio/ranking';
import { isSentinelTopicId } from '@licio/shared';
import type { EventPipelineServices } from '../events/services.js';
import type { InvariantOutputRecord, InvariantOutputStore } from '../events/stores.js';
import type { ForumServices } from '../forum/services.js';
import { findNearDuplicates } from '../ingestion/dedup.js';
import type { IngestionServices } from '../ingestion/services.js';
import type { InvariantPlatformServices } from '../invariants/services.js';
import { GLOBAL_FEED_TARGET_ID } from '../invariants/services-impl.js';
import { deterministicEventId } from '../pwatt/scoring.js';
import { pwattRowForRanking, usable } from '../pwatt/shadow.js';
import type { FeatureStore } from './stores.js';

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

// `usable` + `pwattRowForRanking` live in ../pwatt/shadow.ts (the §30.5 boundary
// module) so the feature join, the retrieval-side read, AND the freeze pin all
// apply the ONE identical serving-row gate. Re-exported here for existing importers.
export { pwattRowForRanking, usable };

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Version entry for the audit map (WS-I.2.1c). */
function versionEntry(row: InvariantOutputRecord): InvariantVersionEntry {
  return {
    version_string: row.version,
    computation_timestamp: row.createdAt,
    config_hash: createHash('sha256')
      .update(JSON.stringify(row.versionMetadata ?? {}))
      .digest('hex')
      .slice(0, 16),
  };
}

export interface FeatureAssemblyDeps {
  events: EventPipelineServices;
  ingestion: IngestionServices;
  invariants: InvariantPlatformServices;
  /** The thread's sourced-contribution count (comment-centric sourcing) feeds
   *  `source_evidence_completeness` (§5.4 wE). */
  forum: Pick<ForumServices, 'contributions'>;
  featureStore: FeatureStore;
  log: (event: string, meta: Record<string, unknown>) => void;
  now: () => number;
}

/**
 * Assemble the CURRENT feature vector for one story from the latest stored
 * invariant outputs and WS-F data. Returns null when the story is unknown.
 */
export async function assembleFeatureVector(
  deps: FeatureAssemblyDeps,
  storyId: string,
): Promise<FeatureVector | null> {
  const { events, ingestion, invariants } = deps;
  const story = await ingestion.stories.getById(storyId);
  if (story === null) return null;
  const thread = await ingestion.stories.getThreadByStoryId(storyId);
  const latestStored = await deps.featureStore.getLatest(storyId);
  const nowIso = new Date(deps.now()).toISOString();

  const invariantVersions: Record<string, InvariantVersionEntry> = {};
  const vector: FeatureVector = {
    item_id: story.storyId,
    item_type: 'story',
    room_id: thread?.roomId ?? story.roomId,
    // WS-Q.4.3 — record visibility (a non-scoring eligibility/audit field).
    visibility: story.visibility,
    // Drop the UNCLASSIFIED sentinel — ranking topic logic (surface filter,
    // per-topic balancing) must not treat it as a shared real topic.
    topic_ids: story.topicIds.filter((id) => !isSentinelTopicId(id)).slice(0, 16),
    // Per-item content sensitivity (WS-F labels, `none` dropped) — the real
    // per-item sensitive signal for the conservative curve + §11.5 penalty.
    sensitivity_labels: story.sensitivityLabels.filter((label) => label !== 'none'),
    source_id: story.sourceId,
    created_at: story.publishedAt ?? story.createdAt,
    feature_version: FEATURE_SCHEMA_VERSION,
    revision: (latestStored?.revision ?? -1) + 1,
    invariant_versions: invariantVersions,
    updated_at: nowIso,
  };

  // --- PWAtt components (WS-E v1 preferred, v0 fallback) -------------------
  // §30.5 bounded-input gate: PWAtt components enter the feature store ONLY
  // from rows stored `shadow_mode: false` (the post-lift artifact) AND only
  // while the code-level lift holds. Rows stored before the lift — and every
  // row again, should PWATT_V0_SHADOW_MODE be reverted — stay powerless.
  const pwattV1 = pwattRowForRanking(await events.invariantStore.latest('PWAtt_v1', storyId));
  const pwattV0 = pwattRowForRanking(await events.invariantStore.latest('PWAtt_v0', storyId));
  const pwatt = pwattV1 ?? pwattV0;
  if (pwatt !== null) {
    const attention = num(pwatt.scoreVector['active_attention']);
    const participation = num(pwatt.scoreVector['participation']);
    if (attention !== undefined) vector.active_attention = clamp01(attention);
    if (participation !== undefined) vector.constructive_participation = clamp01(participation);
    invariantVersions[pwatt.invariantType] = versionEntry(pwatt);
    // attention_velocity — the `rising` sort metric: the signed delta of the
    // served active-attention component between this row's window and the
    // most recent EARLIER same-size window of the same invariant type. Every
    // contributing row passes the identical §30.5 serving gate; absent with
    // fewer than two usable windows (honest absence, WS-H.1.2c).
    const velocity = await attentionVelocity(events.invariantStore, pwatt);
    if (velocity !== null) vector.attention_velocity = velocity;
  }

  // --- MERI: exposure independence + rank (the global feed-target row) -----
  const meriRow = usable(await events.invariantStore.latest('MERI', GLOBAL_FEED_TARGET_ID));
  if (meriRow !== null) {
    const gains = meriRow.scoreVector['marginal_gains'];
    if (typeof gains === 'object' && gains !== null) {
      const gainMap = gains as Record<string, unknown>;
      const gain = num(gainMap[storyId]);
      if (gain !== undefined) {
        vector.exposure_independence = clamp01(gain);
        const ranked = Object.entries(gainMap)
          .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const rank = ranked.findIndex(([id]) => id === storyId);
        if (rank >= 0) vector.meri_rank = rank + 1;
        invariantVersions['MERI'] = versionEntry(meriRow);
      }
    }
  }
  // Redundancy penalty input: the WS-E hook (MERI-maintained, [0, 1]).
  const redundancy = events.hooks.redundancy?.(storyId);
  if (typeof redundancy === 'number' && Number.isFinite(redundancy)) {
    vector.redundancy_penalty = clamp01(redundancy);
  }
  // WS-T dispute outcome (a content-quality signal, uniform across authors/topics
  // — never financial, neutrality-safe): a story adjudicated `incorrect` by a
  // sourced-correction debate sinks to the bottom of the feed (visible-but-
  // demoted); one UPHELD (`validated` — challenged and proven accurate) earns a
  // modest additive boost. A story is never both.
  const storyDispute = story.disputeStatus ?? 'none';
  if (storyDispute === 'incorrect') {
    vector.dispute_penalty = 1;
  } else if (storyDispute === 'validated') {
    vector.dispute_validation = 1;
  }

  // --- MFCI: the durable risk-state store is canonical; the latest output
  // row supplies the score + version metadata.
  const riskState = await invariants.mfciRiskStates.get(storyId);
  const mfciRow = usable(await events.invariantStore.latest('MFCI', storyId));
  if (riskState !== null) {
    vector.mfci_risk_state = riskState.state as MfciRiskStateFeature;
    const score = num(riskState.score);
    if (score !== undefined) vector.mfci_score = Math.max(0, score);
  }
  if (mfciRow !== null) {
    if (vector.mfci_score === undefined) {
      const score = num(mfciRow.scoreVector['mfci']);
      if (score !== undefined) vector.mfci_score = Math.max(0, score);
    }
    if (vector.mfci_risk_state === undefined) {
      const state = mfciRow.scoreVector['risk_state'];
      if (typeof state === 'string') vector.mfci_risk_state = state as MfciRiskStateFeature;
    }
    invariantVersions['MFCI'] = versionEntry(mfciRow);
  }
  // Coordination penalty input mirrors the risk-state ladder; the pure
  // penalty stage recomputes from mfci_risk_state — stored here for audit.
  if (vector.mfci_risk_state !== undefined) {
    const ladder: Record<MfciRiskStateFeature, number> = {
      normal: 0,
      elevated: 0.25,
      high: 0.5,
      severe: 1,
    };
    vector.coordination_penalty = ladder[vector.mfci_risk_state];
  }

  // --- Hodge (thread-target): harmonic tension + the harmful-tension risk
  // (which is ZERO absent a hostility signal — WS-H.7.1).
  if (thread !== null) {
    const hodgeRow = usable(await events.invariantStore.latest('hodge_tension', thread.threadId));
    if (hodgeRow !== null) {
      const harmonic = num(hodgeRow.scoreVector['harmonic_fraction']);
      const risk = num(hodgeRow.scoreVector['harmful_tension_risk']);
      if (harmonic !== undefined) vector.hodge_harmonic_tension = Math.max(0, harmonic);
      if (risk !== undefined) vector.harmful_tension_risk = clamp01(risk);
      invariantVersions['hodge_tension'] = versionEntry(hodgeRow);
    }
  }

  // --- Tropical cascade (per-topic deterministic targets): the max DETECTED
  // synchronized fraction over the story's topics.
  let tropicalMax: number | undefined;
  let tropicalRow: InvariantOutputRecord | null = null;
  for (const topicId of story.topicIds.slice(0, 16)) {
    const row = usable(
      await events.invariantStore.latest(
        'tropical_cascade',
        deterministicEventId(`tropical:${topicId}`),
      ),
    );
    if (row === null) continue;
    if (row.scoreVector['detected'] !== true) continue;
    const fraction = num(row.scoreVector['synchronized_fraction']);
    if (fraction === undefined) continue;
    if (tropicalMax === undefined || fraction > tropicalMax) {
      tropicalMax = fraction;
      tropicalRow = row;
    }
  }
  if (tropicalMax !== undefined && tropicalRow !== null) {
    vector.tropical_cascade_rank = clamp01(tropicalMax);
    invariantVersions['tropical_cascade'] = versionEntry(tropicalRow);
  }

  // --- WS-F joins: freshness, source reliability, evidence completeness ----
  const freshness = await ingestion.freshness.get(storyId);
  if (freshness !== null) vector.freshness_decay = clamp01(freshness.freshnessScore);
  if (story.sourceId !== null) {
    const source = await ingestion.sources.getById(story.sourceId);
    if (source !== null) {
      // Inputs are exactly the aggregates the WS-F profile carries
      // (correction FREQUENCY, community notes — see the pure function's
      // rationale for the removed never-fed bonuses).
      vector.source_reliability = sourceReliabilityFromHistory({
        corrections: source.correctionHistory.length,
        communityNotes: source.communityNotes.length,
      });
    }
  }
  // Comment-centric sourcing: the §5.4 wE completeness input is the thread's
  // SOURCED contribution count (published comments carrying ≥1 citation).
  const sourcedCount =
    thread === null
      ? 0
      : await deps.forum.contributions.countSourced(thread.threadId, ['published']);
  // Saturating completeness: 0 with no sourced discussion, →1 with a rich record.
  vector.source_evidence_completeness = clamp01(sourcedCount / (sourcedCount + 3));

  // --- Duplicate cluster key (WS-I.2.4a input) ------------------------------
  const clusterId = await duplicateClusterId(ingestion, storyId);
  if (clusterId !== null) vector.duplicate_cluster_id = clusterId;

  return vector;
}

/**
 * The `rising`-mode ordering metric (WS-E PWAtt provenance): the signed
 * window-over-window delta of the SERVED active-attention component. The
 * previous window is the most recent row of the SAME invariant type whose
 * same-size window starts strictly before `current`'s (same-version ties
 * break on `createdAt`), gated by the identical `pwattRowForRanking` rule as
 * the current row — a shadow, pre-lift, or degraded row can no more feed a
 * velocity than it can feed a score. Null (feature ABSENT) with fewer than
 * two usable same-size windows or a missing component value.
 */
/**
 * How many candidate previous windows to consider before giving up.
 *
 * The store returns them newest-first with the shadow half of the §30.5 gate
 * already applied, so this bounds only the tail of DEGRADED rows
 * (`TIMEOUT` / `COMPUTE_ERROR` / `INSUFFICIENT_COVERAGE`) the code gate has to
 * walk past. Thirty-two consecutive degraded windows for one target is an
 * outage, and reporting no velocity through an outage is the honest answer —
 * `attention_velocity` is an ABSENT feature, never a fabricated zero.
 */
const VELOCITY_CANDIDATE_LIMIT = 32;

async function attentionVelocity(
  store: Pick<InvariantOutputStore, 'previousWindow'>,
  current: InvariantOutputRecord,
): Promise<number | null> {
  const currentAttention = num(current.scoreVector['active_attention']);
  if (currentAttention === undefined) return null;
  const currentStart = Date.parse(current.timeWindow.start);
  const spanMs = Date.parse(current.timeWindow.end) - currentStart;
  // The store answers the question — "the most recent usable same-size window
  // strictly before this one" — rather than handing over every row this target
  // has ever had for the caller to filter. That scan ran per CANDIDATE on the
  // feed path: a story with a year of hourly windows cost thousands of rows to
  // learn about one of them.
  const candidates = await store.previousWindow({
    invariantType: current.invariantType,
    targetId: current.targetId,
    beforeStartIso: current.timeWindow.start,
    spanMs,
    limit: VELOCITY_CANDIDATE_LIMIT,
  });
  // Ordering is the store's, and it is the same total order the hand-rolled
  // scan applied (window start, then creation time, then version) — so the
  // first row the §30.5 code gate accepts IS the previous window.
  let previous: InvariantOutputRecord | null = null;
  for (const raw of candidates) {
    const row = pwattRowForRanking(raw);
    if (row !== null) {
      previous = row;
      break;
    }
  }
  if (previous === null) return null;
  const previousAttention = num(previous.scoreVector['active_attention']);
  if (previousAttention === undefined) return null;
  return Math.max(-1, Math.min(1, clamp01(currentAttention) - clamp01(previousAttention)));
}

/** Bounded component exploration limits (cost ceiling per assembly). */
const CLUSTER_MAX_NODES = 32;
const CLUSTER_HITS_PER_NODE = 16;
const CLUSTER_JACCARD_THRESHOLD = 0.7;

/**
 * How many times the anchor may move before the key is taken as final.
 *
 * See {@link duplicateClusterId}: each round strictly lowers the anchor, so
 * this is a cost ceiling rather than a correctness bound — a component the
 * bounded search can traverse settles well inside it.
 */
const CLUSTER_MAX_ANCHOR_ROUNDS = 4;

/** Near-duplicate adjacency: the stories that hit `storyId`, already bounded by
 *  {@link CLUSTER_HITS_PER_NODE}. Separating this from the walk is what lets the
 *  walk be tested over a known graph rather than over a MinHash store's
 *  incidental hit ordering. */
export type ClusterAdjacency = (storyId: string) => Promise<readonly string[]>;

/** One bounded, min-first expansion around `origin`. Shares `hitsOf` with the
 *  caller so re-anchoring re-reads no node. */
async function exploreCluster(
  origin: string,
  hitsOf: ClusterAdjacency,
): Promise<{ visited: Set<string>; sawAnyHit: boolean; truncated: boolean }> {
  const visited = new Set<string>([origin]);
  const frontier: string[] = [origin];
  let sawAnyHit = false;
  let truncated = false;
  while (frontier.length > 0) {
    if (visited.size >= CLUSTER_MAX_NODES) {
      truncated = true;
      break;
    }
    // Deterministic order: expand the smallest pending id first. Min-first is
    // not only for determinism — it is what walks the search TOWARD the key.
    frontier.sort();
    const current = frontier.shift() as string;
    for (const hit of await hitsOf(current)) {
      sawAnyHit = true;
      if (visited.has(hit)) continue;
      if (visited.size >= CLUSTER_MAX_NODES) {
        truncated = true;
        break;
      }
      visited.add(hit);
      frontier.push(hit);
    }
  }
  return { visited, sawAnyHit, truncated };
}

/**
 * The duplicate-cluster key: the MINIMUM story id over the near-duplicate
 * CONNECTED COMPONENT containing `storyId`, discovered by a bounded min-first
 * expansion over MinHash hits (hits-of-hits included, so chains A↔B↔C share one
 * key even when A and C are not mutual hits — min-over-direct-hits split such
 * chains and under-capped them).
 *
 * The key must be a function of the COMPONENT, not of where the walk started:
 * `applyMatroidDedup` enforces `meri_max_per_cluster` by grouping on it, so two
 * members that disagree are two clusters as far as the page cap is concerned,
 * and the cap is exceeded once per extra key.
 *
 * A single bounded walk does not have that property, and this used to run one.
 * Under {@link CLUSTER_MAX_NODES} the walk from A and the walk from Z visit
 * different subsets of a larger component and each returns the minimum of its
 * OWN subset — so a near-duplicate flood, the exact case the cap exists for,
 * fragmented into several keys and every fragment got its own page allowance.
 * The docstring asserted the opposite ("every discovered member still maps to
 * the same minimum"), which holds only when the walk is not truncated at all.
 *
 * So the walk RE-ANCHORS: explore, take the smallest id seen, and if it is not
 * the id we explored from, explore again from there. Each round strictly lowers
 * the anchor, so it terminates; a component the bound can traverse reaches the
 * same fixed point from every member, because the final round is a complete
 * walk of it. Node hits are memoised across rounds, so re-anchoring costs
 * queries only for nodes a previous round did not reach.
 *
 * The residual is honest and unchanged in kind: for a component too large for
 * any single bounded walk, the fixed point is the smallest id min-first search
 * reaches rather than the true minimum, so such a component may still carry
 * more than one key. Min-first is what makes that rare — it is the strategy
 * that walks toward the answer — and exact matroid classes remain MERI's
 * concern; this key only feeds the WS-I.2.4a page cap.
 *
 * Returns null for unique items.
 *
 * The WALK is exported and the STORE READ is not: the algorithm is what needs
 * proving over a known graph, and it cannot be proved through a MinHash store's
 * incidental hit ordering.
 */
export async function resolveClusterAnchor(
  origin: string,
  hitsOf: ClusterAdjacency,
): Promise<string | null> {
  let anchor = origin;
  let sawAnyHit = false;
  for (let round = 0; round < CLUSTER_MAX_ANCHOR_ROUNDS; round += 1) {
    const walk = await exploreCluster(anchor, hitsOf);
    if (walk.sawAnyHit) sawAnyHit = true;
    const smallest = [...walk.visited].sort()[0] as string;
    // A complete walk has seen the whole component, so its minimum IS the key.
    // Re-anchoring only ever matters when the bound cut the walk short.
    const settled = smallest === anchor || !walk.truncated;
    anchor = smallest;
    if (settled) break;
  }
  return sawAnyHit ? anchor : null;
}

async function duplicateClusterId(
  ingestion: IngestionServices,
  storyId: string,
): Promise<string | null> {
  const hitCache = new Map<string, readonly string[]>();
  const hitsOf: ClusterAdjacency = async (id) => {
    const cached = hitCache.get(id);
    if (cached !== undefined) return cached;
    const signature = await ingestion.signatures.getByStoryId(id);
    if (signature === null) {
      hitCache.set(id, []);
      return [];
    }
    const hits = await findNearDuplicates(
      ingestion.signatures,
      // WS-Q.2.2c — the public near-dup cluster is scoped to public stories;
      // the feed only serves public content, so the cluster matches it.
      ingestion.stories,
      id,
      signature.minhash,
      lshBandHashes(signature.minhash),
      CLUSTER_JACCARD_THRESHOLD,
      CLUSTER_HITS_PER_NODE,
    );
    const ids = hits.map((hit) => hit.storyId);
    hitCache.set(id, ids);
    return ids;
  };
  return resolveClusterAnchor(storyId, hitsOf);
}

/**
 * Assemble + write (optimistic). One retry on a lost revision race — the
 * second loser concedes (the next event/batch refresh converges).
 */
export async function refreshFeatures(
  deps: FeatureAssemblyDeps,
  storyId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const vector = await assembleFeatureVector(deps, storyId);
    if (vector === null) return false;
    const written = await deps.featureStore.upsert(vector);
    if (written !== null) {
      deps.log('feature.store.updated', {
        item_id: storyId,
        revision: written.revision,
        invariants: Object.keys(written.invariant_versions).length,
      });
      return true;
    }
  }
  deps.log('feature.store.update_conceded', { item_id: storyId });
  return false;
}

/**
 * The real-time path (WS-I.2.1d): a DURABLE router consumer on
 * `invariant.run.completed`. Story-target runs refresh that story; thread-
 * target runs refresh the owning story. Feed/cohort/session-target runs are
 * picked up by the batch path (they affect many items at once).
 */
export function registerFeatureStoreConsumer(deps: FeatureAssemblyDeps): void {
  deps.events.router.register({
    name: 'ranking-feature-store',
    // integrity.signal.detected is subscribed because the MFCI INTAKE path
    // (the sub-minute freeze path, WS-H.3.1a) writes risk states directly
    // without an invariant.run.completed — the plan's "<5s for MFCI state
    // changes" target holds only if those transitions refresh features too.
    // The 'restricted' classification covers that topic; this is NOT a
    // scoring consumer (the WS-E firewall applies to attention-scoring
    // consumers) and the handler reads only target ids from the event.
    topics: ['invariant.run.completed', 'integrity.signal.detected'],
    accessClassifications: ['sensitive', 'restricted'],
    scoring: false,
    durable: true,
    handle: async (event) => {
      const payload = event as unknown as {
        event_type?: string;
        target_type?: string;
        target_id?: string;
        target_ids?: string[];
      };
      if (payload.event_type === 'integrity.signal.detected') {
        // The WS-H intake consumer registers BEFORE this one at boot, so the
        // risk-state store is already updated when this handler assembles.
        // EVERY target refreshes — the schema caps target_ids at 100, and a
        // partial refresh would leave the remainder ranking on stale risk
        // inputs until the hourly batch (the slice is belt-and-braces at
        // exactly the schema bound, never a smaller silent cap).
        for (const targetId of (payload.target_ids ?? []).slice(0, 100)) {
          await refreshFeatures(deps, targetId);
        }
        return;
      }
      if (payload.target_id === undefined) return;
      if (payload.target_type === 'story') {
        await refreshFeatures(deps, payload.target_id);
        return;
      }
      if (payload.target_type === 'thread') {
        const storyId = await deps.ingestion.stories.getStoryIdByThreadId(payload.target_id);
        if (storyId !== null) await refreshFeatures(deps, storyId);
      }
    },
  });
}

/**
 * The batch path (WS-I.2.1d): refresh recent stories + the stalest stored
 * vectors, bounded by `limit`. Idempotent; safe under the scheduler lease.
 */
export async function runFeatureBatch(
  deps: FeatureAssemblyDeps,
  limit: number,
  staleHours: number,
): Promise<{ refreshed: number }> {
  const cap = Math.max(1, limit);
  // Reserve part of the per-tick budget for stale vectors so a burst of recent
  // stories can never starve the stalest items this batch is meant to refresh.
  const recentReserve = Math.max(1, Math.floor(cap / 2));
  const recentIds: string[] = [];
  for (const story of await deps.ingestion.stories.listRecent(cap)) {
    if (story.hiddenState === null) recentIds.push(story.storyId);
  }
  const staleBefore = new Date(deps.now() - staleHours * 3_600_000).toISOString();
  const staleIds = await deps.featureStore.listStaleItems(staleBefore, cap);
  const targets = new Set<string>();
  // Take up to half the budget of recent stories first (deterministic order).
  for (const id of recentIds.slice(0, recentReserve)) targets.add(id);
  // Fill the reserved remainder from the stalest vectors.
  for (const id of staleIds) {
    if (targets.size >= cap) break;
    targets.add(id);
  }
  // Backfill any unused budget with the remaining recent stories.
  for (const id of recentIds) {
    if (targets.size >= cap) break;
    targets.add(id);
  }
  let refreshed = 0;
  const versionCounts = new Map<string, number>();
  for (const storyId of targets) {
    if (await refreshFeatures(deps, storyId)) {
      refreshed += 1;
      const latest = await deps.featureStore.getLatest(storyId);
      for (const [name, entry] of Object.entries(latest?.invariant_versions ?? {})) {
        const key = `${name}@${entry.version_string}`;
        versionCounts.set(key, (versionCounts.get(key) ?? 0) + 1);
      }
    }
  }
  // WS-I.2.1c observability: the distribution of invariant versions now
  // populating production feature vectors (a stalled rollout shows up as a
  // version that never gains share).
  for (const [invariant_version, count] of versionCounts) {
    deps.log('ranking.feature.invariant_versions', { invariant_version, count });
  }
  deps.log('feature.store.batch.completed', { refreshed, targets: targets.size });
  return { refreshed };
}
