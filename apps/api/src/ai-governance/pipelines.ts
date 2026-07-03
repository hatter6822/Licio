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
import { UNCLASSIFIED_TOPIC_ID } from '@licio/shared';
import { HeuristicClaimExtractor } from '../ingestion/claims.js';
import type { StoryStore } from '../ingestion/stores.js';
import type { ProhibitedUseGuard } from './guard.js';
import type { AiGovernanceMetrics } from './metrics.js';
import { CLAIM_EXTRACTOR, classifyTopics, TOPIC_CLASSIFIER } from './models.js';
import { recordAiOutput } from './output-records.js';
import type { AiOutputRecordStore, AiReviewQueueStore } from './stores.js';

export interface PipelineDeps {
  stories: StoryStore;
  outputRecords: AiOutputRecordStore;
  reviewQueue: AiReviewQueueStore;
  guard: ProhibitedUseGuard;
  topicConfidenceThreshold: () => number;
  claimConfidenceFloor: () => number;
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
  const scores = classifyTopics(story.title, story.excerpt ?? '');
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
  const trusted = [...new Set([...validated, ...added])];
  const topicIds = trusted.length > 0 ? trusted : [UNCLASSIFIED_TOPIC_ID];
  const trustedSet = new Set(topicIds);
  await deps.stories.update(storyId, { topicIds });

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
