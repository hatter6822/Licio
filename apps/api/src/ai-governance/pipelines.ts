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

/** Classify a story's topics (WS-K.1.3a). Above-threshold labels are applied
 *  and merged into the story; sub-threshold labels route to review. */
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

  const assignments = scores.map((s) => ({
    topic_id: s.topicId,
    confidence: s.confidence,
    applied: s.confidence >= threshold,
    label: 'AI-classified' as const,
  }));

  // Apply above-threshold topics (union with the story's existing topics, so a
  // governed assignment never clobbers a user/steward topic).
  const applied = assignments.filter((a) => a.applied).map((a) => a.topic_id);
  if (applied.length > 0) {
    const merged = [...new Set([...story.topicIds, ...applied])];
    await deps.stories.update(storyId, { topicIds: merged });
  }
  // Sub-threshold suggestions → steward review queue (never auto-applied).
  for (const assignment of assignments) {
    if (assignment.applied) continue;
    await deps.reviewQueue.insert({
      kind: 'low_confidence_classification',
      subjectRef: storyId,
      context: {
        topic_id: assignment.topic_id,
        confidence: assignment.confidence,
        output_id: output.output_id,
      },
      status: 'pending',
      resolution: null,
      resolvedBy: null,
    });
  }

  deps.metrics.increment('ai.topic.classification.completed');
  deps.metrics.increment(
    'ai.topic.classification.suggestions',
    assignments.length - applied.length,
  );
  deps.log('topic.classification.completed', {
    story_id: storyId,
    applied: applied.length,
    suggested: assignments.length - applied.length,
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
