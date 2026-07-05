// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The governed models (WS-K). Following the project's self-hosted/deterministic-
// provider philosophy (WS-F embeddings, the WS-F heuristic claim extractor), the
// VALUE of WS-K is the GOVERNANCE around the models, not ML inference: the models
// here are deterministic providers carrying full governance identity (name,
// version, prompt-template id, config — all logged into the AIOutputRecord). Real
// model backends are a seam that swaps in behind the same registry/evaluation/
// guard machinery without changing any governance code.
import {
  type AiModality,
  type AiUseCaseId,
  DEBATE_JUDGE_WEIGHTS_VERSION,
  tokenize,
} from '@licio/ai-governance';
import { TOPIC_KEYWORDS } from '@licio/shared';

/** The governance identity every governed model carries. */
export interface ModelIdentity {
  name: string;
  version: string;
  useCaseId: AiUseCaseId;
  modalities: AiModality[];
  promptTemplateId: string;
  /** The full configuration, hashed into AIOutputRecord.config_hash. */
  config: Record<string, unknown>;
}

export const TOPIC_CLASSIFIER: ModelIdentity = {
  name: 'topic-classifier',
  version: '1.0.0',
  useCaseId: 'topic_classification',
  modalities: ['classification'],
  promptTemplateId: 'topic-classifier/keyword-v1',
  // taxonomy_version 2: the label space moved from the old local slug set to the
  // shared catalog UUID/keyword map. Bumping it changes the AIOutputRecord config
  // hash, so governance/audit records stay attributable to the actual taxonomy.
  config: { method: 'deterministic-keyword', taxonomy_version: 2 },
};

export const CLAIM_EXTRACTOR: ModelIdentity = {
  name: 'claim-extractor',
  version: '1.0.0',
  useCaseId: 'claim_extraction',
  modalities: ['generation'],
  promptTemplateId: 'claim-extractor/heuristic-v1',
  config: { method: 'heuristic-assertive-sentence', granularity: 'sentence' },
};

export const THREAD_SUMMARIZER: ModelIdentity = {
  name: 'thread-summarizer',
  version: '1.0.0',
  useCaseId: 'summarization',
  modalities: ['generation'],
  promptTemplateId: 'thread-summarizer/structured-v1',
  config: { method: 'deterministic-structured', distinguish: 'fact_claim_interpretation' },
};

export const CONTENT_TRANSLATOR: ModelIdentity = {
  name: 'content-translator',
  version: '1.0.0',
  useCaseId: 'translation',
  modalities: ['generation'],
  promptTemplateId: 'content-translator/passthrough-v1',
  config: { method: 'deterministic-passthrough' },
};

export const GOVERNANCE_SUMMARIZER: ModelIdentity = {
  name: 'governance-summarizer',
  version: '1.0.0',
  useCaseId: 'governance_assistance',
  modalities: ['generation'],
  promptTemplateId: 'governance-summarizer/structured-v1',
  config: { method: 'deterministic-field-citation' },
};

/**
 * The WS-T debate adjudicator — a probabilistic neural model (an MLP + softmax
 * over content-structural features; @licio/ai-governance debate-judge).  A
 * CLASSIFICATION model (argmax over {incumbent, challenger, inconclusive}).  The
 * weights version is folded into `config`, so the AIOutputRecord config hash
 * pins the exact decision surface each verdict was rendered by.
 */
export const DEBATE_ADJUDICATOR: ModelIdentity = {
  name: 'debate-adjudicator',
  version: '1.0.0',
  useCaseId: 'debate_adjudication',
  modalities: ['classification'],
  promptTemplateId: 'debate-adjudicator/mlp-v1',
  config: { method: 'neural-mlp-softmax', weights_version: DEBATE_JUDGE_WEIGHTS_VERSION },
};

/** Every governed model identity, in registry order. */
export const GOVERNED_MODELS: readonly ModelIdentity[] = [
  TOPIC_CLASSIFIER,
  CLAIM_EXTRACTOR,
  THREAD_SUMMARIZER,
  CONTENT_TRANSLATOR,
  GOVERNANCE_SUMMARIZER,
  DEBATE_ADJUDICATOR,
];

// --- the deterministic topic classifier / validator ------------------------

export interface TopicScore {
  /** A canonical catalog topic id (`@licio/shared` TOPICS). */
  topicId: string;
  confidence: number;
}

/**
 * Deterministic multi-label topic classifier: score each CATALOG topic by the
 * fraction of its keyword set present in the text, lightly boosted by hit
 * count. Total and pure; identical inputs yield identical scores. The keyword
 * evidence is sourced from the shared catalog (`TOPIC_KEYWORDS`) so the catalog
 * is the single source of truth; a governed model backend swaps in here without
 * changing consumers. Output ids are catalog UUIDs, never slugs — the classifier
 * is the AI VALIDATOR that turns author proposals into trusted `topic_ids`
 * (WS-K §24.1, `classifyStoryTopics`).
 */
export function classifyTopics(title: string, body: string): TopicScore[] {
  const tokens = new Set(tokenize(`${title} ${title} ${body}`)); // title weighted ×2
  const scores: TopicScore[] = [];
  for (const [topicId, keywords] of TOPIC_KEYWORDS) {
    if (keywords.length === 0) continue; // the sentinel carries no keywords
    let hits = 0;
    for (const keyword of keywords) if (tokens.has(keyword)) hits += 1;
    if (hits === 0) continue;
    // Confidence: saturating function of hit fraction (bounded in (0, 1)).
    const fraction = hits / keywords.length;
    const confidence = Math.min(0.99, 0.4 + fraction * 1.5);
    scores.push({ topicId, confidence });
  }
  return scores.sort((a, b) => b.confidence - a.confidence || a.topicId.localeCompare(b.topicId));
}

// --- the translation provider seam -----------------------------------------

export interface TranslationProvider {
  /** Translate `text` from `source` to `target`. The default is a deterministic
   *  pass-through (adds no content, so the consistency check passes); a real
   *  backend swaps in behind the same governance machinery. */
  translate(text: string, source: string, target: string): Promise<string>;
}

export class PassthroughTranslationProvider implements TranslationProvider {
  async translate(text: string, _source: string, _target: string): Promise<string> {
    // A pass-through never INTRODUCES content absent from the source (the
    // §24.2 consistency guarantee); a production backend produces real target
    // text and is held to the same consistency check (WS-K.2.1a).
    return text;
  }
}
