// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G forum service container (the WS-E/WS-F house pattern): in-memory
// stores by default, production boot swaps in the Drizzle adapters, and a
// module-level singleton hands the container to routes.  Includes the
// fail-closed runtime config, the contribution rate limiter, the safety
// classifier seam, metrics, and the deterministic demo seed (development
// only — production never seeds fixtures).
import { createHash } from 'node:crypto';
import type { IntegritySignalDetectedEvent } from '@licio/shared';
import { InMemorySlidingWindowStore, type SlidingWindowStore } from '../events/ingest-limiter.js';
import type { EventPipelineServices } from '../events/services.js';
import { getIdentityServices } from '../identity/services.js';
import type { IngestionServices } from '../ingestion/services.js';
import { DEFAULT_FORUM_CONFIG, type ForumRuntimeConfig, loadForumConfig } from './config.js';
import { ContributionRateLimiter } from './contributions.js';
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
  InMemorySummaryStore,
  InMemoryUploadStore,
  type LensStore,
  type RoomStore,
  type SummaryStore,
  type UploadStore,
} from './stores.js';
import { escalateThreadOnIntegritySignal } from './transitions.js';

/** In-process counters (ids and counts only — never UGC text or PII). */
export class ForumMetrics {
  readonly counters = new Map<string, number>();
  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
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
}

export interface ForumServices {
  contributions: ContributionStore;
  rooms: RoomStore;
  lenses: LensStore;
  summaries: SummaryStore;
  uploads: UploadStore;
  contributionLimiter: ContributionRateLimiter;
  safety: ContributionSafetyClassifier;
  /** WS-J.2.6b seam: the post-local-checks upload scanner. */
  uploadScanner: UploadScanner;
  /** WS-J.1.2 enforcement seam (assigned at boot; null = not enforced). */
  relationshipReader: ViewerRelationshipReader | null;
  /** WS-J.2.6 auto-block accountability seam (assigned at boot; null = none). */
  autoModerationSink: AutoModerationSink | null;
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
  relationshipReader?: ViewerRelationshipReader;
  autoModerationSink?: AutoModerationSink;
  limiterStore?: SlidingWindowStore;
  log?: (event: string, meta: Record<string, unknown>) => void;
  now?: () => number;
}

export function createInMemoryForumServices(options: InMemoryForumOptions = {}): ForumServices {
  const now = options.now ?? Date.now;
  let config: ForumRuntimeConfig = { ...DEFAULT_FORUM_CONFIG, ...options.config };
  const pending: Array<Promise<unknown>> = [];
  const metrics = new ForumMetrics();

  // The contribution↔evidence co-create is transactional THROUGH the
  // ingestion evidence store (the sink); without ingestion services the
  // forum still works, evidence co-creation simply has no card sink.
  const ingestion = options.ingestion;
  const evidenceSink = ingestion
    ? {
        insertForumCard: (
          card: Parameters<IngestionServices['evidence']['insertForumCard']>[0],
          createdAt: string,
        ) => ingestion.evidence.insertForumCard(card, createdAt),
        removeForumCard: (evidenceId: string) => ingestion.evidence.removeForumCard(evidenceId),
      }
    : null;

  const services: ForumServices = {
    contributions: new InMemoryContributionStore(now, evidenceSink),
    rooms: new InMemoryRoomStore(now),
    lenses: new InMemoryLensStore(now),
    summaries: new InMemorySummaryStore(now),
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
    relationshipReader: options.relationshipReader ?? null,
    autoModerationSink: options.autoModerationSink ?? null,
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
  }

  // WS-Q.2.5a — wire the in-memory global-search room-visibility resolver now
  // that the room store exists (ingestion was constructed first). The Drizzle
  // search adapter resolves this with a SQL join instead.
  if (ingestion) {
    ingestion.setSearchRoomVisibilityProvider(async () => {
      const map = new Map<string, 'public' | 'private'>();
      for (const room of await services.rooms.list({ limit: 100_000 })) {
        map.set(room.roomId, room.visibility);
      }
      return map;
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
