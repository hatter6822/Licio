// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K wiring: build each pipeline's dependency bundle from the service container
// (so routes, the WS-E consumer, and the scheduler share one construction), and
// register the durable WS-E consumer that classifies + extracts during ingestion
// (WS-K.1.3a/b "runs during story ingestion"). The cross-workstream seams
// (ingestion/forum) are injected at boot; a builder throws if a required seam is
// absent so a misconfiguration fails loudly rather than silently no-op'ing.
import type { ContentNormalizedEvent } from '@licio/shared';
import type { EventPipelineServices } from '../events/services.js';
import type { CorrectionDeps } from './correction.js';
import type { GovernanceAiDeps } from './governance-ai.js';
import type { HarnessDeps } from './harness.js';
import type { LineageDeps } from './lineage.js';
import { classifyStoryTopics, extractStoryClaims, type PipelineDeps } from './pipelines.js';
import type { RegistryDeps } from './registry.js';
import type { RuntimeMonitorDeps } from './runtime-monitor.js';
import type { AiGovernanceServices } from './services.js';
import type { SummaryPipelineDeps } from './summaries.js';
import type { TranslationDeps } from './translation.js';

function requireIngestion(
  ai: AiGovernanceServices,
): NonNullable<AiGovernanceServices['ingestion']> {
  if (ai.ingestion === null) throw new Error('AI-governance: ingestion seam not wired');
  return ai.ingestion;
}
function requireForum(ai: AiGovernanceServices): NonNullable<AiGovernanceServices['forum']> {
  if (ai.forum === null) throw new Error('AI-governance: forum seam not wired');
  return ai.forum;
}

export function buildRegistryDeps(ai: AiGovernanceServices): RegistryDeps {
  return {
    registry: ai.registry,
    riskAssessments: ai.riskAssessments,
    lineage: ai.lineage,
    evaluations: ai.evaluations,
    metrics: ai.metrics,
    log: ai.log,
    now: ai.now,
  };
}

export function buildHarnessDeps(ai: AiGovernanceServices): HarnessDeps {
  return {
    evaluations: ai.evaluations,
    config: ai.config,
    metrics: ai.metrics,
    log: ai.log,
    now: ai.now,
  };
}

export function buildLineageDeps(ai: AiGovernanceServices): LineageDeps {
  return { lineage: ai.lineage, metrics: ai.metrics, log: ai.log };
}

export function buildPipelineDeps(ai: AiGovernanceServices): PipelineDeps {
  return {
    stories: requireIngestion(ai).stories,
    sources: requireIngestion(ai).sources,
    freshness: requireIngestion(ai).freshness,
    outputRecords: ai.outputRecords,
    reviewQueue: ai.reviewQueue,
    guard: ai.guard,
    topicConfidenceThreshold: () => ai.config().topicConfidenceThreshold,
    claimConfidenceFloor: () => ai.config().claimConfidenceFloor,
    metrics: ai.metrics,
    log: ai.log,
    now: ai.now,
  };
}

export function buildSummaryDeps(ai: AiGovernanceServices): SummaryPipelineDeps {
  return {
    contributions: requireForum(ai).contributions,
    forumSummaries: requireForum(ai).summaries,
    stories: requireIngestion(ai).stories,
    aiSummaries: ai.summaries,
    outputRecords: ai.outputRecords,
    reviewQueue: ai.reviewQueue,
    guard: ai.guard,
    minActivity: () => ai.config().summaryMinActivity,
    metrics: ai.metrics,
    log: ai.log,
    now: ai.now,
  };
}

export function buildTranslationDeps(ai: AiGovernanceServices): TranslationDeps {
  return {
    translations: ai.translations,
    provider: ai.translationProvider,
    outputRecords: ai.outputRecords,
    reviewQueue: ai.reviewQueue,
    guard: ai.guard,
    metrics: ai.metrics,
    log: ai.log,
    now: ai.now,
  };
}

export function buildCorrectionDeps(ai: AiGovernanceServices): CorrectionDeps {
  return {
    corrections: ai.corrections,
    outputRecords: ai.outputRecords,
    metrics: ai.metrics,
    log: ai.log,
    now: ai.now,
  };
}

export function buildGovernanceAiDeps(ai: AiGovernanceServices): GovernanceAiDeps {
  return {
    governanceSummaries: ai.governanceSummaries,
    outputRecords: ai.outputRecords,
    guard: ai.guard,
    metrics: ai.metrics,
    log: ai.log,
    now: ai.now,
  };
}

export function buildRuntimeMonitorDeps(ai: AiGovernanceServices): RuntimeMonitorDeps {
  return {
    registry: ai.registry,
    outputRecords: ai.outputRecords,
    summaries: ai.summaries,
    runtime: ai.runtime,
    config: ai.config,
    metrics: ai.metrics,
    log: ai.log,
    now: ai.now,
  };
}

/**
 * Register the durable WS-E consumer that classifies + extracts during
 * ingestion (WS-K.1.3a/b). Reads `public` + `restricted` content (room_only
 * stories are server-hosted and in scope, §24 server-hosted boundary); never a
 * scoring consumer (it produces governance metadata, not ranking signal).
 */
export function registerAiGovernanceConsumers(
  events: EventPipelineServices,
  ai: AiGovernanceServices,
): void {
  events.router.register({
    name: 'ai-governance-classification',
    topics: ['content.normalized'],
    accessClassifications: ['public', 'restricted'],
    scoring: false,
    durable: true,
    handle: async (event) => {
      if (ai.ingestion === null) return; // seam not wired ⇒ recorded no-op
      const normalized = event as ContentNormalizedEvent;
      const storyId = normalized.story_id;
      const deps = buildPipelineDeps(ai);
      const story = await ai.ingestion.stories.getById(storyId);
      if (story === null) return;
      await classifyStoryTopics(deps, storyId);
      // Extraction over the available body text (excerpt; a backend carries the
      // full normalized text). Best-effort — a failure never blocks ingestion.
      const body = story.excerpt ?? story.title;
      try {
        await extractStoryClaims(deps, storyId, body);
      } catch {
        ai.metrics.increment('ai.claim.extraction.skipped');
      }
    },
  });
}
