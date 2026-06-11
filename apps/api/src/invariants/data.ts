// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H data assembly: builds each invariant's PURE-MATH inputs from the real
// WS-D/E/F/G stores. All functions are read-only; privacy-sensitive inputs
// are reduced to the minimum the mathematics needs (PHI/path-signature see
// topic-cluster ids, event kinds, and timing ONLY; GWEI sees aggregates per
// cohort, never per-user histories on the wire).

import {
  type CascadeEvent,
  type CohortExposureItem,
  estimateJaccard,
  type GweiItemFeatures,
  type Interaction,
  lshBandHashes,
  type MeriCandidateInput,
  type RankSnapshot,
  type ReebEdge,
  type ReebNode,
  type SessionPathEvent,
  type SheafStructure,
} from '@licio/invariants';
import type { EventPipelineServices } from '../events/services.js';
import type { ForumServices } from '../forum/services.js';
import type { IdentityServices } from '../identity/services.js';
import type { IngestionServices } from '../ingestion/services.js';
import type { StoryRecord } from '../ingestion/stores.js';

// ---------------------------------------------------------------------------
// MERI (WS-H.2): candidate exposures with grouping inputs
// ---------------------------------------------------------------------------

/**
 * Build MERI candidates for a topic (or the recent feed pool when topicId is
 * null): near-duplicate groups from MinHash signatures (union by estimated
 * Jaccard ≥ threshold over LSH-band candidates), source-lineage groups from
 * confirmed syndication edges + shared publisher lineage, evidence groups
 * from claim independence groups.
 */
export async function assembleMeriCandidates(
  ingestion: IngestionServices,
  topicId: string | null,
  limit: number,
  nearDuplicateThreshold: number,
): Promise<MeriCandidateInput[]> {
  const recent = await ingestion.stories.listRecent(limit * 2);
  const stories = (topicId ? recent.filter((s) => s.topicIds.includes(topicId)) : recent).slice(
    0,
    limit,
  );
  if (stories.length === 0) return [];

  // Near-duplicate union-find over signature candidates.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== undefined && parent.get(root) !== root) {
      root = parent.get(root) ?? root;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const inSet = new Set(stories.map((s) => s.storyId));
  for (const story of stories) {
    parent.set(story.storyId, parent.get(story.storyId) ?? story.storyId);
    const signature = await ingestion.signatures.getByStoryId(story.storyId);
    if (!signature) continue;
    const candidates = await ingestion.signatures.candidatesByBands(
      lshBandHashes(signature.minhash),
      story.storyId,
    );
    for (const candidateId of candidates) {
      if (!inSet.has(candidateId)) continue;
      const other = await ingestion.signatures.getByStoryId(candidateId);
      if (!other) continue;
      if (estimateJaccard(signature.minhash, other.minhash) >= nearDuplicateThreshold) {
        union(story.storyId, candidateId);
      }
    }
  }
  const nearDupGroupOf = (storyId: string): string | null => {
    const root = find(storyId);
    // A group exists only when ≥ 2 members share the root.
    const members = stories.filter((s) => find(s.storyId) === root);
    return members.length >= 2 ? `nd-${root}` : null;
  };

  // Source lineage: connected components over confirmed syndication edges
  // and shared outermost publisher lineage.
  const sourceParent = new Map<string, string>();
  const sourceFind = (x: string): string => {
    let root = x;
    while (sourceParent.get(root) !== undefined && sourceParent.get(root) !== root) {
      root = sourceParent.get(root) ?? root;
    }
    return root;
  };
  const sourceUnion = (a: string, b: string): void => {
    const ra = sourceFind(a);
    const rb = sourceFind(b);
    if (ra !== rb) sourceParent.set(ra, rb);
  };
  const ownerOf = new Map<string, string | null>();
  const sourceIds = [...new Set(stories.map((s) => s.sourceId).filter((v): v is string => !!v))];
  for (const sourceId of sourceIds) {
    sourceParent.set(sourceId, sourceParent.get(sourceId) ?? sourceId);
    const source = await ingestion.sources.getById(sourceId);
    ownerOf.set(sourceId, source?.publisherLineage?.[0]?.name ?? null);
    for (const edge of await ingestion.syndications.listForSource(sourceId)) {
      if (edge.status !== 'confirmed') continue;
      sourceParent.set(edge.fromSourceId, sourceParent.get(edge.fromSourceId) ?? edge.fromSourceId);
      sourceParent.set(edge.toSourceId, sourceParent.get(edge.toSourceId) ?? edge.toSourceId);
      sourceUnion(edge.fromSourceId, edge.toSourceId);
    }
  }
  // Shared outermost owner joins lineages even without an explicit edge.
  const byOwner = new Map<string, string[]>();
  for (const [sourceId, owner] of ownerOf) {
    if (!owner) continue;
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), sourceId]);
  }
  for (const members of byOwner.values()) {
    for (let i = 1; i < members.length; i += 1) {
      const first = members[0];
      const current = members[i];
      if (first && current) sourceUnion(first, current);
    }
  }
  const lineageGroupOf = (story: StoryRecord): string | null => {
    if (!story.sourceId) return null;
    const root = sourceFind(story.sourceId);
    const members = stories.filter((s) => s.sourceId && sourceFind(s.sourceId) === root);
    return members.length >= 2 ? `src-${root}` : null;
  };

  // Evidence/claim groups from claim independence grouping.
  const claimGroupOf = new Map<string, string | null>();
  const evidenceGroupOf = new Map<string, string | null>();
  for (const story of stories) {
    const claims = await ingestion.claims.listByStory(story.storyId);
    const firstClaimGroup = claims.find((c) => c.independenceGroupId)?.independenceGroupId ?? null;
    claimGroupOf.set(story.storyId, firstClaimGroup);
    let evidenceGroup: string | null = null;
    for (const claim of claims) {
      const cards = await ingestion.evidence.listByClaim(claim.claimId);
      evidenceGroup = cards.find((card) => card.independenceGroupId)?.independenceGroupId ?? null;
      if (evidenceGroup) break;
    }
    evidenceGroupOf.set(story.storyId, evidenceGroup);
  }

  return stories.map((story) => {
    const claims = claimGroupOf.get(story.storyId) ?? null;
    return {
      id: story.storyId,
      urlGroupId: story.canonicalUrl ?? `self:${story.storyId}`,
      nearDuplicateGroupId: nearDupGroupOf(story.storyId),
      sourceLineageGroupId: lineageGroupOf(story),
      evidenceGroupId: evidenceGroupOf.get(story.storyId) ?? null,
      claimGroupId: claims,
      framingGroupId: null,
      misleading: false,
      inputsAvailable: {
        canonicalUrl: (story.canonicalUrl ?? '').length > 0,
        claimExtraction: claims !== null,
        sourceLineage: story.sourceId !== null,
        evidence: (evidenceGroupOf.get(story.storyId) ?? null) !== null,
        embedding: true,
      },
    } satisfies MeriCandidateInput;
  });
}

// ---------------------------------------------------------------------------
// MFCI (WS-H.3): action observations over the five table dimensions
// ---------------------------------------------------------------------------

export interface MfciActionWindow {
  observations: Array<{ labels: string[] }>;
  rawActions: Array<{ actorRef: string; targetId: string; atMs: number }>;
}

const MFCI_TOPICS = ['contribution.created', 'evidence.added', 'content.submitted'] as const;

/** Account-age bucket as the privacy-preserving user_group dimension. */
function accountAgeBucket(createdAtMs: number, nowMs: number): string {
  const days = (nowMs - createdAtMs) / 86_400_000;
  if (days < 7) return 'new';
  if (days < 90) return 'recent';
  return 'established';
}

/**
 * Assemble the §8.2 observation list from in-window WS-E events. Labels:
 * user_group = account-age bucket (never an identity), topic = the target
 * story's first topic, time_bucket = 10-minute slot, action_type = event
 * topic, target = the story/thread id.
 */
export async function assembleMfciActions(
  events: EventPipelineServices,
  identity: IdentityServices,
  ingestion: IngestionServices,
  fromIso: string,
  toIso: string,
): Promise<MfciActionWindow> {
  const rows = await events.eventStore.listByTopicsBetween([...MFCI_TOPICS], fromIso, toIso);
  const observations: Array<{ labels: string[] }> = [];
  const rawActions: Array<{ actorRef: string; targetId: string; atMs: number }> = [];
  const fromMs = Date.parse(fromIso);
  for (const row of rows) {
    const payload = row.payload;
    const targetId =
      typeof payload['story_id'] === 'string'
        ? payload['story_id']
        : typeof payload['thread_id'] === 'string'
          ? payload['thread_id']
          : null;
    if (!targetId) continue;
    const atMs = Date.parse(row.timestamp);
    const actorRef = row.ownerUserId ?? 'anonymous';
    let group = 'unknown';
    if (row.ownerUserId) {
      const user = await identity.store.getUser(row.ownerUserId);
      if (user) group = accountAgeBucket(Date.parse(user.createdAt), atMs);
    }
    const story = await ingestion.stories.getById(targetId);
    const topic = story?.topicIds[0] ?? 'untagged';
    const bucket = `b${Math.max(0, Math.floor((atMs - fromMs) / 600_000))}`;
    observations.push({ labels: [group, topic, bucket, row.topic, targetId] });
    rawActions.push({ actorRef, targetId, atMs });
  }
  return { observations, rawActions };
}

// ---------------------------------------------------------------------------
// GWEI (WS-H.5): cohort exposure samples
// ---------------------------------------------------------------------------

export interface CohortSample {
  cohortKey: string;
  size: number;
  items: CohortExposureItem[];
  gwItems: GweiItemFeatures[];
}

const DWELL_WEIGHT: Record<string, number> = {
  glance: 0.25,
  brief: 0.5,
  engaged: 0.75,
  deep: 1,
};

/**
 * Assemble cohort exposure samples from owned attention aggregates joined
 * to stories. Cohorts: primary locale and new/established (WS-H.5.1a —
 * derived ONLY from user-provided metadata; age-band cohorts are skipped
 * when unknown, never inferred).
 */
export async function assembleCohorts(
  events: EventPipelineServices,
  identity: IdentityServices,
  ingestion: IngestionServices,
  nowMs: number,
): Promise<CohortSample[]> {
  const owners = await events.attentionStore.listIdentifiableOwners();
  const users = await identity.store.getUsersByIds(owners);
  const byCohort = new Map<string, { userIds: Set<string>; stories: Map<string, number> }>();
  const add = (cohortKey: string, userId: string, storyId: string, weight: number): void => {
    const cohort = byCohort.get(cohortKey) ?? { userIds: new Set(), stories: new Map() };
    cohort.userIds.add(userId);
    cohort.stories.set(storyId, (cohort.stories.get(storyId) ?? 0) + weight);
    byCohort.set(cohortKey, cohort);
  };
  for (const user of users) {
    const aggregates = await events.attentionStore.listByUser(user.userId);
    const cohorts = [
      `locale:${user.locale ?? 'unknown'}`,
      `tenure:${accountAgeBucket(Date.parse(user.createdAt), nowMs) === 'new' ? 'new' : 'established'}`,
    ];
    for (const aggregate of aggregates) {
      const weight = DWELL_WEIGHT[aggregate.active_dwell_bucket] ?? 0.25;
      for (const cohortKey of cohorts) add(cohortKey, user.userId, aggregate.story_id, weight);
    }
  }

  const samples: CohortSample[] = [];
  for (const [cohortKey, cohort] of byCohort) {
    const items: CohortExposureItem[] = [];
    const gwItems: GweiItemFeatures[] = [];
    for (const [storyId, weight] of cohort.stories) {
      const story = await ingestion.stories.getById(storyId);
      if (!story) continue;
      const claims = await ingestion.claims.listByStory(storyId);
      const hasEvidence = claims.length > 0;
      const embedding = await ingestion.embeddingProvider.embed(story.title);
      items.push({
        itemId: storyId,
        sourceKey: story.sourceId ?? 'unknown',
        topicIds: [...story.topicIds],
        hasPrimaryEvidence: hasEvidence,
        discussionDepth: 1,
        lensKeys: [],
        familiarTopic: false,
        safetyElevated: story.sensitivityLabels.length > 0,
        weight,
      });
      gwItems.push({
        itemId: storyId,
        semantic: [...embedding].slice(0, 16),
        sourceKey: story.sourceId ?? 'unknown',
        evidenceKeys: claims.map((c) => c.independenceGroupId ?? c.claimId).slice(0, 8),
        communityKeys: story.topicIds.slice(0, 4),
        weight,
      });
    }
    samples.push({ cohortKey, size: cohort.userIds.size, items, gwItems });
  }
  return samples.sort((a, b) => a.cohortKey.localeCompare(b.cohortKey));
}

// ---------------------------------------------------------------------------
// SCOI (WS-H.4): lens interpretations per story
// ---------------------------------------------------------------------------

/**
 * Build the sheaf structure for a story: one lens vertex per forum lens
 * with recent lens-tagged contributions on the story's threads; the
 * interpretation vector is the unit-normalized mean embedding of the lens's
 * contribution bodies; restriction maps are the configured identity
 * projection into the shared comparison space (the v1 configuration —
 * documented in the card).
 */
export async function assembleScoiStructure(
  ingestion: IngestionServices,
  forum: ForumServices,
  storyId: string,
  comparisonDim = 8,
): Promise<{ structure: SheafStructure; lensesWithData: number; lensesTotal: number }> {
  const thread = await ingestion.stories.getThreadByStoryId(storyId);
  if (!thread)
    return { structure: { lenses: [], overlaps: [] }, lensesWithData: 0, lensesTotal: 0 };
  const roomId = thread.roomId;
  const lenses = roomId ? await forum.lenses.listByRoom(roomId) : [];
  const contributions = await forum.contributions.listByThread(thread.threadId, { limit: 500 });

  const identityMap = Array.from({ length: comparisonDim }, (_, r) =>
    Array.from({ length: comparisonDim }, (_, c) => (r === c ? 1 : 0)),
  );
  const lensVectors: Array<{ lensId: string; interpretation: number[] }> = [];
  for (const lens of lenses) {
    const tagged = contributions.filter((c) => c.metadata['lens_id'] === lens.lensId);
    if (tagged.length === 0) continue;
    const sum = new Array<number>(comparisonDim).fill(0);
    for (const contribution of tagged) {
      const embedding = await ingestion.embeddingProvider.embed(contribution.body);
      for (let i = 0; i < comparisonDim; i += 1) sum[i] = (sum[i] ?? 0) + (embedding[i] ?? 0);
    }
    const norm = Math.sqrt(sum.reduce((acc, v) => acc + v * v, 0));
    lensVectors.push({
      lensId: lens.lensId,
      interpretation: norm > 0 ? sum.map((v) => v / norm) : sum,
    });
  }
  const overlaps = [];
  for (let i = 0; i < lensVectors.length; i += 1) {
    for (let j = i + 1; j < lensVectors.length; j += 1) {
      overlaps.push({
        lensA: lensVectors[i]?.lensId ?? '',
        lensB: lensVectors[j]?.lensId ?? '',
        rhoA: identityMap,
        rhoB: identityMap,
      });
    }
  }
  return {
    structure: { lenses: lensVectors, overlaps },
    lensesWithData: lensVectors.length,
    lensesTotal: lenses.length,
  };
}

// ---------------------------------------------------------------------------
// Hodge (WS-H.7.1): conversation interactions
// ---------------------------------------------------------------------------

const KIND_BY_TYPE: Record<string, Interaction['kind']> = {
  question: 'attention',
  answer: 'agreement',
  evidence: 'agreement',
  explanation: 'agreement',
  synthesis: 'agreement',
  local_context: 'agreement',
  direct_experience: 'agreement',
  correction: 'correction',
  counterexample: 'disagreement',
  moderation_concern: 'disagreement',
  meta_discussion: 'attention',
};

export async function assembleConversationInteractions(
  forum: ForumServices,
  threadId: string,
): Promise<{ interactions: Interaction[]; total: number; resolvable: number }> {
  const contributions = await forum.contributions.listByThread(threadId, { limit: 1_000 });
  const authorOf = new Map(contributions.map((c) => [c.contributionId, c.userId]));
  const interactions: Interaction[] = [];
  let resolvable = 0;
  for (const contribution of contributions) {
    if (!contribution.parentContributionId || !contribution.userId) continue;
    const parentAuthor = authorOf.get(contribution.parentContributionId);
    if (!parentAuthor || parentAuthor === contribution.userId) continue;
    resolvable += 1;
    interactions.push({
      from: contribution.userId,
      to: parentAuthor,
      kind: KIND_BY_TYPE[contribution.type] ?? 'attention',
      weight: 1,
    });
  }
  return { interactions, total: contributions.length, resolvable };
}

// ---------------------------------------------------------------------------
// Tropical (WS-H.7.2): topic cascades (seed = source, node = content family)
// ---------------------------------------------------------------------------

export async function assembleTopicCascade(
  ingestion: IngestionServices,
  topicId: string,
  limit = 200,
): Promise<CascadeEvent[]> {
  const recent = await ingestion.stories.listRecent(limit * 2);
  const stories = recent.filter((s) => s.topicIds.includes(topicId)).slice(0, limit);
  const cascade: CascadeEvent[] = [];
  for (const story of stories) {
    const claims = await ingestion.claims.listByStory(story.storyId);
    const family =
      claims.find((c) => c.independenceGroupId)?.independenceGroupId ?? story.titleHash;
    cascade.push({
      seedId: story.sourceId ?? `direct:${story.submittedBy ?? 'unknown'}`,
      nodeId: family,
      arrivalMs: Date.parse(story.createdAt),
    });
  }
  return cascade;
}

// ---------------------------------------------------------------------------
// Braid (WS-H.7.3): hourly topic-activity rank snapshots
// ---------------------------------------------------------------------------

export async function assembleActivitySnapshots(
  events: EventPipelineServices,
  ingestion: IngestionServices,
  nowMs: number,
  hours = 6,
): Promise<RankSnapshot[]> {
  const recent = await ingestion.stories.listRecent(200);
  const topicOf = new Map<string, string>();
  for (const story of recent) {
    const topic = story.topicIds[0];
    if (topic) topicOf.set(story.storyId, topic);
  }
  const snapshots: RankSnapshot[] = [];
  const hourMs = 3_600_000;
  const baseHour = Math.floor(nowMs / hourMs) * hourMs;
  const allTopics = [...new Set(topicOf.values())].sort();
  if (allTopics.length < 2) return [];
  for (let h = hours - 1; h >= 0; h -= 1) {
    const windowStart = new Date(baseHour - h * hourMs).toISOString();
    const counts = new Map<string, number>(allTopics.map((t) => [t, 0]));
    for (const [storyId, topic] of topicOf) {
      const window = await events.windowStore.get(storyId, windowStart, '1h');
      if (window) counts.set(topic, (counts.get(topic) ?? 0) + window.eventCount);
    }
    snapshots.push({
      atMs: baseHour - h * hourMs,
      topicIdsByRank: allTopics
        .slice()
        .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b)),
    });
  }
  return snapshots;
}

// ---------------------------------------------------------------------------
// Reeb (WS-H.7.4): engagement landscape over the topic-similarity graph
// ---------------------------------------------------------------------------

export async function assembleEngagementLandscape(
  events: EventPipelineServices,
  ingestion: IngestionServices,
  nowMs: number,
): Promise<{ nodes: ReebNode[]; edges: ReebEdge[] }> {
  const recent = await ingestion.stories.listRecent(100);
  const hourMs = 3_600_000;
  const windowStart = new Date(Math.floor(nowMs / hourMs) * hourMs - hourMs).toISOString();
  const nodes: ReebNode[] = [];
  for (const story of recent) {
    const window = await events.windowStore.get(story.storyId, windowStart, '1h');
    nodes.push({ id: story.storyId, value: window?.eventCount ?? 0 });
  }
  const edges: ReebEdge[] = [];
  for (let i = 0; i < recent.length; i += 1) {
    for (let j = i + 1; j < recent.length; j += 1) {
      const a = recent[i];
      const b = recent[j];
      if (!a || !b) continue;
      if (a.topicIds.some((t) => b.topicIds.includes(t))) {
        edges.push({ a: a.storyId, b: b.storyId });
      }
    }
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Path signature (WS-H.7.6): session paths from topic sequences
// ---------------------------------------------------------------------------

/**
 * Map a privacy-preserving topic sequence to session path events. Topic
 * ordinals are per-session (first-seen order) — no global identifier leaves
 * the session scope; the action kind for sequence transitions is `read`
 * (re-entries become `return`).
 */
export function sessionEventsFromSequence(
  sequence: ReadonlyArray<{ topicClusterId: string; atMs: number }>,
): SessionPathEvent[] {
  const ordinals = new Map<string, number>();
  const seen = new Set<string>();
  const events: SessionPathEvent[] = [];
  for (const transition of sequence) {
    let ordinal = ordinals.get(transition.topicClusterId);
    if (ordinal === undefined) {
      ordinal = ordinals.size;
      ordinals.set(transition.topicClusterId, ordinal);
    }
    events.push({
      kind: seen.has(transition.topicClusterId) ? 'return' : 'read',
      topicOrdinal: ordinal,
      atMs: transition.atMs,
      engagement: 0.5,
    });
    seen.add(transition.topicClusterId);
  }
  return events;
}
