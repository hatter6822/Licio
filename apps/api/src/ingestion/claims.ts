// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Candidate claim extraction (WS-F.1.2b, SPEC §14.2 "generate a candidate
// claim list"). The EXTRACTOR is a seam: WS-K.1.3b owns the governed model;
// until it lands, the default is a conservative deterministic heuristic
// (declarative sentences with assertive shape), clearly versioned as such.
// Every persisted claim carries provenance (`extraction_source: system`,
// `model_version`, confidence) so a faulty extractor version's claims can be
// identified and re-run (WS-F.1.2b security consideration). No claim text is
// ever trusted as fact — everything lands as `candidate`, and sub-threshold
// confidence routes to the review queue rather than auto-accepting.
import { createHash, randomUUID } from 'node:crypto';
import type { EmbeddingProvider } from './embeddings.js';
import type { ClaimRecord, ClaimStore, EmbeddingStore, ReviewQueueStore } from './stores.js';

export interface CandidateClaim {
  text: string;
  confidence: number;
}

/**
 * Optional embedding-similarity dedup (WS-F.3.2c, soft dep): a candidate that
 * survives the exact-text check is embedded and, if a stored claim under the
 * active model version is at least `threshold` cosine-similar, LINKED rather
 * than created. Catches reorderings/rephrasings the text hash misses;
 * true semantic-paraphrase dedup needs the self-hosted model. Cross-story by
 * construction (a story's own claims are embedded only after its
 * `content.normalized`, so intra-story paraphrases fall to the text hash).
 */
export interface ClaimEmbeddingDedup {
  store: EmbeddingStore;
  provider: EmbeddingProvider;
  modelVersion: string;
  threshold: number;
}

/** The WS-K.1.3b seam: any governed extractor implements this. */
export interface ClaimExtractor {
  modelVersion: string;
  extract(title: string, bodyText: string): Promise<CandidateClaim[]>;
}

/** Normalized-text dedup key (casefold, collapse space, strip punctuation). */
export function normalizedClaimHash(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalized).digest('hex');
}

const ASSERTIVE_VERBS =
  /\b(is|are|was|were|has|have|had|will|would|fell|rose|passed|failed|announced|reported|confirmed|denied|increased|decreased|found|shows|showed|votes?|voted|approved|rejected|signed|banned|launched|killed|reached)\b/i;

/**
 * The default heuristic extractor: sentence-split the title + body, keep
 * declarative sentences (length-bounded, assertive verb, no question mark,
 * not first-person opinion), score confidence by simple structural features.
 * Deterministic and total; never throws on weird input.
 */
export class HeuristicClaimExtractor implements ClaimExtractor {
  readonly modelVersion = 'heuristic-claims-v1';

  async extract(title: string, bodyText: string): Promise<CandidateClaim[]> {
    const candidates: CandidateClaim[] = [];
    const seen = new Set<string>();
    const sentences = `${title}. ${bodyText}`
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 0);
    for (const sentence of sentences.slice(0, 200)) {
      if (sentence.endsWith('?')) continue; // questions are not claims
      if (/^(i|we)\b/i.test(sentence)) continue; // first-person experience
      if (/\b(maybe|perhaps|i think|in my opinion|allegedly)\b/i.test(sentence)) continue;
      const words = sentence.split(/\s+/);
      if (words.length < 5 || words.length > 40) continue;
      if (!ASSERTIVE_VERBS.test(sentence)) continue;
      const key = normalizedClaimHash(sentence);
      if (seen.has(key)) continue;
      seen.add(key);
      // Confidence: numbers and proper nouns raise it; hedging was filtered.
      let confidence = 0.5;
      if (/\d/.test(sentence)) confidence += 0.2;
      if (/\b[A-Z][a-z]+\b/.test(sentence.slice(1))) confidence += 0.1;
      if (words.length <= 25) confidence += 0.1;
      candidates.push({ text: sentence.slice(0, 1000), confidence: Math.min(0.9, confidence) });
      if (candidates.length >= 20) break;
    }
    return candidates;
  }
}

export interface PersistClaimsResult {
  /** Claims newly created for this story. */
  created: ClaimRecord[];
  /** Existing claims linked instead of duplicated (WS-F.1.2b dedup). */
  linked: ClaimRecord[];
}

/**
 * Persist candidate claims with text-level dedup: an existing claim with the
 * same normalized text is LINKED (returned, not duplicated) and joins the
 * new story's independence lineage exactly as the plan requires. Embedding-
 * similarity dedup arrives with populated embeddings (WS-F.3.2c, soft dep).
 */
export async function persistCandidateClaims(
  claims: ClaimStore,
  reviewQueue: ReviewQueueStore,
  extractor: ClaimExtractor,
  story: { storyId: string; title: string },
  bodyText: string,
  confidenceFloor: number,
  embeddingDedup?: ClaimEmbeddingDedup,
): Promise<PersistClaimsResult> {
  const candidates = await extractor.extract(story.title, bodyText);
  const created: ClaimRecord[] = [];
  const linked: ClaimRecord[] = [];
  for (const candidate of candidates) {
    const hash = normalizedClaimHash(candidate.text);
    const existing = await claims.findByNormalizedHash(hash);
    if (existing.length > 0) {
      linked.push(existing[0] as ClaimRecord);
      continue;
    }
    // Embedding-similarity dedup (soft): link to a near-duplicate existing
    // claim of another story instead of creating a redundant row.
    if (embeddingDedup !== undefined) {
      const linkedClaim = await tryEmbeddingLink(claims, candidate.text, embeddingDedup);
      if (linkedClaim !== null) {
        linked.push(linkedClaim);
        continue;
      }
    }
    const record = await claims.insert({
      claimId: randomUUID(),
      storyId: story.storyId,
      canonicalText: candidate.text,
      normalizedTextHash: hash,
      claimStatus: 'candidate',
      firstSeenStoryId: story.storyId,
      independenceGroupId: null,
      createdBy: null,
      extractionSource: 'system',
      extractionConfidence: candidate.confidence,
      modelVersion: extractor.modelVersion,
    });
    created.push(record);
    if (candidate.confidence < confidenceFloor) {
      // Sub-threshold ⇒ review queue (WS-K.1.3c seam), never auto-accepted.
      await reviewQueue.insert({
        kind: 'low_confidence_claim',
        storyId: story.storyId,
        context: {
          claim_id: record.claimId,
          confidence: candidate.confidence,
          model_version: extractor.modelVersion,
        },
        status: 'pending',
        resolution: null,
        resolvedBy: null,
        resolvedAt: null,
        notBefore: null,
      });
    }
  }
  return { created, linked };
}

/** Embed a candidate's text and return the nearest existing claim above the
 *  threshold, or null. Best-effort: an embedding error degrades to no-link
 *  (text dedup already ran), never failing the pipeline. */
async function tryEmbeddingLink(
  claims: ClaimStore,
  text: string,
  dedup: ClaimEmbeddingDedup,
): Promise<ClaimRecord | null> {
  try {
    const vector = await dedup.provider.embed(text);
    const hits = await dedup.store.findSimilarToVector(
      'claim',
      vector,
      dedup.modelVersion,
      dedup.threshold,
      1,
    );
    const best = hits[0];
    if (best === undefined) return null;
    return await claims.getById(best.targetId);
  } catch {
    return null;
  }
}
