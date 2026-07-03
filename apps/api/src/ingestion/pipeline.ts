// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The §14.2 ingestion pipeline worker (WS-F.1.4e/f, 1.3c/d, 1.2b): a DURABLE
// WS-E router consumer for `content.submitted`. Per story, in order:
// robots-gated fetch (link stories) → metadata extraction → source
// resolution (idempotent upsert + primary link) → language + sensitivity
// classification → copyright-bounded excerpt → MinHash signature →
// near-duplicate / syndication classification (flag or auto-link, never
// auto-reject) → candidate claim extraction → freshness baseline →
// `content.normalized` emission.
//
// IDEMPOTENT under at-least-once delivery: a story whose extraction already
// completed is skipped, and the emitted `content.normalized` uses a
// DETERMINISTIC event id derived from the story id, so a redelivered
// `content.submitted` cannot double-emit (the event store's id uniqueness is
// the backstop). Extraction failure is NON-BLOCKING: the story stays
// readable, an `extraction_failure` review item with exponential `not_before`
// backoff schedules the retry, and `content.normalized` is emitted by the
// attempt that finally succeeds (or definitively degrades).
import { createHash } from 'node:crypto';
import {
  type ContentNormalizedEvent,
  type ContentSubmittedEvent,
  contentEventClassification,
  contentNormalizedEventSchema,
  isSentinelTopicId,
} from '@licio/shared';
import type { EventPipelineServices } from '../events/services.js';
import { type ClaimEmbeddingDedup, persistCandidateClaims } from './claims.js';
import { classifyDuplicate, findNearDuplicates, signatureStory } from './dedup.js';
import {
  boundedExcerpt,
  classifySensitivity,
  detectLanguage,
  extractMetadata,
} from './extraction.js';
import { recomputeFreshness } from './freshness.js';
import type { IngestionServices } from './services.js';
import type { StoryRecord } from './stores.js';

/** RFC 9562 UUIDv8 over SHA-256 — deterministic system-event ids (the WS-E
 *  pwatt/scoring.ts construction; same namespace discipline, own prefix). */
export function deterministicEventId(name: string): string {
  const digest = createHash('sha256').update(`ws-f:${name}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x80; // version 8
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // RFC variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Store + publish one system event (idempotent by event id; never throws —
 *  emission is observability around the primary state change). */
export async function emitIngestionEvent(
  events: EventPipelineServices,
  ingestion: IngestionServices,
  event: ContentSubmittedEvent | ContentNormalizedEvent,
  ownerUserId: string | null,
): Promise<void> {
  try {
    // WS-Q.1.7c — persist the EVENT's actual classification (restricted for a
    // room_only content event), not the topic's public base, so the storage
    // tier matches the content's visibility.
    const { inserted } = await events.eventStore.insertMany([
      {
        eventId: event.event_id,
        eventType: event.event_type,
        topic: event.event_type,
        timestamp: event.timestamp,
        privacyClassification: event.privacy_classification,
        retentionTier: event.retention_tier,
        payload: event as unknown as Record<string, unknown>,
        ownerUserId,
        purgeAfter: null,
      },
    ]);
    if (inserted === 0) return; // already emitted (idempotent re-run)
    await events.router.publish(event);
  } catch (error) {
    ingestion.log('ingestion.emit_failed', {
      event_type: event.event_type,
      detail: error instanceof Error ? error.message : 'unknown',
    });
  }
}

/** The locally-available BODY text of a submission (no title, no fetch) —
 *  the claim-extraction / language-detection / excerpt input. */
export function submissionBodyText(story: StoryRecord): string {
  const metadata = story.submissionMetadata;
  switch (metadata.submission_type) {
    case 'link':
      return metadata.reason;
    case 'original_brief':
      return metadata.body;
    case 'question':
      return `${metadata.question} ${metadata.context ?? ''}`.trim();
    case 'evidence_card':
      return metadata.relevance_note;
    case 'local_update':
      return metadata.source_or_experience_disclosure;
    case 'live_thread':
      return metadata.event_description;
    case 'image_post':
      // The accessible alt text is the only first-party text on an image post.
      return metadata.alt_text;
    case 'video_post':
      // Inline caption text when present (an uploaded track is not inlined here).
      return metadata.captions_text ?? '';
  }
}

/** Title + body — the near-duplicate signature / freshness / export text. */
export function submissionText(story: StoryRecord): string {
  return `${story.title} ${submissionBodyText(story)}`;
}

/**
 * The UPLOADED caption-track text of a video story (WS-K §24.1), or null when it
 * does not apply — a non-video, a video with inline `captions_text` (already in
 * `submissionBodyText`), no `captions_upload_id`, or an unreadable/empty track.
 * Read through the late-bound forum upload reader so the §14.2 pipeline can label
 * a caption-only video from its actual content.
 */
async function captionTextForStory(
  ingestion: IngestionServices,
  story: StoryRecord,
): Promise<string | null> {
  const meta = story.submissionMetadata;
  if (
    meta.submission_type !== 'video_post' ||
    meta.captions_upload_id === undefined ||
    meta.captions_text !== undefined
  ) {
    return null;
  }
  const text = await ingestion.readCaptionText(meta.captions_upload_id);
  return text !== null && text.trim().length > 0 ? text : null;
}

/**
 * Build a fetched-link excerpt that RESERVES body evidence (SPEC §24.1). The
 * description leads (best display text) but is capped at half the bound, so the
 * fetched body always gets the remainder — the deferred topic validator, whose
 * only view of a link is this excerpt, never loses the article text behind a
 * long/generic meta description or a small source cap. Falls back to
 * body-then-description when either is absent. Never exceeds `cap` (+1 joiner).
 */
export function excerptReservingBody(
  description: string | null,
  bodyText: string,
  cap: number,
): string | null {
  const body = bodyText.trim();
  const desc = description?.trim() ?? '';
  if (desc.length === 0 || desc === body) return boundedExcerpt(body, cap);
  if (body.length === 0) return boundedExcerpt(desc, cap);
  // Cap the description at half the bound so the body is guaranteed the rest.
  const descPart = boundedExcerpt(desc, Math.max(1, Math.floor(cap / 2)));
  const bodyBudget = cap - (descPart?.length ?? 0);
  const bodyPart = bodyBudget > 0 ? boundedExcerpt(body, bodyBudget) : null;
  return [descPart, bodyPart].filter((part): part is string => part !== null).join(' ') || null;
}

/** Exponential retry backoff for extraction failures (minutes): 5, 25, 125. */
function retryNotBefore(nowMs: number, attempt: number): string {
  const minutes = 5 ** Math.min(attempt, 3);
  return new Date(nowMs + minutes * 60_000).toISOString();
}

interface PipelineOutputs {
  sourceId: string | null;
  language: string;
  sensitivityLabels: string[];
  duplicateGroupId: string | null;
  claimIds: string[];
}

/** Emit content.normalized for a processed story (deterministic id). */
async function emitNormalized(
  ingestion: IngestionServices,
  events: EventPipelineServices,
  story: StoryRecord,
  outputs: PipelineOutputs,
): Promise<void> {
  const hasEmbedding = await ingestion.embeddings.get(
    'story',
    story.storyId,
    ingestion.embeddingProvider.modelVersion,
  );
  const event = contentNormalizedEventSchema.parse({
    event_id: deterministicEventId(`normalized:${story.storyId}`),
    event_type: 'content.normalized',
    timestamp: new Date(ingestion.now()).toISOString(),
    schema_version: '1',
    story_id: story.storyId,
    submitted_by: story.submittedBy,
    submission_type: story.submissionType,
    canonical_url: story.canonicalUrl,
    topic_ids: story.topicIds,
    // WS-Q.1.7c — carry room + visibility; the classification tracks visibility.
    room_id: story.roomId,
    visibility: story.visibility,
    source_id: outputs.sourceId,
    language: outputs.language,
    sensitivity_labels: outputs.sensitivityLabels,
    duplicate_group_id: outputs.duplicateGroupId,
    claim_ids: outputs.claimIds.slice(0, 100),
    embedding_ref: hasEmbedding
      ? `embeddings/story/${story.storyId}@${ingestion.embeddingProvider.modelVersion}`
      : null,
    privacy_classification: contentEventClassification(story.visibility),
    retention_tier: 'public_contribution',
  });
  await emitIngestionEvent(events, ingestion, event, story.submittedBy);
}

/** The claim embedding-dedup config for the live provider (WS-F.1.2b soft). */
function claimDedupOf(
  ingestion: IngestionServices,
  config: { claimDedupSimilarity: number },
): ClaimEmbeddingDedup {
  return {
    store: ingestion.embeddings,
    provider: ingestion.embeddingProvider,
    modelVersion: ingestion.embeddingProvider.modelVersion,
    threshold: config.claimDedupSimilarity,
  };
}

/**
 * Classify + normalize a LINK story we are NOT allowed to fetch (WS-F.1.4f):
 * robots forbids the target — either the submitted URL, or (after redirects)
 * the FINAL URL. There is no fetched document, but the LOCAL submission text
 * still drives sensitivity classification, candidate-claim extraction, and the
 * freshness baseline, exactly as the non-link path does. The story is marked
 * `disallowed_robots` (no excerpt — nothing was archived) and
 * `content.normalized` is emitted.
 */
async function emitLinkOnlyClassified(
  ingestion: IngestionServices,
  events: EventPipelineServices,
  story: StoryRecord,
  config: { claimConfidenceFloor: number; claimDedupSimilarity: number },
  metric: string,
): Promise<void> {
  const bodyText = submissionBodyText(story);
  const language = story.language ?? detectLanguage(null, bodyText);
  const classified = classifySensitivity(`${story.title} ${bodyText}`);
  const labels = [...new Set([...story.sensitivityLabels, ...classified])];
  const sensitivityLabels = labels.length > 1 ? labels.filter((l) => l !== 'none') : labels;
  const claims = await persistCandidateClaims(
    ingestion.claims,
    ingestion.reviewQueue,
    ingestion.claimExtractor,
    { storyId: story.storyId, title: story.title },
    bodyText,
    config.claimConfidenceFloor,
    claimDedupOf(ingestion, config),
  );
  const updated = await ingestion.stories.update(story.storyId, {
    language,
    sensitivityLabels: sensitivityLabels as StoryRecord['sensitivityLabels'],
    extractionState: 'disallowed_robots',
  });
  const current = updated ?? story;
  await recomputeFreshness(ingestion.stories, ingestion.freshness, current, ingestion.now());
  ingestion.metrics.increment(metric);
  await emitNormalized(ingestion, events, current, {
    sourceId: story.sourceId,
    language,
    sensitivityLabels,
    duplicateGroupId: null,
    claimIds: [...claims.created, ...claims.linked].map((c) => c.claimId),
  });
}

/**
 * Process one submitted story end to end (the §14.2 pipeline body). Used by
 * the `ingestion-pipeline` consumer AND the scheduler's retry path.
 */
export async function processSubmittedStory(
  ingestion: IngestionServices,
  events: EventPipelineServices,
  event: Pick<ContentSubmittedEvent, 'story_id'>,
  attempt = 0,
): Promise<void> {
  const config = ingestion.config();
  const story = await ingestion.stories.getById(event.story_id);
  if (!story) return; // story never landed (validation rolled back) — no-op
  if (story.extractionState !== 'pending') return; // idempotent redelivery

  // ----- Non-link types: no fetch; classify the local text. ---------------
  if (story.submissionType !== 'link') {
    // WS-K §24.1 — a video whose captions were UPLOADED (a WebVTT track) rather
    // than typed inline carries no inline text, so `submissionBodyText` is empty.
    // Read the caption track so sensitivity labeling, claim extraction, the
    // excerpt, and freshness all see the video's real content (not only the WS-K
    // topic validator, which reads it separately) — a caption-only crisis/health
    // video must not normalize label-free.
    const bodyText = (await captionTextForStory(ingestion, story)) ?? submissionBodyText(story);
    const language = story.language ?? detectLanguage(null, bodyText);
    const classified = classifySensitivity(`${story.title} ${bodyText}`);
    const labels = [...new Set([...story.sensitivityLabels, ...classified])];
    const sensitivityLabels = labels.length > 1 ? labels.filter((l) => l !== 'none') : labels;
    const claims = await persistCandidateClaims(
      ingestion.claims,
      ingestion.reviewQueue,
      ingestion.claimExtractor,
      { storyId: story.storyId, title: story.title },
      bodyText,
      config.claimConfidenceFloor,
      claimDedupOf(ingestion, config),
    );
    const updated = await ingestion.stories.update(story.storyId, {
      language,
      sensitivityLabels: sensitivityLabels as StoryRecord['sensitivityLabels'],
      extractionState: 'not_applicable',
      excerpt: boundedExcerpt(bodyText, config.excerptMaxChars),
    });
    if (updated)
      await recomputeFreshness(ingestion.stories, ingestion.freshness, updated, ingestion.now());
    ingestion.metrics.increment('pipeline.processed_non_link');
    await emitNormalized(ingestion, events, updated ?? story, {
      sourceId: null,
      language,
      sensitivityLabels,
      duplicateGroupId: null,
      claimIds: [...claims.created, ...claims.linked].map((c) => c.claimId),
    });
    return;
  }

  // ----- Link stories: robots gate → fetch → extract. ----------------------
  const url = new URL(story.canonicalUrl as string);
  const verdict = await ingestion.robots.check(
    url,
    config.crawlerUserAgent,
    config.robotsCacheTtlMinutes * 60_000,
  );

  if (!verdict.allowed && verdict.reason === 'disallowed') {
    // Link-only story (WS-F.1.4f): no fetch attempt, no fetched-text embedding
    // source; the LOCAL submission text still classifies, extracts candidate
    // claims, and feeds the freshness baseline (parity with the non-link path).
    await emitLinkOnlyClassified(ingestion, events, story, config, 'pipeline.robots_disallowed');
    return;
  }

  const deferSeconds =
    !verdict.allowed && verdict.reason === 'robots_unreachable'
      ? 300
      : verdict.allowed && verdict.crawlDelaySec !== null
        ? verdict.crawlDelaySec
        : null;
  if (deferSeconds !== null) {
    // robots unreachable (fail closed) or crawl-delay window: schedule retry.
    await ingestion.reviewQueue.insert({
      kind: 'extraction_failure',
      storyId: story.storyId,
      context: { reason: 'deferred', defer_seconds: deferSeconds, attempt },
      status: 'pending',
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
      notBefore: new Date(ingestion.now() + deferSeconds * 1_000).toISOString(),
    });
    ingestion.metrics.increment('pipeline.deferred');
    return;
  }

  const fetched = await ingestion.fetchDocument(story.canonicalUrl as string, {
    timeoutMs: config.fetchTimeoutMs,
    maxBytes: config.fetchMaxBytes,
    maxRedirects: config.fetchMaxRedirects,
    userAgent: config.crawlerUserAgent,
  });

  if (!fetched.ok || fetched.status >= 400) {
    await ingestion.stories.update(story.storyId, { extractionState: 'failed' });
    await ingestion.reviewQueue.insert({
      kind: 'extraction_failure',
      storyId: story.storyId,
      context: {
        reason: fetched.ok ? `http_${fetched.status}` : fetched.reason,
        attempt,
      },
      status: 'pending',
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
      notBefore: retryNotBefore(ingestion.now(), attempt),
    });
    ingestion.metrics.increment('pipeline.extraction_failed');
    return;
  }

  // Final-URL robots re-check (WS-F.1.4f): the initial gate consulted the
  // SUBMITTED path, but redirects can land on a path — or origin — the
  // publisher's robots policy forbids. If the post-redirect URL differs and is
  // disallowed (or its robots is unreachable ⇒ fail closed), discard the
  // fetched body and degrade to a link-only story; never extract or archive it.
  const finalUrl = new URL(fetched.finalUrl);
  if (finalUrl.href !== url.href) {
    const finalVerdict = await ingestion.robots.check(
      finalUrl,
      config.crawlerUserAgent,
      config.robotsCacheTtlMinutes * 60_000,
    );
    if (!finalVerdict.allowed) {
      await emitLinkOnlyClassified(
        ingestion,
        events,
        story,
        config,
        'pipeline.robots_disallowed_after_redirect',
      );
      return;
    }
  }

  const domain = url.hostname;
  const metadata = extractMetadata(fetched.body, domain);
  const bodyText = metadata.bodyText;
  const text = `${story.title} ${bodyText}`;
  const language = detectLanguage(story.language ?? metadata.language, bodyText);
  const classified = classifySensitivity(`${story.title} ${bodyText}`);
  const mergedLabels = [...new Set([...story.sensitivityLabels, ...classified])];
  const sensitivityLabels =
    mergedLabels.length > 1 ? mergedLabels.filter((l) => l !== 'none') : mergedLabels;

  // Source resolution (WS-F.2.2a): idempotent upsert + primary link + the
  // publisher's display restrictions (meta robots, WS-F.1.4f).
  const source = await ingestion.sources.upsertByDomain(domain, {
    name: metadata.publisher ?? domain,
  });
  // Topics here are still the pre-validation UNCLASSIFIED sentinel (the WS-K
  // classifier re-records the real topics after `content.normalized`); filter it
  // so the sentinel never pollutes the source's typical-topics observation.
  await ingestion.sources.recordObservation(source.sourceId, {
    topicIds: story.topicIds.filter((t) => !isSentinelTopicId(t)),
  });
  if (metadata.noindex || metadata.noarchive) {
    await ingestion.sources.update(source.sourceId, {
      displayRestrictions: {
        ...source.displayRestrictions,
        noindex: metadata.noindex,
        noarchive: metadata.noarchive,
      },
    });
  }
  await ingestion.stories.addSourceLink(story.storyId, source.sourceId, 'primary', null);

  // The excerpt is BOTH the display snippet AND the deferred WS-K topic
  // classifier's only view of the article (content.normalized carries no fetched
  // body — SPEC §24.1). Lead with the publisher's curated description (the best
  // display text) but RESERVE a share of the copyright bound for the fetched
  // body, so a long/generic description (or a small source excerpt cap) can't
  // crowd the article text out of the bound and leave a body-only topic
  // UNCLASSIFIED. Same total bound as before; noarchive still stores nothing.
  const excerpt = metadata.noarchive
    ? null // the publisher said do-not-archive: store NO body text at all
    : excerptReservingBody(
        metadata.description,
        bodyText,
        Math.min(config.excerptMaxChars, source.displayRestrictions.excerpt_max_chars ?? Infinity),
      );

  const updated = await ingestion.stories.update(story.storyId, {
    sourceId: source.sourceId,
    language,
    sensitivityLabels: sensitivityLabels as StoryRecord['sensitivityLabels'],
    excerpt,
    publisher: metadata.publisher,
    author: metadata.author,
    publishedAt: metadata.publishedAt,
    mediaType: metadata.mediaType,
    extractionState:
      metadata.author === null && metadata.publishedAt === null ? 'partial' : 'completed',
  });
  const current = updated ?? story;

  // Near-duplicate detection on the FETCHED text (WS-F.1.3c/d). WS-Q.2.2c — the
  // signature is stored for EVERY story (so a later widen joins the public
  // cluster without a recompute), but the public near-dup / syndication
  // clustering runs only for PUBLIC stories.
  let duplicateGroupId: string | null = null;
  const { signature, bands } = await signatureStory(
    ingestion.signatures,
    story.storyId,
    text,
    'extracted',
  );
  const hits =
    current.visibility === 'public'
      ? await findNearDuplicates(
          ingestion.signatures,
          ingestion.stories,
          story.storyId,
          signature,
          bands,
          config.nearDuplicateThreshold,
          5,
        )
      : [];
  for (const hit of hits) {
    const classification = await classifyDuplicate(
      ingestion.stories,
      ingestion.syndications,
      current,
      hit,
    );
    if (classification === null) continue;
    duplicateGroupId = classification.existing.storyId;
    if (classification.kind === 'syndicated_known') {
      // Known CONFIRMED partner: auto-link this copy's source onto the
      // EXISTING story's source list (no new MERI exposure; the original is
      // never replaced — WS-F.1.3d acceptance).
      await ingestion.stories.addSourceLink(
        classification.existing.storyId,
        source.sourceId,
        'syndicated',
        current.canonicalUrl,
      );
      ingestion.metrics.increment('dedup.syndicated_auto_linked');
    } else {
      await ingestion.reviewQueue.insert({
        kind: classification.kind === 'near_duplicate' ? 'near_duplicate' : 'syndication_candidate',
        storyId: story.storyId,
        context: {
          existing_story_id: classification.existing.storyId,
          estimated_jaccard: classification.estimate,
          new_source_id: source.sourceId,
          existing_source_id: classification.existing.sourceId,
        },
        status: 'pending',
        resolution: null,
        resolvedBy: null,
        resolvedAt: null,
        notBefore: null,
      });
      ingestion.metrics.increment(`dedup.flagged_${classification.kind}`);
    }
    break; // the strongest hit decides the grouping
  }

  // Candidate claims from the fetched text (WS-F.1.2b).
  const claims = await persistCandidateClaims(
    ingestion.claims,
    ingestion.reviewQueue,
    ingestion.claimExtractor,
    { storyId: story.storyId, title: story.title },
    bodyText,
    config.claimConfidenceFloor,
    claimDedupOf(ingestion, config),
  );

  await recomputeFreshness(ingestion.stories, ingestion.freshness, current, ingestion.now());
  ingestion.metrics.increment('pipeline.processed_link');
  await emitNormalized(ingestion, events, current, {
    sourceId: source.sourceId,
    language,
    sensitivityLabels,
    duplicateGroupId,
    claimIds: [...claims.created, ...claims.linked].map((c) => c.claimId),
  });
}

/** Scheduler hook: retry extraction failures whose backoff has elapsed. */
export async function retryDueExtractions(
  ingestion: IngestionServices,
  events: EventPipelineServices,
  batch: number,
): Promise<number> {
  const due = await ingestion.reviewQueue.listDueRetries(
    'extraction_failure',
    new Date(ingestion.now()).toISOString(),
    batch,
  );
  let retried = 0;
  for (const item of due) {
    if (item.storyId === null) continue;
    // Re-arm the story for processing, then run the pipeline body again.
    await ingestion.stories.update(item.storyId, { extractionState: 'pending' });
    const attempt = Number((item.context as { attempt?: number }).attempt ?? 0) + 1;
    await processSubmittedStory(ingestion, events, { story_id: item.storyId }, attempt);
    await ingestion.reviewQueue.resolve(
      item.reviewId,
      'retried',
      null,
      new Date(ingestion.now()).toISOString(),
    );
    retried += 1;
  }
  return retried;
}
