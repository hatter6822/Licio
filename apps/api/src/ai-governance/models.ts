// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The governed models (WS-K). Following the project's self-hosted/deterministic-
// provider philosophy (WS-F embeddings, the WS-F heuristic claim extractor), the
// VALUE of WS-K is the GOVERNANCE around the models, not ML inference: the models
// here are deterministic providers carrying full governance identity (name,
// version, prompt-template id, config — all logged into the AIOutputRecord). Real
// model backends are a seam that swaps in behind the same registry/evaluation/
// guard machinery without changing any governance code.
import { type AiModality, type AiUseCaseId, tokenize } from '@licio/ai-governance';

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
  config: { method: 'deterministic-keyword', taxonomy_version: 1 },
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

/** Every governed model identity, in registry order. */
export const GOVERNED_MODELS: readonly ModelIdentity[] = [
  TOPIC_CLASSIFIER,
  CLAIM_EXTRACTOR,
  THREAD_SUMMARIZER,
  CONTENT_TRANSLATOR,
  GOVERNANCE_SUMMARIZER,
];

// --- the deterministic topic classifier ------------------------------------

/** A small canonical topic keyword map (the WS-A taxonomy is the SSOT; this is a
 *  deterministic stand-in until a governed model backend lands). */
const TOPIC_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  climate: ['climate', 'carbon', 'emissions', 'warming', 'renewable', 'wildfire', 'drought'],
  policy: ['policy', 'law', 'bill', 'regulation', 'senate', 'congress', 'vote', 'election'],
  technology: ['ai', 'software', 'chip', 'computer', 'internet', 'app', 'algorithm', 'data'],
  health: ['health', 'disease', 'vaccine', 'hospital', 'medical', 'outbreak', 'mental'],
  economy: ['economy', 'inflation', 'jobs', 'market', 'trade', 'tax', 'growth', 'budget'],
  science: ['research', 'study', 'scientists', 'experiment', 'discovery', 'space', 'physics'],
  local: ['city', 'council', 'neighborhood', 'community', 'school', 'county', 'mayor'],
};

export interface TopicScore {
  topicId: string;
  confidence: number;
}

/**
 * Deterministic multi-label topic classifier: score each topic by the fraction
 * of its keyword set present in the text, lightly boosted by hit count. Total
 * and pure; identical inputs yield identical scores.
 */
export function classifyTopics(title: string, body: string): TopicScore[] {
  const tokens = new Set(tokenize(`${title} ${title} ${body}`)); // title weighted ×2
  const scores: TopicScore[] = [];
  for (const [topicId, keywords] of Object.entries(TOPIC_KEYWORDS)) {
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
