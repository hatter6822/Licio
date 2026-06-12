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
//   SCOI story row         → context_coherence_gain (1 − scoi), scoi_level
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
import { lshBandHashes, PWATT_V0_SHADOW_MODE } from '@licio/invariants';
import {
  FEATURE_SCHEMA_VERSION,
  type FeatureVector,
  type InvariantVersionEntry,
  type MfciRiskStateFeature,
  type ScoiLevel,
  sourceReliabilityFromHistory,
} from '@licio/ranking';
import type { EventPipelineServices } from '../events/services.js';
import type { InvariantOutputRecord } from '../events/stores.js';
import { findNearDuplicates } from '../ingestion/dedup.js';
import type { IngestionServices } from '../ingestion/services.js';
import type { InvariantPlatformServices } from '../invariants/services.js';
import { GLOBAL_FEED_TARGET_ID } from '../invariants/services-impl.js';
import { deterministicEventId } from '../pwatt/scoring.js';
import type { FeatureStore } from './stores.js';

/** SCOI context states → the WS-I.2.4c gating ladder (SPEC §10.4 → §10.6). */
const SCOI_STATE_TO_LEVEL: Readonly<Record<string, ScoiLevel>> = {
  coherent: 'low',
  ambiguous: 'medium',
  split: 'medium',
  obstructed: 'high',
  weaponized: 'very_high',
};

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/** A usable (non-degraded) output: fallback rows with hard failure reason
 *  codes and zero-coverage rows are ABSENT for ranking (WS-H.1.2c). */
function usable(row: InvariantOutputRecord | null): InvariantOutputRecord | null {
  if (row === null) return null;
  if (row.reasonCodes.includes('TIMEOUT') || row.reasonCodes.includes('COMPUTE_ERROR')) {
    return null;
  }
  if (row.reasonCodes.includes('INSUFFICIENT_COVERAGE')) return null;
  return row;
}

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
    room_id: thread?.roomId ?? null,
    topic_ids: story.topicIds.slice(0, 16),
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
  const pwattLifted = (PWATT_V0_SHADOW_MODE as boolean) === false;
  const pwattV1 = usable(await events.invariantStore.latest('PWAtt_v1', storyId));
  const pwattV0 = usable(await events.invariantStore.latest('PWAtt_v0', storyId));
  const pwatt = pwattV1 ?? pwattV0;
  if (pwatt !== null && pwattLifted && pwatt.shadowMode === false) {
    const attention = num(pwatt.scoreVector['active_attention']);
    const participation = num(pwatt.scoreVector['participation']);
    if (attention !== undefined) vector.active_attention = clamp01(attention);
    if (participation !== undefined) vector.constructive_participation = clamp01(participation);
    invariantVersions[pwatt.invariantType] = versionEntry(pwatt);
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

  // --- SCOI: context coherence + gating level ------------------------------
  const scoiRow = usable(await events.invariantStore.latest('SCOI', storyId));
  if (scoiRow !== null) {
    const scoi = num(scoiRow.scoreVector['scoi']);
    const state = scoiRow.scoreVector['context_state'];
    if (scoi !== undefined) {
      vector.context_coherence_gain = clamp01(1 - scoi);
      const level =
        typeof state === 'string' ? (SCOI_STATE_TO_LEVEL[state] ?? undefined) : undefined;
      if (level !== undefined) vector.scoi_level = level;
      invariantVersions['SCOI'] = versionEntry(scoiRow);
    }
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
      // (correction FREQUENCY, evidence-type diversity, community notes).
      // citationCount (citations by later summaries, the fourth §13.3
      // input) stays 0 until WS-F aggregates summary citations onto the
      // source profile — an explicit seam, documented on the pure function.
      vector.source_reliability = sourceReliabilityFromHistory({
        corrections: source.correctionHistory.length,
        evidenceTypeCount: Object.keys(source.evidenceTypeFrequency).length,
        communityNotes: source.communityNotes.length,
        citationCount: 0,
      });
    }
  }
  const claims = await ingestion.claims.listByStory(storyId);
  let evidenceCount = 0;
  for (const claim of claims) {
    evidenceCount += (await ingestion.evidence.listByClaim(claim.claimId)).length;
  }
  // Saturating completeness: 0 with no evidence, →1 with a rich record.
  vector.source_evidence_completeness = clamp01(evidenceCount / (evidenceCount + 3));

  // --- Duplicate cluster key (WS-I.2.4a input) ------------------------------
  const clusterId = await duplicateClusterId(ingestion, storyId);
  if (clusterId !== null) vector.duplicate_cluster_id = clusterId;

  return vector;
}

/** Bounded component exploration limits (cost ceiling per assembly). */
const CLUSTER_MAX_NODES = 32;
const CLUSTER_HITS_PER_NODE = 16;
const CLUSTER_JACCARD_THRESHOLD = 0.7;

/**
 * The duplicate-cluster key: the MINIMUM story id over the near-duplicate
 * CONNECTED COMPONENT containing `storyId`, discovered by a bounded
 * breadth-first expansion over MinHash hits (hits-of-hits included, so
 * chains A↔B↔C share one key even when A and C are not mutual hits —
 * min-over-direct-hits split such chains and under-capped them). The
 * frontier is capped at {@link CLUSTER_MAX_NODES}: beyond that, every
 * discovered member still maps to the same minimum, so the per-page cap
 * stays consistent — exact matroid classes remain MERI's concern; this key
 * only feeds the WS-I.2.4a page cap. Returns null for unique items.
 */
async function duplicateClusterId(
  ingestion: IngestionServices,
  storyId: string,
): Promise<string | null> {
  const visited = new Set<string>([storyId]);
  const frontier: string[] = [storyId];
  let sawAnyHit = false;
  while (frontier.length > 0 && visited.size < CLUSTER_MAX_NODES) {
    // Deterministic order: expand the smallest pending id first.
    frontier.sort();
    const current = frontier.shift() as string;
    const signature = await ingestion.signatures.getByStoryId(current);
    if (signature === null) continue;
    const hits = await findNearDuplicates(
      ingestion.signatures,
      current,
      signature.minhash,
      lshBandHashes(signature.minhash),
      CLUSTER_JACCARD_THRESHOLD,
      CLUSTER_HITS_PER_NODE,
    );
    for (const hit of hits) {
      sawAnyHit = true;
      if (visited.has(hit.storyId) || visited.size >= CLUSTER_MAX_NODES) continue;
      visited.add(hit.storyId);
      frontier.push(hit.storyId);
    }
  }
  if (!sawAnyHit) return null;
  return [...visited].sort()[0] as string;
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
        for (const targetId of (payload.target_ids ?? []).slice(0, 25)) {
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
  const targets = new Set<string>();
  for (const story of await deps.ingestion.stories.listRecent(cap)) {
    if (story.hiddenState === null) targets.add(story.storyId);
  }
  const staleBefore = new Date(deps.now() - staleHours * 3_600_000).toISOString();
  for (const itemId of await deps.featureStore.listStaleItems(staleBefore, cap)) {
    targets.add(itemId);
  }
  let refreshed = 0;
  const versionCounts = new Map<string, number>();
  for (const storyId of [...targets].slice(0, cap)) {
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
