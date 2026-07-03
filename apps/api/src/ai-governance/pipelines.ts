// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AI content pipelines (WS-K.1.3a/b, SPEC §24.1). Topic classification assigns
// multi-label topics with confidence — above-threshold labels are applied (and
// merged into the story's topics for WS-I retrieval), sub-threshold labels are
// SUGGESTED to the steward review queue, never auto-applied. Claim extraction
// produces discrete AI-draft propositions linked to their source passage. Both
// run the prohibited-use guard, carry the persistent provenance label, and write
// an AIOutputRecord for audit. The classifier/extractor are deterministic
// governed providers (the WS-F heuristic seam), held to the same governance.
import {
  type ClaimExtractionResult,
  claimExtractionResultSchema,
  type TopicClassificationResult,
  topicClassificationResultSchema,
} from '@licio/ai-governance';
import { isSelectableTopicId, isSentinelTopicId, UNCLASSIFIED_TOPIC_ID } from '@licio/shared';
import { HeuristicClaimExtractor } from '../ingestion/claims.js';
import { recomputeFreshness } from '../ingestion/freshness.js';
import { submissionBodyText } from '../ingestion/pipeline.js';
import type { FreshnessStore, SourceStore, StoryRecord, StoryStore } from '../ingestion/stores.js';
import type { ProhibitedUseGuard } from './guard.js';
import type { AiGovernanceMetrics } from './metrics.js';
import { CLAIM_EXTRACTOR, classifyTopics, TOPIC_CLASSIFIER } from './models.js';
import { recordAiOutput } from './output-records.js';
import type { AiOutputRecordStore, AiReviewQueueStore } from './stores.js';

export interface PipelineDeps {
  stories: StoryStore;
  sources: SourceStore;
  freshness: FreshnessStore;
  outputRecords: AiOutputRecordStore;
  reviewQueue: AiReviewQueueStore;
  guard: ProhibitedUseGuard;
  topicConfidenceThreshold: () => number;
  claimConfidenceFloor: () => number;
  /**
   * Read the plain caption TEXT of an uploaded WebVTT track (WS-K §24.1). A
   * video post's captions are the only first-party text describing it, but they
   * live in an upload `submissionBodyText` cannot read — so without this the
   * classifier would leave a caption-evidenced topic UNCLASSIFIED. Optional: the
   * composition root wires it to the forum upload store; when absent the
   * classifier simply falls back to the title (no regression).
   */
  readCaptionText?: (uploadId: string) => Promise<string | null>;
  metrics: AiGovernanceMetrics;
  log: (event: string, meta: Record<string, unknown>) => void;
  now: () => number;
}

/**
 * VALIDATE a story's topics (WS-K.1.3a, SPEC §24.1) — the trust gate for topics.
 *
 * The author's picks arrive as UNTRUSTED `proposed_topic_ids`; this pass (the
 * deterministic classifier over the story's ACTUAL content) decides which
 * become the story's TRUSTED `topic_ids`:
 *   • a proposed topic is VALIDATED (→ trusted) iff the content supports it
 *     (confidence ≥ threshold); otherwise it is REJECTED (routed to steward
 *     review, never trusted);
 *   • the classifier's own above-threshold detections the author did NOT
 *     propose are ADDED (augmentation);
 *   • if nothing validates, the story carries the UNCLASSIFIED sentinel, which
 *     every topic-similarity / PHI-loop consumer EXCLUDES — so an unclassified
 *     story never looks like a shared topic.
 * Sub-threshold detections stay SUGGESTIONS. Runs the prohibited-use guard and
 * writes an AIOutputRecord for audit.
 */
/**
 * The uploaded-caption text of a video story ('' when none): only a `video_post`
 * with a `captions_upload_id` (and no inline `captions_text`, which the caller
 * already reads via `submissionBodyText`) has one, and only when the reader seam
 * is wired. Best-effort — a read failure yields '' (never blocks classification).
 */
async function readVideoCaptionText(
  deps: PipelineDeps,
  story: { submissionMetadata: StoryRecord['submissionMetadata'] },
): Promise<string> {
  const meta = story.submissionMetadata;
  if (
    meta.submission_type !== 'video_post' ||
    meta.captions_upload_id === undefined ||
    meta.captions_text !== undefined ||
    deps.readCaptionText === undefined
  ) {
    return '';
  }
  try {
    return (await deps.readCaptionText(meta.captions_upload_id)) ?? '';
  } catch {
    deps.metrics.increment('ai.topic.classification.caption_read_skipped');
    return '';
  }
}

export async function classifyStoryTopics(
  deps: PipelineDeps,
  storyId: string,
): Promise<TopicClassificationResult | null> {
  const story = await deps.stories.getById(storyId);
  if (story === null) return null;
  // Run the guard for the audit trail (classification is permitted, and never
  // reads financial/wealth data — the structural flags are all safe).
  await deps.guard.enforce({
    use_case_id: 'topic_classification',
    capability: 'classify_topic',
    caller: 'topic-classification-pipeline',
    context_ref: storyId,
    effect: 'advisory',
    uses_wealth_signals: false,
    targets_risk_identity: false,
  });

  const threshold = deps.topicConfidenceThreshold();
  // Classify over the richest first-party text: the excerpt AND the full local
  // submission text, unioned (SPEC §24.1). Each covers a case the other misses:
  //   • the excerpt carries text the body helper does not — a fetched LINK's
  //     article body (folded in by the §14.2 pipeline) and a video's uploaded
  //     caption track;
  //   • `submissionBodyText` carries the FULL first-party body, which for a long
  //     original brief / question / local update can exceed the 500-char excerpt
  //     cutoff, and for a robots-disallowed link is the only local text.
  // The classifier tokenizes into a Set, so the overlap (the excerpt is often a
  // prefix of the body) is harmless — this only ever ADDS evidence.
  //
  // A video post whose captions were UPLOADED (a WebVTT track) rather than typed
  // inline carries no local text at all above — read the full caption text so a
  // topic evidenced only in the captions still validates (parity with inline
  // `captions_text`, which `submissionBodyText` already returns).
  const captionText = await readVideoCaptionText(deps, story);
  const classifyText = [story.excerpt ?? '', submissionBodyText(story), captionText]
    .filter((text) => text.length > 0)
    .join(' ');
  const scores = classifyTopics(story.title, classifyText);
  const confidenceById = new Map(scores.map((s) => [s.topicId, s.confidence]));
  const nowIso = new Date(deps.now()).toISOString();
  const output = await recordAiOutput(deps.outputRecords, {
    modelName: TOPIC_CLASSIFIER.name,
    modelVersion: TOPIC_CLASSIFIER.version,
    promptTemplateId: TOPIC_CLASSIFIER.promptTemplateId,
    config: TOPIC_CLASSIFIER.config,
    inputRefs: [storyId],
    outputRef: storyId,
    useCaseId: 'topic_classification',
    nowIso,
  });

  // The AUTHOR'S proposals are untrusted input; a proposal is validated only
  // when the content supports it. AI-detected topics the author did not propose
  // are added (augmentation). The trusted set is validated ∪ added; the
  // UNCLASSIFIED sentinel stands in when nothing validates (never author picks
  // untrusted — an unvalidated topic never reaches `topic_ids`).
  const proposed = story.proposedTopicIds;
  const proposedSet = new Set(proposed);
  const supported = (id: string): boolean => (confidenceById.get(id) ?? 0) >= threshold;
  const validated = proposed.filter(supported);
  const rejected = proposed.filter((id) => !supported(id));
  const added = scores
    .filter((s) => s.confidence >= threshold && !proposedSet.has(s.topicId))
    .map((s) => s.topicId);
  // When there are NO author proposals to validate — a pre-migration-0052 legacy
  // row (`proposed_topic_ids = []` but existing `topic_ids`), or a
  // content.normalized re-run/backfill — PRESERVE only the story's existing
  // CATALOG topics (never the sentinel, and never a pre-catalog `randomUUID()`
  // placeholder the old composer stored), so a random legacy id can't survive
  // into ranking / feed / PHI; only ever augment. With proposals present, the
  // trusted base is exactly the validated subset.
  const baseTrusted =
    proposed.length === 0 ? story.topicIds.filter(isSelectableTopicId) : validated;
  const trusted = [...new Set([...baseTrusted, ...added])];
  const topicIds = trusted.length > 0 ? trusted : [UNCLASSIFIED_TOPIC_ID];
  const trustedSet = new Set(topicIds);
  const updated = await deps.stories.update(storyId, { topicIds });
  // The §14.2 pipeline computed the topic-dependent derivations — the source's
  // typical-topics observation and the freshness baseline — with the pre-
  // validation UNCLASSIFIED sentinel. Now that the trusted topics are known,
  // refresh both so a validated story's source profile and freshness never lag
  // its real topics (SPEC §24.1). An unclassified story (no real topics) leaves
  // the source observation untouched — the sentinel is never recorded.
  if (updated !== null) {
    const realTopics = topicIds.filter((id) => !isSentinelTopicId(id));
    if (updated.sourceId !== null && realTopics.length > 0) {
      await deps.sources.recordObservation(updated.sourceId, { topicIds: realTopics });
    }
    await recomputeFreshness(deps.stories, deps.freshness, updated, deps.now());
  }

  // Audit trail: one assignment per topic CONSIDERED (proposed ∪ detected);
  // `applied` = it entered the trusted set.
  const consideredIds = [...new Set([...proposed, ...scores.map((s) => s.topicId)])];
  const assignments = consideredIds.map((topicId) => ({
    topic_id: topicId,
    confidence: confidenceById.get(topicId) ?? 0,
    applied: trustedSet.has(topicId),
    label: 'AI-classified' as const,
  }));

  // Rejected author proposals + sub-threshold detections → steward review
  // (never auto-applied). A rejected proposal is flagged so a steward sees the
  // author asked for a topic the content did not support.
  for (const topicId of consideredIds) {
    if (trustedSet.has(topicId)) continue;
    await deps.reviewQueue.insert({
      kind: 'low_confidence_classification',
      subjectRef: storyId,
      context: {
        topic_id: topicId,
        confidence: confidenceById.get(topicId) ?? 0,
        output_id: output.output_id,
        rejected_author_proposal: proposedSet.has(topicId),
      },
      status: 'pending',
      resolution: null,
      resolvedBy: null,
    });
  }

  const unclassified = trusted.length === 0;
  deps.metrics.increment('ai.topic.classification.completed');
  if (unclassified) deps.metrics.increment('ai.topic.classification.unclassified');
  deps.metrics.increment('ai.topic.classification.rejected_proposals', rejected.length);
  deps.log('topic.classification.completed', {
    story_id: storyId,
    proposed: proposed.length,
    validated: validated.length,
    added: added.length,
    rejected: rejected.length,
    unclassified,
  });

  return topicClassificationResultSchema.parse({
    story_id: storyId,
    assignments,
    threshold,
    model_name: TOPIC_CLASSIFIER.name,
    model_version: TOPIC_CLASSIFIER.version,
    output_id: output.output_id,
    classified_at: nowIso,
  } satisfies TopicClassificationResult);
}

const extractor = new HeuristicClaimExtractor();

/** Extract AI-draft claims from a story (WS-K.1.3b). Each claim links its source
 *  passage and carries the AI-draft label; an AIOutputRecord is written. */
export async function extractStoryClaims(
  deps: PipelineDeps,
  storyId: string,
  bodyText: string,
): Promise<ClaimExtractionResult | null> {
  const story = await deps.stories.getById(storyId);
  if (story === null) return null;
  await deps.guard.enforce({
    use_case_id: 'claim_extraction',
    capability: 'extract_claim',
    caller: 'claim-extraction-pipeline',
    context_ref: storyId,
    effect: 'advisory',
    uses_wealth_signals: false,
    targets_risk_identity: false,
  });

  const nowIso = new Date(deps.now()).toISOString();
  const candidates = await extractor.extract(story.title, bodyText);
  const output = await recordAiOutput(deps.outputRecords, {
    modelName: CLAIM_EXTRACTOR.name,
    modelVersion: CLAIM_EXTRACTOR.version,
    promptTemplateId: CLAIM_EXTRACTOR.promptTemplateId,
    config: CLAIM_EXTRACTOR.config,
    inputRefs: [storyId],
    outputRef: storyId,
    useCaseId: 'claim_extraction',
    nowIso,
  });

  const floor = deps.claimConfidenceFloor();
  const claims = candidates.map((c) => ({
    claim_text: c.text.slice(0, 1000),
    confidence: c.confidence,
    // Link the source passage (the candidate text is the passage it derives
    // from in the deterministic extractor); a backend would carry an offset.
    source_passage: c.text.slice(0, 2000),
    label: 'AI-draft' as const,
  }));

  // Sub-threshold claims route to review (never auto-accepted as fact).
  for (const claim of claims) {
    if (claim.confidence >= floor) continue;
    await deps.reviewQueue.insert({
      kind: 'low_confidence_classification',
      subjectRef: storyId,
      context: {
        claim_text: claim.claim_text,
        confidence: claim.confidence,
        output_id: output.output_id,
      },
      status: 'pending',
      resolution: null,
      resolvedBy: null,
    });
  }

  deps.metrics.increment('ai.claim.extraction.completed');
  deps.metrics.gauge('ai.claim.extraction.claims_per_story', claims.length);
  deps.log('claim.extraction.completed', { story_id: storyId, claims: claims.length });

  return claimExtractionResultSchema.parse({
    story_id: storyId,
    claims,
    model_name: CLAIM_EXTRACTOR.name,
    model_version: CLAIM_EXTRACTOR.version,
    output_id: output.output_id,
    extracted_at: nowIso,
  } satisfies ClaimExtractionResult);
}
