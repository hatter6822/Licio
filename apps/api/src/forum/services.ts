// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G forum service container (the WS-E/WS-F house pattern): in-memory
// stores by default, production boot swaps in the Drizzle adapters, and a
// module-level singleton hands the container to routes.  Includes the
// fail-closed runtime config, the contribution rate limiter, the safety
// classifier seam, metrics, and the deterministic demo seed (development
// only — production never seeds fixtures).
import { createHash } from 'node:crypto';
import type { ContributionType, IntegritySignalDetectedEvent } from '@licio/shared';
import { InMemorySlidingWindowStore, type SlidingWindowStore } from '../events/ingest-limiter.js';
import type { EventPipelineServices } from '../events/services.js';
import { getIdentityServices } from '../identity/services.js';
import { SEARCH_COMMENT_SNIPPET_LENGTH, type SearchDocument } from '../ingestion/search.js';
import type { IngestionServices } from '../ingestion/services.js';
import type { StoryRecord, ThreadShellRecord } from '../ingestion/stores.js';
import { type CommentBroadcaster, InMemoryCommentBroadcaster } from './comment-broadcaster.js';
import { DEFAULT_FORUM_CONFIG, type ForumRuntimeConfig, loadForumConfig } from './config.js';
import { ContributionRateLimiter } from './contributions.js';
import type { DebateJudgeRunner, DebateWindowsOverride } from './debate.js';
import { type DebateBroadcaster, InMemoryDebateBroadcaster } from './debate-broadcaster.js';
import { type DebateStore, InMemoryDebateStore } from './debate-store.js';
import {
  type ContributionSafetyClassifier,
  HeuristicContributionSafety,
  LocalChecksUploadScanner,
  type UploadScanner,
} from './safety.js';
import {
  type ContributionStore,
  InMemoryContributionStore,
  InMemoryLensStore,
  InMemoryRoomStore,
  InMemoryUploadStore,
  type LensStore,
  type RoomStore,
  type UploadStore,
} from './stores.js';
import { escalateThreadOnIntegritySignal } from './transitions.js';
import { captionTextFromVtt } from './video.js';

/** In-process counters (ids and counts only — never UGC text or PII). */
export class ForumMetrics {
  readonly counters = new Map<string, number>();
  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }
  counter(name: string): number {
    return this.counters.get(name) ?? 0;
  }
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }
}

/**
 * The WS-J block/mute enforcement seam (a narrow structural port; the
 * moderation `RelationshipReader` is assigned here at boot).  Default `null`
 * means no relationships are enforced — forum stays usable standalone.
 */
export interface ViewerRelationshipReader {
  /** The viewer's hide sets (blocked ∪ muted) for content filtering. */
  setsFor(userId: string): Promise<{ blocked: Set<string>; muted: Set<string> }>;
  /** True when actor↔target are blocked (either direction) — interaction reject. */
  interactionBlocked(actorUserId: string, targetUserId: string): Promise<boolean>;
}

/**
 * WS-J.2.6a/b auto-block accountability seam: when a contribution is
 * auto-blocked (high-confidence spam/malware), this records the system
 * moderation action + audit + the appealable statement-of-reasons notice.
 * Assigned at boot (null = no accountability sink; the content is still
 * persisted `removed`).
 */
export interface AutoModerationSink {
  recordContentAutoBlock(input: {
    contributionId: string;
    authorUserId: string;
    reasonCode: string;
    reasons: string[];
  }): Promise<void>;
  /**
   * WS-U: the in-room community agent held/removed a contribution. Emits the
   * author's statement-of-reasons notice (no silent sanction) — a COMMUNITY
   * action carrying no platform reason code, with the human-floor review as its
   * recourse. The agent's provenance triple is already in the knomosis audit log.
   */
  recordAgentHold(input: {
    contributionId: string;
    authorUserId: string;
    removed: boolean;
    reason: string | null;
  }): Promise<void>;
}

/**
 * WS-U bounded in-room agent seam (SPEC §16.6/§24.6). When the thread's room has
 * an active community-approved governance binding, this returns the agent's
 * deterministic, capability-gated moderation recommendation for a contribution;
 * `null` ⇒ no active agent (the platform floor alone decides). The decision is
 * combined FLOOR-DOMINANTLY by the caller (the agent can only add caution, never
 * reduce or reverse a floor decision — it holds no floor-reserved capability).
 * The governance adapter (`governance/forum-agent.ts`) is assigned at boot;
 * `null` keeps the forum usable standalone.
 */
export interface RoomAgentModerator {
  moderateContribution(input: {
    roomId: string;
    contributionId: string;
    /** The contribution author (for the SPEC §24.6 author-history signals). */
    authorUserId: string;
    type: ContributionType;
    body: string;
    citationCount: number;
    attachmentCount: number;
  }): Promise<{
    state: 'published' | 'under_review' | 'removed';
    /** The community-policy statement of reasons (for the author notice). */
    reason?: string;
  } | null>;
}

export interface ForumServices {
  contributions: ContributionStore;
  rooms: RoomStore;
  lenses: LensStore;
  uploads: UploadStore;
  contributionLimiter: ContributionRateLimiter;
  safety: ContributionSafetyClassifier;
  /** WS-J.2.6b seam: the post-local-checks upload scanner. */
  uploadScanner: UploadScanner;
  /** WS-T.5 same-origin live comment stream fan-out. */
  commentBroadcaster: CommentBroadcaster;
  /** WS-J.1.2 enforcement seam (assigned at boot; null = not enforced). */
  relationshipReader: ViewerRelationshipReader | null;
  /** Platform-role reader for the WS-Q read bar's platform-ADMIN arm (assigned
   *  at boot over the identity store; null = no platform arm — the private-room
   *  content bar stays membership/room-steward only, the fail-closed default).
   *  Consulted ONLY on the private-server-room miss path (2026-07 maintainer
   *  decision: admin reads every server-hosted area; WS-S member-hosted rooms
   *  stay excluded by construction). */
  platformRolesReader: ((userId: string) => Promise<readonly string[]>) | null;
  /** WS-J.2.6 auto-block accountability seam (assigned at boot; null = none). */
  autoModerationSink: AutoModerationSink | null;
  /** WS-U bounded in-room agent seam (assigned at boot; null = no agent). */
  agentModerator: RoomAgentModerator | null;
  /** WS-T debate arena store (sourced-correction adjudication). */
  debates: DebateStore;
  /** WS-T live arena fan-out (co-visible position drafts + verdict + resolution). */
  debateBroadcaster: DebateBroadcaster;
  /** WS-T governed-adjudicator runner (assigned at boot over the ai-governance
   *  guard + neural model + AIOutputRecord; the default is fail-closed → a null
   *  verdict resolves inconclusive, so an unwired forum never tags anything). */
  debateJudge: DebateJudgeRunner;
  /** WS-T arena-window override (DEV traffic simulator / tests ONLY — set while
   *  the simulator runs so the correction → adjudication → finalize lifecycle
   *  completes on an observable cadence; null ⇒ the §15.4 spec windows —
   *  nothing in production wiring ever sets it).  The simulator scopes it via
   *  `appliesToUser` to arenas whose parties are BOTH synthetic personas, so a
   *  debate a real dev-account user is party to runs the REAL spec windows.
   *  Every DebateDeps construction site threads it through. */
  debateWindowsOverride: DebateWindowsOverride | null;
  metrics: ForumMetrics;
  config: () => ForumRuntimeConfig;
  reloadConfig: () => Promise<ForumRuntimeConfig>;
  /** Merged drainer blocklist (defaults ∪ runtime config) + content version. */
  linkBlocklist: () => { version: string; domains: string[] };
  log: (event: string, meta: Record<string, unknown>) => void;
  trackBackground: (work: Promise<unknown>) => void;
  /** Await all detached work (tests). */
  settle: () => Promise<void>;
  now: () => number;
}

export interface InMemoryForumOptions {
  events?: EventPipelineServices;
  ingestion?: IngestionServices;
  config?: Partial<ForumRuntimeConfig>;
  safety?: ContributionSafetyClassifier;
  uploadScanner?: UploadScanner;
  commentBroadcaster?: CommentBroadcaster;
  relationshipReader?: ViewerRelationshipReader;
  platformRolesReader?: (userId: string) => Promise<readonly string[]>;
  autoModerationSink?: AutoModerationSink;
  agentModerator?: RoomAgentModerator;
  debates?: DebateStore;
  debateJudge?: DebateJudgeRunner;
  limiterStore?: SlidingWindowStore;
  log?: (event: string, meta: Record<string, unknown>) => void;
  now?: () => number;
}

export function createInMemoryForumServices(options: InMemoryForumOptions = {}): ForumServices {
  const now = options.now ?? Date.now;
  let config: ForumRuntimeConfig = { ...DEFAULT_FORUM_CONFIG, ...options.config };
  const pending: Array<Promise<unknown>> = [];
  const metrics = new ForumMetrics();

  const ingestion = options.ingestion;

  const services: ForumServices = {
    contributions: new InMemoryContributionStore(now),
    rooms: new InMemoryRoomStore(now),
    lenses: new InMemoryLensStore(now),
    uploads: new InMemoryUploadStore(now),
    contributionLimiter: new ContributionRateLimiter(
      options.limiterStore ?? new InMemorySlidingWindowStore(),
    ),
    safety:
      options.safety ??
      (ingestion
        ? new HeuristicContributionSafety(ingestion.urlSafety)
        : { classify: async () => ({ disposition: 'clear' as const, reasons: [] }) }),
    uploadScanner: options.uploadScanner ?? new LocalChecksUploadScanner(),
    commentBroadcaster: options.commentBroadcaster ?? new InMemoryCommentBroadcaster(),
    relationshipReader: options.relationshipReader ?? null,
    platformRolesReader: options.platformRolesReader ?? null,
    autoModerationSink: options.autoModerationSink ?? null,
    agentModerator: options.agentModerator ?? null,
    debates: options.debates ?? new InMemoryDebateStore(now),
    debateBroadcaster: new InMemoryDebateBroadcaster(),
    debateJudge: options.debateJudge ?? (async () => null),
    debateWindowsOverride: null,
    metrics,
    config: () => config,
    reloadConfig: async () => config,
    linkBlocklist: () => {
      const merged = [
        ...new Set([...SHIPPED_DRAINER_BLOCKLIST, ...config.drainerBlocklist]),
      ].sort();
      const version = createHash('sha256').update(merged.join('\n')).digest('hex').slice(0, 16);
      return { version, domains: merged };
    },
    log: options.log ?? (() => {}),
    trackBackground: (work) => {
      pending.push(
        work.catch((error) => {
          services.log('forum.background_error', { error: String(error) });
        }),
      );
    },
    settle: async () => {
      while (pending.length > 0) {
        const batch = pending.splice(0, pending.length);
        await Promise.all(batch);
      }
    },
    now,
  };

  if (options.events) {
    const events = options.events;
    services.reloadConfig = async () => {
      config = {
        ...DEFAULT_FORUM_CONFIG,
        ...options.config,
        ...(await loadForumConfig(events.configStore, (key, problem) =>
          services.log('forum.config_invalid', { key, problem }),
        )),
      };
      return config;
    };
    // WS-S.1.4 — wire the event-pipeline Private-P2P-room gate now that the room
    // store exists: any content event referencing a p2p room is refused at
    // publish + counted (§8.4/§23.7). The guards upstream already prevent such
    // an event from being created, so this is defense in depth.
    events.router.setP2pRoomGuard(async (roomId) => {
      const room = await services.rooms.getById(roomId);
      return room?.storageMode === 'p2p';
    });
  }

  if (ingestion) {
    // WS-K §24.1 — let the §14.2 pipeline read an uploaded WebVTT caption track's
    // text (uploads live here, in the forum). A caption-only video then gets its
    // sensitivity labels / claims / excerpt / freshness, not only its topics.
    ingestion.setCaptionTextReader(async (uploadId) => {
      const bytes = await services.uploads.getBytes(uploadId);
      return bytes === null ? null : captionTextFromVtt(bytes);
    });
    // WS-Q.2.5a + WS-F.3.1a — supply everything the in-memory unified search
    // needs from the forum, from ONE room scan per query: the room-visibility
    // resolution for STORY documents and the comment + room documents. One
    // fetch means story and comment coordinates resolve from the SAME room
    // set — no asymmetric fail-closed edge between the two. Documents carry
    // their own visibility / dispute coordinates; the index applies the
    // predicates at query time (so moderation, WS-T outcomes, and
    // room-visibility changes take effect immediately — the corpus is a live
    // projection, never a stale snapshot). The Drizzle search adapter reads
    // these tables with SQL joins instead, and the production boot replaces
    // the index wholesale, so this provider only ever serves the in-memory
    // (dev/test/E2E) index.
    //
    // Bounds: rooms use the WS-Q resolution bound (a fail-closed map must be
    // as complete as possible — an evicted room would HIDE its stories);
    // contributions use the per-corpus document bound (stories/claims parity).
    const ROOM_RESOLUTION_LIMIT = 100_000;
    const SEARCH_CORPUS_LIMIT = 10_000;
    ingestion.setSearchForumCorpusProvider(async () => {
      const documents: SearchDocument[] = [];
      const rooms = await services.rooms.list({ limit: ROOM_RESOLUTION_LIMIT });
      const roomVisibilityById = new Map(
        rooms.map((room) => [room.roomId, room.visibility] as const),
      );
      const roomById = new Map(rooms.map((room) => [room.roomId, room] as const));
      for (const room of rooms) {
        documents.push({
          resultType: 'room',
          id: room.roomId,
          storyId: null,
          title: room.name,
          body: `${room.description ?? ''} ${room.charterSummary ?? ''}`,
          snippet: room.description,
          // WS-T adjudicates stories/comments, never rooms.
          disputeStatus: 'none',
          topicIds: [],
          sourceId: null,
          language: null,
          createdAt: room.createdAt,
          visible: true,
          roomId: room.roomId,
          // A room record has no item tier of its own — the constant `public`
          // coordinate defers entirely to the room axis below, so only PUBLIC
          // `server` rooms ever surface (private/p2p shells are reached via
          // the rooms directory, never global content search).
          storyVisibility: 'public',
          roomVisibility: room.visibility,
          roomStorageMode: room.storageMode,
        });
      }
      const contributions = await services.contributions.listRecent(SEARCH_CORPUS_LIMIT);
      const threadCache = new Map<string, ThreadShellRecord | null>();
      const storyCache = new Map<string, StoryRecord | null>();
      const threadRemovedCache = new Map<string, boolean>();
      for (const contribution of contributions) {
        let thread = threadCache.get(contribution.threadId);
        if (thread === undefined) {
          thread = await ingestion.stories.getThreadById(contribution.threadId);
          threadCache.set(contribution.threadId, thread);
        }
        if (thread === null) continue;
        let story = storyCache.get(thread.storyId);
        if (story === undefined) {
          story = await ingestion.stories.getById(thread.storyId);
          storyCache.set(thread.storyId, story);
        }
        if (story === null) continue;
        let threadRemoved = threadRemovedCache.get(contribution.threadId);
        if (threadRemoved === undefined) {
          // A WS-J moderation removal on the thread (item-safety `removed`)
          // hides every direct read — search must match (threadReadableToUser).
          threadRemoved =
            options.events !== undefined &&
            (await options.events.safetyStore.get(contribution.threadId))?.safetyState ===
              'removed';
          threadRemovedCache.set(contribution.threadId, threadRemoved);
        }
        const room = roomById.get(story.roomId);
        documents.push({
          resultType: 'comment',
          id: contribution.contributionId,
          storyId: story.storyId,
          // A Postgres generated column indexes only its OWN row, so a comment
          // matches on its body alone; the parent story's title is display-only
          // (the story corpus covers title matches).
          title: '',
          body: contribution.body,
          // Code-POINT slice: Postgres `left(body, N)` counts characters, JS
          // `String.slice` counts UTF-16 units — the spread keeps the two
          // adapters serving the same snippet through astral-plane characters.
          snippet: [...contribution.body].slice(0, SEARCH_COMMENT_SNIPPET_LENGTH).join(''),
          displayTitle: story.title,
          disputeStatus: contribution.disputeStatus,
          topicIds: [],
          sourceId: null,
          language: null,
          createdAt: contribution.createdAt,
          // Published + thread not moderation-removed + owning story not
          // hidden — the threadReadableToUser bar; the two-tier coordinates
          // below carry the room/item arm.
          visible:
            contribution.moderationState === 'published' &&
            !threadRemoved &&
            story.hiddenState === null,
          roomId: story.roomId,
          storyVisibility: story.visibility,
          // Fail closed on an unresolved room, exactly like the global gate.
          roomVisibility: room?.visibility ?? 'private',
          roomStorageMode: room?.storageMode ?? 'p2p',
        });
      }
      return { roomVisibilityById, documents };
    });
  }

  return services;
}

/** Drainer domains shipped with the app (the runtime config EXTENDS this
 *  without a deploy, WS-G.4.2c).  Deliberately empty at launch: real entries
 *  come from operations/community lists via the steward config surface —
 *  shipping guesses would only manufacture false positives.  (The
 *  KNOWN_DAPP_DOMAINS constant in @licio/shared is the opposite list: the
 *  LEGITIMATE domains mimicry detection protects.) */
const SHIPPED_DRAINER_BLOCKLIST: readonly string[] = [];

/**
 * Register the forum's WS-E router consumers (the registerIngestionConsumers
 * pattern — durable, so checkpoint replay re-drives missed events at boot).
 *
 * `forum-thread-posture`: a WS-E harassment-cascade detection against a
 * story elevates its thread's safety posture and marks the conversation
 * tense (transitions.ts `escalateThreadOnIntegritySignal`).  The signal is
 * `restricted` (it reveals detection thresholds) and this consumer is
 * non-scoring, so the pay-to-rank firewall admits it; thread posture is a
 * moderation surface, never a ranking input.  Idempotent under
 * at-least-once redelivery: already-escalated threads no-op.
 */
export function registerForumConsumers(
  events: EventPipelineServices,
  ingestion: IngestionServices,
  forum: ForumServices,
): void {
  events.router.register({
    name: 'forum-thread-posture',
    topics: ['integrity.signal.detected'],
    accessClassifications: ['restricted'],
    scoring: false,
    durable: true,
    handle: async (event) => {
      const signal = event as IntegritySignalDetectedEvent;
      if (signal.signal_type !== 'harassment_cascade') return;
      const deps = {
        stories: ingestion.stories,
        events,
        audit: getIdentityServices().audit,
        trackBackground: forum.trackBackground,
        now: forum.now,
      };
      for (const itemId of signal.target_ids) {
        // Cascade target ids are HETEROGENEOUS: attention-driven items carry
        // story ids, while contribution/evidence-driven items carry THREAD
        // ids (pwatt/aggregation.ts folds those events by payload.thread_id).
        // Resolve thread-first so forum-driven cascades — the common case
        // for harassment — are never silently skipped.
        const thread =
          (await ingestion.stories.getThreadById(itemId)) ??
          (await ingestion.stories.getThreadByStoryId(itemId));
        if (!thread) continue;
        const applied = await escalateThreadOnIntegritySignal(
          deps,
          thread.threadId,
          signal.signal_type,
          signal.confidence,
        );
        if (applied.safetyApplied) forum.metrics.increment('threads.safety_escalated');
        if (applied.conversationApplied) forum.metrics.increment('threads.marked_tense');
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Module singleton (the house pattern routes resolve through).
// ---------------------------------------------------------------------------

let singleton: ForumServices | null = null;

export function setForumServices(services: ForumServices): void {
  singleton = services;
}

export function getForumServices(): ForumServices {
  if (!singleton) {
    singleton = createInMemoryForumServices();
  }
  return singleton;
}

export function resetForumServicesForTests(): void {
  singleton = null;
}
