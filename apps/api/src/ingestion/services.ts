// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F ingestion service container (the WS-D/WS-E house pattern): one
// injectable bundle of stores + providers + config, a module singleton for
// routes, and a fresh in-memory bundle per test. Production boot
// (apps/api/src/index.ts) swaps in the Drizzle adapters, the Redis-backed
// submission limiter window, and the self-hosted embedding provider.
//
// Async ingestion work rides the WS-E EVENT ROUTER as durable consumers
// (registerIngestionConsumers): at-least-once delivery, bounded retries,
// dead-lettering, and checkpoint replay at boot all come from the existing
// pipeline instead of a parallel job system. The submission ROUTE detaches
// publication (`trackBackground`) so extraction latency never blocks the
// 201 response (WS-F.1.4c ≤ 500 ms budget); crash-safety is the durable
// log + checkpoint replay, not the in-flight promise.
import type { ContentNormalizedEvent, ContentSubmittedEvent } from '@licio/shared';
import { InMemorySlidingWindowStore } from '../events/ingest-limiter.js';
import type { EventPipelineServices } from '../events/services.js';
import { type ClaimExtractor, HeuristicClaimExtractor } from './claims.js';
import {
  DEFAULT_INGESTION_CONFIG,
  type IngestionRuntimeConfig,
  loadIngestionConfig,
} from './config.js';
import { DeterministicLexicalProvider, type EmbeddingProvider, embedTarget } from './embeddings.js';
import { recomputeFreshness } from './freshness.js';
import { applyLifecycleTrigger, type LifecycleMetricsSink } from './lifecycle.js';
import { processSubmittedStory } from './pipeline.js';
import {
  LocalDenylistUrlSafety,
  SubmissionRateLimiter,
  type UrlSafetyProvider,
} from './prechecks.js';
import { RobotsCache, type RobotsFetcher } from './robots.js';
import { type SafeFetchLimits, type SafeFetchResult, safeFetch } from './safe-fetch.js';
import { InMemorySearchIndex, type SearchDocument, type SearchIndex } from './search.js';
import {
  type ClaimStore,
  type EmbeddingStore,
  type EvidenceCardStore,
  type FreshnessStore,
  InMemoryClaimStore,
  InMemoryEmbeddingStore,
  InMemoryEvidenceCardStore,
  InMemoryFreshnessStore,
  InMemoryLifecycleAuditStore,
  InMemoryReviewQueueStore,
  InMemorySignatureStore,
  InMemorySourceStore,
  InMemoryStoryStore,
  InMemorySyndicationStore,
  InMemoryTakedownStore,
  type LifecycleAuditStore,
  type ReviewQueueStore,
  type SignatureStore,
  type SourceStore,
  type StoryStore,
  type SyndicationStore,
  type TakedownStore,
} from './stores.js';

/** In-process ingestion counters (ids/counts only — never content values). */
export class IngestionMetrics implements LifecycleMetricsSink {
  readonly counters = new Map<string, number>();

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  onTransition(from: string, to: string): void {
    this.increment(`lifecycle.${from}->${to}`);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }
}

export interface IngestionServices {
  stories: StoryStore;
  sources: SourceStore;
  syndications: SyndicationStore;
  claims: ClaimStore;
  evidence: EvidenceCardStore;
  signatures: SignatureStore;
  lifecycleAudits: LifecycleAuditStore;
  freshness: FreshnessStore;
  takedowns: TakedownStore;
  reviewQueue: ReviewQueueStore;
  embeddings: EmbeddingStore;
  searchIndex: SearchIndex;
  /** WS-Q.2.5a — late-bound hook the forum boot sets so the in-memory global
   *  search predicate can resolve each story's home-room visibility. */
  setSearchRoomVisibilityProvider: (
    provider: () => Promise<Map<string, 'public' | 'private'>>,
  ) => void;
  /** WS-K §24.1 — read the plain text of an uploaded WebVTT caption track (a
   *  video's only first-party text). Returns null when there is no reader wired
   *  or no such upload. The §14.2 pipeline uses it so a caption-only video gets
   *  sensitivity labels, claims, an excerpt, and freshness — not just topics.
   *  Late-bound (uploads live in the forum, built after ingestion); default
   *  returns null. */
  readCaptionText: (uploadId: string) => Promise<string | null>;
  /** Forum boot sets the {@link IngestionServices.readCaptionText} reader. */
  setCaptionTextReader: (reader: (uploadId: string) => Promise<string | null>) => void;
  /** WS-K §24.1 — validate a story's topics over EPHEMERAL text the persisted
   *  story does not carry (a `noarchive` link's fetched body, dropped before the
   *  deferred content.normalized validator runs). Runs the WS-K classifier
   *  authoritatively (consumes the proposals so the deferred re-run preserves).
   *  Late-bound (the classifier lives in WS-K, wired after ingestion); default is
   *  a no-op so a topic simply stays unvalidated until other text supports it. */
  revalidateTopicsFromText: (storyId: string, text: string) => Promise<void>;
  /** WS-K boot sets the {@link IngestionServices.revalidateTopicsFromText} hook. */
  setTopicRevalidator: (fn: (storyId: string, text: string) => Promise<void>) => void;
  submissionLimiter: SubmissionRateLimiter;
  /**
   * DEVELOPMENT/TEST ONLY: when true, the account-age ("account too new")
   * submission gate is dropped so a freshly created local account can post
   * immediately — the ingestion-side parallel of the `POST /v1/auth/dev/verify`
   * verification shortcut. Set fail-closed at boot from a development/test
   * `NODE_ENV` allowlist (apps/api/src/index.ts); never true in production.
   */
  skipAccountAgeGate: boolean;
  urlSafety: UrlSafetyProvider;
  claimExtractor: ClaimExtractor;
  embeddingProvider: EmbeddingProvider;
  robots: RobotsCache;
  /** Injectable document fetcher (tests stub it; prod = safeFetch). */
  fetchDocument: (url: string, limits: SafeFetchLimits) => Promise<SafeFetchResult>;
  /** The cached runtime config; reload via reloadConfig(). */
  config: () => IngestionRuntimeConfig;
  reloadConfig: () => Promise<IngestionRuntimeConfig>;
  metrics: IngestionMetrics;
  /** Detached-work tracker: the route never awaits pipeline latency, tests
   *  await settle() for determinism. */
  trackBackground: (work: Promise<unknown>) => void;
  settle: () => Promise<void>;
  log: (event: string, meta: Record<string, unknown>) => void;
  now: () => number;
}

export interface InMemoryIngestionOptions {
  events?: EventPipelineServices;
  fetchDocument?: (url: string, limits: SafeFetchLimits) => Promise<SafeFetchResult>;
  robotsFetcher?: RobotsFetcher;
  claimExtractor?: ClaimExtractor;
  embeddingProvider?: EmbeddingProvider;
  config?: Partial<IngestionRuntimeConfig>;
  /** DEV/TEST escape hatch: drop the account-age submission gate (default
   *  false). The boot path sets this from a development/test NODE_ENV
   *  allowlist; tests set it explicitly to exercise either posture. */
  skipAccountAgeGate?: boolean;
  log?: (event: string, meta: Record<string, unknown>) => void;
  now?: () => number;
}

/** Build the in-memory search-document provider over the live stores. */
/** The per-story search-visibility coordinates a claim/evidence hit inherits. */
interface StoryDocMeta {
  visible: boolean;
  roomId: string | null;
  storyVisibility: 'public' | 'room_only';
  roomVisibility: 'public' | 'private';
  /** WS-S.1.4 — every search doc is built from a SERVER story row (a Private
   *  P2P room has no server stories, the §8 non-storage contract enforced at
   *  submission), so this is `server` by construction; the InMemorySearchIndex
   *  filter (and the Drizzle adapter's `storage_mode='server'` predicate) is the
   *  live type-level backstop (§23.6). */
  roomStorageMode: 'server' | 'p2p';
}

/** A null-story (cross-story / user-experience) hit: global-eligible, never
 *  room-scoped (its roomId is null, so `?room=` excludes it). */
const FREE_DOC_META: StoryDocMeta = {
  visible: true,
  roomId: null,
  storyVisibility: 'public',
  roomVisibility: 'public',
  roomStorageMode: 'server',
};

export function buildSearchDocuments(
  allStories: () => Promise<StoryRecordLike[]>,
  allClaims: () => Promise<ClaimRecordLike[]>,
  allEvidence: () => Promise<EvidenceRecordLike[]>,
  /** WS-Q.2.5a — resolves each story's home-room visibility (fail-closed: an
   *  unknown room is treated as `private`, so a row whose room can't be
   *  resolved never surfaces globally). */
  roomVisibilityById: () => Promise<Map<string, 'public' | 'private'>>,
): () => Promise<SearchDocument[]> {
  return async () => {
    const documents: SearchDocument[] = [];
    const roomVis = await roomVisibilityById();
    const storyMeta = new Map<string, StoryDocMeta>();
    for (const story of await allStories()) {
      const meta: StoryDocMeta = {
        visible: story.hiddenState === null,
        roomId: story.roomId,
        storyVisibility: story.visibility,
        roomVisibility: roomVis.get(story.roomId) ?? 'private',
        // A story row only ever belongs to a server room (p2p rooms reject
        // submission, WS-S.1.3); the query filter excludes anything else.
        roomStorageMode: 'server',
      };
      storyMeta.set(story.storyId, meta);
      documents.push({
        resultType: 'story',
        id: story.storyId,
        storyId: story.storyId,
        title: story.title,
        body: `${story.excerpt ?? ''} ${story.publisher ?? ''} ${story.author ?? ''}`,
        snippet: story.excerpt,
        topicIds: story.topicIds,
        sourceId: story.sourceId,
        language: story.language,
        createdAt: story.createdAt,
        visible: meta.visible,
        roomId: meta.roomId,
        storyVisibility: meta.storyVisibility,
        roomVisibility: meta.roomVisibility,
        roomStorageMode: meta.roomStorageMode,
      });
    }
    for (const claim of await allClaims()) {
      const meta =
        claim.storyId === null ? FREE_DOC_META : (storyMeta.get(claim.storyId) ?? FREE_DOC_META);
      documents.push({
        resultType: 'claim',
        id: claim.claimId,
        storyId: claim.storyId,
        title: claim.canonicalText,
        body: claim.canonicalText,
        snippet: null,
        topicIds: [],
        sourceId: null,
        language: null,
        createdAt: claim.createdAt,
        visible: claim.claimStatus !== 'retracted' && meta.visible,
        roomId: meta.roomId,
        storyVisibility: meta.storyVisibility,
        roomVisibility: meta.roomVisibility,
        roomStorageMode: meta.roomStorageMode,
      });
    }
    for (const card of await allEvidence()) {
      // Evidence on a hidden story is excluded too (null story_id ⇒
      // user-experience evidence, always visible). Mirrors the claim path.
      const meta =
        card.storyId === null ? FREE_DOC_META : (storyMeta.get(card.storyId) ?? FREE_DOC_META);
      documents.push({
        resultType: 'evidence',
        id: card.evidenceId,
        storyId: card.storyId,
        title: card.relevanceNote,
        body: `${card.relevanceNote} ${card.citationUrlOrRef}`,
        snippet: card.relevanceNote,
        topicIds: [],
        sourceId: card.sourceId,
        language: null,
        createdAt: card.createdAt,
        visible: card.verificationState !== 'retracted' && meta.visible,
        roomId: meta.roomId,
        storyVisibility: meta.storyVisibility,
        roomVisibility: meta.roomVisibility,
        roomStorageMode: meta.roomStorageMode,
      });
    }
    return documents;
  };
}

interface StoryRecordLike {
  storyId: string;
  title: string;
  excerpt: string | null;
  publisher: string | null;
  author: string | null;
  topicIds: string[];
  sourceId: string | null;
  language: string | null;
  createdAt: string;
  hiddenState: 'takedown' | 'safety' | null;
  /** WS-Q.2.5a — the home room + item visibility (the global tier predicate). */
  roomId: string;
  visibility: 'public' | 'room_only';
}
interface ClaimRecordLike {
  claimId: string;
  storyId: string | null;
  canonicalText: string;
  claimStatus: string;
  createdAt: string;
}
interface EvidenceRecordLike {
  evidenceId: string;
  storyId: string | null;
  relevanceNote: string;
  citationUrlOrRef: string;
  sourceId: string | null;
  verificationState: string;
  createdAt: string;
}

/** A fresh, fully in-memory ingestion bundle (tests/dev; prod swaps adapters). */
export function createInMemoryIngestionServices(
  options: InMemoryIngestionOptions = {},
): IngestionServices {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const stories = new InMemoryStoryStore(now);
  const claims = new InMemoryClaimStore(now);
  const evidence = new InMemoryEvidenceCardStore(now);
  let config: IngestionRuntimeConfig = { ...DEFAULT_INGESTION_CONFIG, ...options.config };
  const background: Array<Promise<unknown>> = [];
  /** Search-corpus bound for the in-memory index (the Drizzle search adapter
   *  queries the full FTS index instead). */
  const SEARCH_CORPUS_LIMIT = 10_000;
  // WS-Q.2.5a — the in-memory global search predicate needs each story's
  // home-room visibility. Ingestion is constructed before forum, so the
  // provider is a late-bound hook the forum boot sets (default fail-closed:
  // all rooms unknown ⇒ private ⇒ nothing surfaces globally until wired).
  let roomVisibilityProvider: () => Promise<Map<string, 'public' | 'private'>> = async () =>
    new Map();
  // WS-K §24.1 — late-bound uploaded-caption reader (uploads live in the forum,
  // built after ingestion). Default: no captions available.
  let captionTextReader: (uploadId: string) => Promise<string | null> = async () => null;
  // WS-K §24.1 — late-bound topic revalidator (the classifier lives in WS-K,
  // built after ingestion). Default: a no-op.
  let topicRevalidator: (storyId: string, text: string) => Promise<void> = async () => {};

  const services: IngestionServices = {
    stories,
    sources: new InMemorySourceStore(now),
    syndications: new InMemorySyndicationStore(now),
    claims,
    evidence,
    signatures: new InMemorySignatureStore(now),
    lifecycleAudits: new InMemoryLifecycleAuditStore(now),
    freshness: new InMemoryFreshnessStore(),
    takedowns: new InMemoryTakedownStore(now),
    reviewQueue: new InMemoryReviewQueueStore(now),
    embeddings: new InMemoryEmbeddingStore(now),
    searchIndex: undefined as unknown as SearchIndex, // assigned below
    setSearchRoomVisibilityProvider: () => {}, // assigned below
    readCaptionText: (uploadId) => captionTextReader(uploadId),
    setCaptionTextReader: () => {}, // assigned below
    revalidateTopicsFromText: (storyId, text) => topicRevalidator(storyId, text),
    setTopicRevalidator: () => {}, // assigned below
    submissionLimiter: new SubmissionRateLimiter(new InMemorySlidingWindowStore()),
    // Fail-closed: the account-age gate stays ON unless the caller (boot path)
    // opts out for a development/test environment.
    skipAccountAgeGate: options.skipAccountAgeGate ?? false,
    urlSafety: undefined as unknown as UrlSafetyProvider, // assigned below (reads config)
    claimExtractor: options.claimExtractor ?? new HeuristicClaimExtractor(),
    embeddingProvider: options.embeddingProvider ?? new DeterministicLexicalProvider(),
    robots: new RobotsCache(
      options.robotsFetcher ??
        (async (origin) => {
          const result = await (options.fetchDocument ?? safeFetch)(`${origin}/robots.txt`, {
            timeoutMs: config.fetchTimeoutMs,
            maxBytes: 256 * 1024,
            maxRedirects: 2,
            userAgent: config.crawlerUserAgent,
          });
          if (!result.ok) return { error: result.reason };
          return { status: result.status, body: result.body };
        }),
      now,
    ),
    fetchDocument: options.fetchDocument ?? safeFetch,
    config: () => config,
    reloadConfig: async () => config,
    metrics: new IngestionMetrics(),
    trackBackground: (work) => {
      background.push(
        work.catch((error) => {
          log('ingestion.background_failed', {
            detail: error instanceof Error ? error.message : 'unknown',
          });
        }),
      );
      if (background.length > 256) background.splice(0, background.length - 256);
    },
    settle: async () => {
      while (background.length > 0) {
        const pending = background.splice(0, background.length);
        await Promise.allSettled(pending);
      }
    },
    log,
    now,
  };

  services.urlSafety = new LocalDenylistUrlSafety(() => config.malwareDomains);
  services.setSearchRoomVisibilityProvider = (provider) => {
    roomVisibilityProvider = provider;
  };
  services.setCaptionTextReader = (reader) => {
    captionTextReader = reader;
  };
  services.setTopicRevalidator = (fn) => {
    topicRevalidator = fn;
  };
  services.searchIndex = new InMemorySearchIndex(
    buildSearchDocuments(
      () => stories.listRecent(SEARCH_CORPUS_LIMIT),
      () => claims.listRecent(SEARCH_CORPUS_LIMIT),
      () => evidence.listRecent(SEARCH_CORPUS_LIMIT),
      () => roomVisibilityProvider(),
    ),
  );

  // When an events bundle is supplied, config reload reads the shared store.
  if (options.events) {
    const events = options.events;
    services.reloadConfig = async () => {
      config = {
        ...DEFAULT_INGESTION_CONFIG,
        ...options.config,
        ...(await loadIngestionConfig(events.configStore, (key, problem) =>
          log('ingestion.config.invalid', { key, problem }),
        )),
      };
      return config;
    };
  }

  return services;
}

// ---------------------------------------------------------------------------
// Router consumers (WS-E integration): the async halves of WS-F.
// ---------------------------------------------------------------------------

/**
 * Register the ingestion consumers on the events router:
 *
 *   `ingestion-pipeline`   (durable) — content.submitted → extraction,
 *     source resolution, dedup/syndication, claims, content.normalized.
 *   `ingestion-embeddings` (durable) — content.normalized → story + claim
 *     vectors; evidence.added → card vectors (WS-F.3.2c).
 *   `ingestion-signals`    (durable) — attention.aggregate (first_attention)
 *     + contribution/evidence events (material updates → freshness,
 *     sustained-participation heuristic) driving the lifecycle (WS-F.1.1c
 *     with WS-E as the available signal source; SCOI/evidence-gap triggers
 *     arrive with WS-H/WS-G through the same applyLifecycleTrigger seam).
 */
export function registerIngestionConsumers(
  events: EventPipelineServices,
  ingestion: IngestionServices,
): void {
  events.router.register({
    name: 'ingestion-pipeline',
    topics: ['content.submitted'],
    // WS-Q.1.7c — the extraction pipeline is a visibility-aware INTERNAL
    // consumer: it normalizes BOTH public and room_only content, so it holds
    // `restricted` access (non-scoring) to receive in-room submissions while
    // generic public/scoring consumers do not.
    accessClassifications: ['public', 'restricted'],
    scoring: false,
    durable: true,
    handle: async (event) => {
      await processSubmittedStory(ingestion, events, event as ContentSubmittedEvent);
    },
  });

  events.router.register({
    name: 'ingestion-embeddings',
    topics: ['content.normalized', 'evidence.added'],
    // WS-Q.1.7c — embeddings are computed for BOTH tiers (room-scoped search
    // similarity needs room_only vectors); the GLOBAL exclusion is the search
    // tier predicate, not the consumer. Holds `restricted` (non-scoring).
    accessClassifications: ['public', 'restricted'],
    scoring: false,
    durable: true,
    handle: async (event) => {
      if (event.event_type === 'content.normalized') {
        const normalized = event as ContentNormalizedEvent;
        const story = await ingestion.stories.getById(normalized.story_id);
        if (story) {
          await embedTarget(
            ingestion.embeddings,
            ingestion.embeddingProvider,
            'story',
            story.storyId,
            `${story.title} ${story.excerpt ?? ''}`,
          );
          ingestion.metrics.increment('embeddings.story');
        }
        for (const claimId of normalized.claim_ids) {
          const claim = await ingestion.claims.getById(claimId);
          if (claim) {
            await embedTarget(
              ingestion.embeddings,
              ingestion.embeddingProvider,
              'claim',
              claim.claimId,
              claim.canonicalText,
            );
            ingestion.metrics.increment('embeddings.claim');
          }
        }
      } else if (event.event_type === 'evidence.added') {
        const added = event as { evidence_id: string };
        const card = await ingestion.evidence.getById(added.evidence_id);
        if (card) {
          await embedTarget(
            ingestion.embeddings,
            ingestion.embeddingProvider,
            'evidence_card',
            card.evidenceId,
            `${card.relevanceNote} ${card.citationUrlOrRef}`,
          );
          ingestion.metrics.increment('embeddings.evidence');
        }
      }
    },
  });

  /** Rolling per-story contribution counter for the sustained-participation
   *  heuristic. In-memory + per-instance: restarts simply require fresh
   *  activity (graceful degradation documented in WS-F.1.1c — checkpoint
   *  replay re-drives missed events at boot). */
  const contributionCounts = new Map<string, { windowStartMs: number; count: number }>();

  events.router.register({
    name: 'ingestion-signals',
    topics: ['attention.aggregate', 'contribution.created', 'evidence.added'],
    accessClassifications: ['public', 'aggregated'],
    scoring: false,
    durable: true,
    handle: async (event) => {
      const config = ingestion.config();
      if (event.event_type === 'attention.aggregate') {
        const items = (event as { items: Array<{ story_id: string }> }).items;
        for (const item of items) {
          const result = await applyLifecycleTrigger(
            ingestion.stories,
            ingestion.lifecycleAudits,
            item.story_id,
            'first_attention',
            { actorType: 'system', actorUserId: null },
            ingestion.metrics,
          );
          if (result.applied) ingestion.metrics.increment('lifecycle.first_attention');
        }
        return;
      }
      // contribution.created carries a thread id; evidence.added too.
      const threadId = (event as { thread_id: string }).thread_id;
      const storyId = await ingestion.stories.getStoryIdByThreadId(threadId);
      if (storyId === null) return;
      const at = new Date(ingestion.now()).toISOString();
      await ingestion.stories.update(storyId, { lastMaterialUpdateAt: at });
      const updated = await ingestion.stories.getById(storyId);
      if (updated) {
        await recomputeFreshness(ingestion.stories, ingestion.freshness, updated, ingestion.now());
      }
      // Sustained participation (rolling 24h window).
      const nowMs = ingestion.now();
      const entry = contributionCounts.get(storyId);
      const fresh =
        entry === undefined || nowMs - entry.windowStartMs > 24 * 3_600_000
          ? { windowStartMs: nowMs, count: 0 }
          : entry;
      fresh.count += 1;
      contributionCounts.set(storyId, fresh);
      if (fresh.count >= config.lifecycleSustainedContributions) {
        // One activity threshold, three legal entries into `deepening`
        // depending on the CURRENT state (gathering_attention → sustained,
        // stable → renewed, archived → reactivation). The pure transition
        // function no-ops the inapplicable ones — first applied wins.
        for (const trigger of [
          'sustained_participation',
          'renewed_activity',
          'reactivation',
        ] as const) {
          const result = await applyLifecycleTrigger(
            ingestion.stories,
            ingestion.lifecycleAudits,
            storyId,
            trigger,
            { actorType: 'system', actorUserId: null },
            ingestion.metrics,
          );
          if (result.applied) break;
        }
      }
    },
  });
}

let _services: IngestionServices | undefined;

export function getIngestionServices(): IngestionServices {
  if (_services) return _services;
  if (process.env['NODE_ENV'] === 'test') {
    _services = createInMemoryIngestionServices();
    return _services;
  }
  throw new Error('Ingestion services not configured — call setIngestionServices() at startup');
}

export function setIngestionServices(services: IngestionServices): void {
  _services = services;
}
