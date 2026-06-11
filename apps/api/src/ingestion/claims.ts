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
 * Persist candidate claims with text-level dedup: when the same normalized
 * claim already exists on ANOTHER story, the new story gets its OWN candidate
 * row sharing that claim's `independence_group_id` (minted on first dedup) —
 * so the new story actually surfaces the claim (`listByStory`) while MERI still
 * sees the copies as one non-independent lineage (Section 13.6). Embedding-
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
      linked.push(
        await attachStoryToClaimLineage(claims, existing, story, candidate, extractor.modelVersion),
      );
      continue;
    }
    // Embedding-similarity dedup (soft): a near-duplicate claim of ANOTHER
    // story attaches this story to the same independence lineage.
    if (embeddingDedup !== undefined) {
      const match = await tryEmbeddingLink(claims, candidate.text, embeddingDedup);
      if (match !== null) {
        linked.push(
          await attachStoryToClaimLineage(
            claims,
            [match],
            story,
            candidate,
            extractor.modelVersion,
          ),
        );
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

/**
 * Attach `story` to an existing claim's MERI independence lineage (WS-F.1.2b
 * cross-story dedup). The same claim already exists on OTHER stories, so —
 * rather than dropping the association (the new story would surface no claim
 * for this text) or minting an independent row (MERI would double-count the
 * copies) — the new story gets its OWN candidate row sharing the existing
 * claim's `independence_group_id`. The group is minted on the first dedup and
 * back-filled onto the canonical match so later copies converge on it.
 *
 * Idempotent under at-least-once redelivery: a match set containing only THIS
 * story's prior rows (no foreign story) mints no group and returns the existing
 * row untouched.
 */
async function attachStoryToClaimLineage(
  claims: ClaimStore,
  matches: ClaimRecord[],
  story: { storyId: string },
  candidate: CandidateClaim,
  modelVersion: string,
): Promise<ClaimRecord> {
  const own = matches.find((c) => c.storyId === story.storyId);
  const canonical = matches.find((c) => c.storyId !== story.storyId);
  // No cross-story duplication — only our own prior row(s) on redelivery. Never
  // fabricate an independence group for a claim seen in a single story.
  if (canonical === undefined) return own ?? (matches[0] as ClaimRecord);

  const groupId =
    matches.find((c) => c.independenceGroupId !== null)?.independenceGroupId ?? randomUUID();
  if (canonical.independenceGroupId === null) {
    await claims.setIndependenceGroup(canonical.claimId, groupId);
  }
  if (own !== undefined) {
    if (own.independenceGroupId === null) await claims.setIndependenceGroup(own.claimId, groupId);
    return { ...own, independenceGroupId: groupId };
  }
  return await claims.insert({
    claimId: randomUUID(),
    storyId: story.storyId,
    canonicalText: canonical.canonicalText,
    normalizedTextHash: canonical.normalizedTextHash,
    claimStatus: 'candidate',
    firstSeenStoryId: canonical.firstSeenStoryId ?? canonical.storyId,
    independenceGroupId: groupId,
    createdBy: null,
    extractionSource: 'system',
    extractionConfidence: candidate.confidence,
    modelVersion,
  });
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
