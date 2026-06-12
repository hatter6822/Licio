// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.1.1a — the eight organic candidate retrievers (SPEC §13.2). Each
// implements the `CandidateRetriever` interface over the narrow read-only
// `CandidateDataPorts` seam, so every retriever is independently testable
// with fixture ports and the set is extensible through the registry.
//
// FINANCIAL EXCLUSION (WS-I.1.1c): this module imports NOTHING from any
// wallet/payment/treasury module and the ports interface exposes no
// financial reads — candidate retrieval is structurally incapable of seeing
// wallet, payment, follower-count, or donor data. A static CI test scans
// this file's imports and the ports surface; a runtime test proves identical
// users with different wallet states retrieve identical candidate sets.
//
// Every retriever drops hidden (takedown/safety) and archived stories at
// retrieval; the safety filter (WS-I.2.2a) remains the authoritative
// enforcement point and re-checks downstream.

import {
  type BridgeContext,
  type Candidate,
  type CandidateSourceType,
  candidateSchema,
} from '@licio/ranking';
import type { AggregationWindowRecord } from '../events/stores.js';
import type { StoryRecord, ThreadShellRecord } from '../ingestion/stores.js';

/** Read-only data ports for retrieval. NO financial port exists. */
export interface CandidateDataPorts {
  recentStories(limit: number): Promise<StoryRecord[]>;
  storyById(storyId: string): Promise<StoryRecord | null>;
  threadByStoryId(storyId: string): Promise<ThreadShellRecord | null>;
  storyIdByThreadId(threadId: string): Promise<string | null>;
  /** Active room subscriptions of the requesting user ([] signed out). */
  subscribedRoomIds(userId: string): Promise<string[]>;
  /** Most recent threads of a room (newest first). */
  threadsByRoom(roomId: string, limit: number): Promise<ThreadShellRecord[]>;
  /** Rooms with `expert_led` visibility (expert-explanation retrieval). */
  expertLedRoomIds(limit: number): Promise<string[]>;
  /** storyId → last-seen ISO instant from the user's OWN attention rows. */
  userSeenStories(userId: string): Promise<Map<string, string>>;
  /** Latest SCOI signal for a story (null before coverage). */
  latestScoi(
    storyId: string,
  ): Promise<{ scoi: number; contextState: string; lensCount: number } | null>;
  /** Latest PWAtt components for a story (null before coverage). */
  latestPwattComponents(
    storyId: string,
  ): Promise<{ activeAttention: number; participation: number } | null>;
  /** Latest 24h aggregation window for an item (participation velocity). */
  latestDayWindow(itemId: string): Promise<AggregationWindowRecord | null>;
  /** Whether a thread currently carries a human summary layer. */
  hasHumanSummary(threadId: string): Promise<boolean>;
  /** Number of evidence cards attached to a story's claims. */
  evidenceCountByStory(storyId: string): Promise<number>;
  /** The requesting user's locale (BCP 47) or null. */
  userLocale(userId: string): Promise<string | null>;
}

export interface RetrieveContext {
  /** Authenticated user id or null (signed-out feeds are real feeds). */
  userId: string | null;
  surface: 'front_page' | 'room' | 'topic';
  /** The surface's room when surface === 'room'. */
  surfaceRoomId: string | null;
  nowMs: number;
  /** Per-retriever output cap. */
  limit: number;
}

/** The WS-I.1.1a retriever interface. */
export interface CandidateRetriever {
  /** Named origin recorded on every candidate (audit, WS-I.1.1a). */
  readonly origin: string;
  readonly sourceType: CandidateSourceType;
  retrieve(context: RetrieveContext): Promise<Candidate[]>;
}

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/** Recency heuristic: 1 at age 0 decaying to ~0 over `horizonHours`. */
function recencyScore(freshnessIso: string, nowMs: number, horizonHours: number): number {
  const ageMs = Math.max(0, nowMs - Date.parse(freshnessIso));
  return clamp01(1 - ageMs / (horizonHours * 3_600_000));
}

/** True when the story may be retrieved at all (visibility + lifecycle). */
function retrievable(story: StoryRecord): boolean {
  return story.hiddenState === null && story.lifecycleState !== 'archived';
}

function storyFreshnessIso(story: StoryRecord): string {
  return story.publishedAt ?? story.createdAt;
}

async function storyToCandidate(
  ports: CandidateDataPorts,
  story: StoryRecord,
  sourceType: CandidateSourceType,
  origin: string,
  retrievalScore: number,
  bridgeContext: BridgeContext | null = null,
): Promise<Candidate> {
  const thread = await ports.threadByStoryId(story.storyId);
  return candidateSchema.parse({
    item_id: story.storyId,
    item_type: 'story',
    source_type: sourceType,
    room_id: thread?.roomId ?? null,
    topic_ids: story.topicIds.slice(0, 16),
    source_id: story.sourceId,
    freshness_timestamp: storyFreshnessIso(story),
    retrieval_score: clamp01(retrievalScore),
    retrieval_origins: [origin],
    bridge_context: bridgeContext,
  });
}

/** 1. Subscribed rooms: recent stories from the user's joined rooms. */
export class SubscribedRoomsRetriever implements CandidateRetriever {
  readonly origin = 'subscribed_rooms_v1';
  readonly sourceType = 'subscribed_room' as const;
  constructor(private readonly ports: CandidateDataPorts) {}

  async retrieve(context: RetrieveContext): Promise<Candidate[]> {
    if (context.userId === null) return [];
    const roomIds = await this.ports.subscribedRoomIds(context.userId);
    const out: Candidate[] = [];
    const perRoom = Math.max(1, Math.floor(context.limit / Math.max(1, roomIds.length)));
    for (const roomId of roomIds) {
      const threads = await this.ports.threadsByRoom(roomId, perRoom);
      for (const thread of threads) {
        const storyId = await this.ports.storyIdByThreadId(thread.threadId);
        if (storyId === null) continue;
        const story = await storyIfRetrievable(this.ports, storyId);
        if (story === null) continue;
        out.push(
          await storyToCandidate(
            this.ports,
            story,
            this.sourceType,
            this.origin,
            recencyScore(storyFreshnessIso(story), context.nowMs, 72),
          ),
        );
        if (out.length >= context.limit) return out;
      }
    }
    return out;
  }
}

/** 2. Local/regional news: location-scoped stories matching the user's own
 *  configured locale region (never device geolocation — §19.1/§13.2). */
export class LocalNewsRetriever implements CandidateRetriever {
  readonly origin = 'local_news_v1';
  readonly sourceType = 'local_news' as const;
  constructor(private readonly ports: CandidateDataPorts) {}

  async retrieve(context: RetrieveContext): Promise<Candidate[]> {
    if (context.userId === null) return [];
    const locale = await this.ports.userLocale(context.userId);
    const region = localeRegion(locale);
    if (region === null) return [];
    const stories = await this.ports.recentStories(context.limit * 4);
    const out: Candidate[] = [];
    for (const story of stories) {
      if (!retrievable(story)) continue;
      const scope = story.locationScope;
      if (scope === null || scope.type === 'global') continue;
      // Coarse v1 match: country scope against the locale region subtag.
      // A first-class user location preference is the WS-D seam; this port
      // only ever reads user-CONFIGURED data.
      if (scope.type === 'country' && scope.value.toUpperCase() !== region) continue;
      if (scope.type !== 'country') continue;
      out.push(
        await storyToCandidate(
          this.ports,
          story,
          this.sourceType,
          this.origin,
          recencyScore(storyFreshnessIso(story), context.nowMs, 48),
        ),
      );
      if (out.length >= context.limit) break;
    }
    return out;
  }
}

/** The region subtag of a BCP 47 locale ('en-GB' → 'GB'), or null. */
export function localeRegion(locale: string | null): string | null {
  if (locale === null) return null;
  const match = locale.match(/-([A-Za-z]{2})(?:-|$)/);
  return match === undefined || match === null ? null : (match[1]?.toUpperCase() ?? null);
}

/** 3. Global candidates: front-page-eligible stories meeting the minimum
 *  PWAtt component threshold (NEVER raw engagement counts — WS-I.1.1a). */
export class GlobalCandidatesRetriever implements CandidateRetriever {
  readonly origin = 'global_pwatt_v1';
  readonly sourceType = 'global' as const;
  constructor(
    private readonly ports: CandidateDataPorts,
    private readonly pwattThreshold = 0.05,
  ) {}

  async retrieve(context: RetrieveContext): Promise<Candidate[]> {
    const stories = await this.ports.recentStories(context.limit * 4);
    const out: Candidate[] = [];
    for (const story of stories) {
      if (!retrievable(story)) continue;
      const components = await this.ports.latestPwattComponents(story.storyId);
      const freshness = recencyScore(storyFreshnessIso(story), context.nowMs, 48);
      if (components !== null) {
        // PWAtt eligibility: the v0 indicator (mean of the two components).
        const indicator = (components.activeAttention + components.participation) / 2;
        if (indicator < this.pwattThreshold) continue;
        out.push(
          await storyToCandidate(
            this.ports,
            story,
            this.sourceType,
            this.origin,
            clamp01(0.5 + indicator / 2),
          ),
        );
      } else if (freshness > 0.5) {
        // Cold start: a brand-new story without PWAtt coverage yet is still
        // eligible at a LOWER retrieval score (discoverability, WS-I.2.3d);
        // its first scored window replaces this path.
        out.push(
          await storyToCandidate(this.ports, story, this.sourceType, this.origin, freshness * 0.5),
        );
      }
      if (out.length >= context.limit) break;
    }
    return out;
  }
}

/** 4. Emerging discussions: threads with high CONSTRUCTIVE participation
 *  velocity (evidence/correction/synthesis additions, never raw volume). */
export class EmergingDiscussionsRetriever implements CandidateRetriever {
  readonly origin = 'emerging_discussions_v1';
  readonly sourceType = 'emerging_discussion' as const;
  constructor(
    private readonly ports: CandidateDataPorts,
    private readonly minConstructive = 2,
  ) {}

  async retrieve(context: RetrieveContext): Promise<Candidate[]> {
    const stories = await this.ports.recentStories(context.limit * 4);
    const out: Candidate[] = [];
    for (const story of stories) {
      if (!retrievable(story)) continue;
      const window = await this.ports.latestDayWindow(story.storyId);
      if (window === null) continue;
      const counts = window.contributionCounts;
      const constructive =
        (counts['evidence'] ?? 0) +
        (counts['correction'] ?? 0) +
        (counts['synthesis'] ?? 0) +
        (counts['bridge_comment'] ?? 0);
      if (constructive < this.minConstructive) continue;
      out.push(
        await storyToCandidate(
          this.ports,
          story,
          this.sourceType,
          this.origin,
          clamp01(constructive / (constructive + 4)),
        ),
      );
      if (out.length >= context.limit) break;
    }
    return out;
  }
}

/** 5. Independent source additions: stories the user previously saw that
 *  have since gained evidence/material updates. */
export class IndependentSourceAdditionsRetriever implements CandidateRetriever {
  readonly origin = 'independent_additions_v1';
  readonly sourceType = 'independent_source_addition' as const;
  constructor(private readonly ports: CandidateDataPorts) {}

  async retrieve(context: RetrieveContext): Promise<Candidate[]> {
    if (context.userId === null) return [];
    const seen = await this.ports.userSeenStories(context.userId);
    if (seen.size === 0) return [];
    const stories = await this.ports.recentStories(context.limit * 4);
    const out: Candidate[] = [];
    for (const story of stories) {
      if (!retrievable(story)) continue;
      const lastSeen = seen.get(story.storyId);
      if (lastSeen === undefined) continue;
      if (story.lastMaterialUpdateAt <= lastSeen) continue;
      const evidence = await this.ports.evidenceCountByStory(story.storyId);
      if (evidence === 0) continue;
      out.push(
        await storyToCandidate(
          this.ports,
          story,
          this.sourceType,
          this.origin,
          recencyScore(story.lastMaterialUpdateAt, context.nowMs, 48),
        ),
      );
      if (out.length >= context.limit) break;
    }
    return out;
  }
}

/** 6. Cross-community bridges: stories whose SCOI shows interpretation
 *  divergence across communities, surfaced WITH context metadata. */
export class CrossCommunityBridgesRetriever implements CandidateRetriever {
  readonly origin = 'cross_community_bridges_v1';
  readonly sourceType = 'cross_community_bridge' as const;
  constructor(private readonly ports: CandidateDataPorts) {}

  async retrieve(context: RetrieveContext): Promise<Candidate[]> {
    const stories = await this.ports.recentStories(context.limit * 4);
    const out: Candidate[] = [];
    for (const story of stories) {
      if (!retrievable(story)) continue;
      const scoi = await this.ports.latestScoi(story.storyId);
      if (scoi === null) continue;
      if (scoi.contextState !== 'split' && scoi.contextState !== 'obstructed') continue;
      out.push(
        await storyToCandidate(
          this.ports,
          story,
          this.sourceType,
          this.origin,
          clamp01(scoi.scoi),
          {
            scoi: clamp01(scoi.scoi),
            context_state: scoi.contextState,
            lens_count: scoi.lensCount,
          },
        ),
      );
      if (out.length >= context.limit) break;
    }
    return out;
  }
}

/** 7. Expert explanations: stories from expert-led rooms and threads that
 *  carry a human (steward/community) summary layer. */
export class ExpertExplanationsRetriever implements CandidateRetriever {
  readonly origin = 'expert_explanations_v1';
  readonly sourceType = 'expert_explanation' as const;
  constructor(private readonly ports: CandidateDataPorts) {}

  async retrieve(context: RetrieveContext): Promise<Candidate[]> {
    const out: Candidate[] = [];
    const expertRooms = await this.ports.expertLedRoomIds(10);
    const seen = new Set<string>();
    for (const roomId of expertRooms) {
      for (const thread of await this.ports.threadsByRoom(roomId, context.limit)) {
        const storyId = await this.ports.storyIdByThreadId(thread.threadId);
        if (storyId === null || seen.has(storyId)) continue;
        seen.add(storyId);
        const story = await storyIfRetrievable(this.ports, storyId);
        if (story === null) continue;
        out.push(
          await storyToCandidate(
            this.ports,
            story,
            this.sourceType,
            this.origin,
            recencyScore(storyFreshnessIso(story), context.nowMs, 168),
          ),
        );
        if (out.length >= context.limit) return out;
      }
    }
    // Steward-curated summaries outside expert rooms.
    for (const story of await this.ports.recentStories(context.limit * 2)) {
      if (!retrievable(story) || seen.has(story.storyId)) continue;
      const thread = await this.ports.threadByStoryId(story.storyId);
      if (thread === null || !(await this.ports.hasHumanSummary(thread.threadId))) continue;
      seen.add(story.storyId);
      out.push(
        await storyToCandidate(
          this.ports,
          story,
          this.sourceType,
          this.origin,
          recencyScore(storyFreshnessIso(story), context.nowMs, 168) * 0.9,
        ),
      );
      if (out.length >= context.limit) break;
    }
    return out;
  }
}

/** Direct story lookup honoring visibility (helper for thread-led paths). */
async function storyIfRetrievable(
  ports: CandidateDataPorts,
  storyId: string,
): Promise<StoryRecord | null> {
  const story = await ports.storyById(storyId);
  return story !== null && retrievable(story) ? story : null;
}

/** 8. Chronological catch-up: recent unseen items in time order, respecting
 *  the user's last-seen instant per room (WS-I.1.1a acceptance). */
export class ChronologicalCatchUpRetriever implements CandidateRetriever {
  readonly origin = 'chronological_catch_up_v1';
  readonly sourceType = 'chronological_catch_up' as const;
  constructor(private readonly ports: CandidateDataPorts) {}

  async retrieve(context: RetrieveContext): Promise<Candidate[]> {
    const stories = await this.ports.recentStories(context.limit * 3);
    const seen =
      context.userId === null
        ? new Map<string, string>()
        : await this.ports.userSeenStories(context.userId);
    // Per-room last-seen: the newest instant the user saw ANY story of that
    // room; catch-up serves only items newer than that mark.
    const lastSeenByRoom = new Map<string, string>();
    for (const [storyId, seenAt] of seen) {
      const thread = await this.ports.threadByStoryId(storyId);
      const roomId = thread?.roomId ?? null;
      if (roomId === null) continue;
      const current = lastSeenByRoom.get(roomId);
      if (current === undefined || seenAt > current) lastSeenByRoom.set(roomId, seenAt);
    }
    const out: Candidate[] = [];
    for (const story of stories) {
      if (!retrievable(story)) continue;
      if (seen.has(story.storyId)) continue;
      const thread = await this.ports.threadByStoryId(story.storyId);
      const roomMark = thread?.roomId != null ? lastSeenByRoom.get(thread.roomId) : undefined;
      if (roomMark !== undefined && story.createdAt <= roomMark) continue;
      out.push(
        await storyToCandidate(
          this.ports,
          story,
          this.sourceType,
          this.origin,
          recencyScore(storyFreshnessIso(story), context.nowMs, 24 * 7),
        ),
      );
      if (out.length >= context.limit) break;
    }
    return out;
  }
}

/** WS-I.1.1a — the retriever registry: a CLOSED, named set. */
export class RetrieverRegistry {
  readonly #retrievers = new Map<string, CandidateRetriever>();

  register(retriever: CandidateRetriever): void {
    if (this.#retrievers.has(retriever.origin)) {
      throw new Error(`retriever origin "${retriever.origin}" already registered`);
    }
    this.#retrievers.set(retriever.origin, retriever);
  }

  all(): CandidateRetriever[] {
    return [...this.#retrievers.values()];
  }

  origins(): string[] {
    return [...this.#retrievers.keys()];
  }
}

/** Build the default registry with all eight retrievers (WS-I.1.1a). */
export function createDefaultRetrievers(ports: CandidateDataPorts): RetrieverRegistry {
  const registry = new RetrieverRegistry();
  registry.register(new SubscribedRoomsRetriever(ports));
  registry.register(new LocalNewsRetriever(ports));
  registry.register(new GlobalCandidatesRetriever(ports));
  registry.register(new EmergingDiscussionsRetriever(ports));
  registry.register(new IndependentSourceAdditionsRetriever(ports));
  registry.register(new CrossCommunityBridgesRetriever(ports));
  registry.register(new ExpertExplanationsRetriever(ports));
  registry.register(new ChronologicalCatchUpRetriever(ports));
  return registry;
}
