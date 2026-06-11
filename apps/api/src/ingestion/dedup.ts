// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Near-duplicate + syndicated-copy detection (WS-F.1.3c/d, SPEC §14.2).
// Pipeline: signature the story's text (MinHash, @licio/invariants) → LSH
// band lookups retrieve candidates sub-linearly → the signature ESTIMATE
// against the configurable threshold makes the decision → source-aware
// classification: same-source ⇒ near-duplicate flag; different source with a
// CONFIRMED syndication relationship ⇒ auto-link (the copy's source joins
// the story's source list, no new MERI exposure); different source without
// one ⇒ syndication-candidate review flag. Detection NEVER auto-rejects —
// flag-for-review is the abuse posture (WS-F.1.3c security consideration),
// and auto-linking requires a steward-CONFIRMED edge (WS-F.2.4: an attacker
// must not attach spam to a reputable story via a self-asserted edge).
import {
  estimateJaccard,
  lshBandHashes,
  MINHASH_FAMILY_VERSION,
  MINHASH_NUM_HASHES,
  MINHASH_SHINGLE_K,
  minhashSignature,
} from '@licio/invariants';
import type { SignatureStore, StoryRecord, StoryStore, SyndicationStore } from './stores.js';

export interface NearDuplicateHit {
  storyId: string;
  estimatedJaccard: number;
}

/** Signature + persist a story's text; returns the stored signature parts. */
export async function signatureStory(
  signatures: SignatureStore,
  storyId: string,
  text: string,
  textSource: 'submitted' | 'extracted',
): Promise<{ signature: Uint32Array; bands: Uint32Array }> {
  const signature = minhashSignature(text);
  const bands = lshBandHashes(signature);
  await signatures.upsert(
    {
      storyId,
      minhash: signature,
      shingleK: MINHASH_SHINGLE_K,
      numHashes: MINHASH_NUM_HASHES,
      familyVersion: MINHASH_FAMILY_VERSION,
      textSource,
    },
    bands,
  );
  return { signature, bands };
}

/**
 * LSH candidates → estimate filter (WS-F.1.3c): sub-linear retrieval, then
 * the configurable Jaccard threshold decides. Only candidates signed with
 * the SAME family version are comparable (re-signature safety).
 */
export async function findNearDuplicates(
  signatures: SignatureStore,
  storyId: string,
  signature: Uint32Array,
  bands: Uint32Array,
  threshold: number,
  limit: number,
): Promise<NearDuplicateHit[]> {
  const candidates = await signatures.candidatesByBands(bands, storyId);
  const hits: NearDuplicateHit[] = [];
  for (const candidateId of candidates) {
    const candidate = await signatures.getByStoryId(candidateId);
    if (!candidate || candidate.familyVersion !== MINHASH_FAMILY_VERSION) continue;
    const estimate = estimateJaccard(signature, candidate.minhash);
    if (estimate >= threshold) hits.push({ storyId: candidateId, estimatedJaccard: estimate });
  }
  return hits.sort((a, b) => b.estimatedJaccard - a.estimatedJaccard).slice(0, limit);
}

export type DuplicateClassification =
  | { kind: 'near_duplicate'; existing: StoryRecord; estimate: number }
  | { kind: 'syndicated_known'; existing: StoryRecord; estimate: number; syndicationId: string }
  | { kind: 'syndicated_candidate'; existing: StoryRecord; estimate: number };

/**
 * Source-aware classification of one near-duplicate hit (WS-F.1.3d). The
 * original story is never replaced — classification only decides whether the
 * NEW copy auto-links (known CONFIRMED relationship) or routes to review.
 */
export async function classifyDuplicate(
  stories: StoryStore,
  syndications: SyndicationStore,
  newStory: StoryRecord,
  hit: NearDuplicateHit,
): Promise<DuplicateClassification | null> {
  const existing = await stories.getById(hit.storyId);
  if (!existing) return null;
  const sameSource =
    newStory.sourceId === null ||
    existing.sourceId === null ||
    newStory.sourceId === existing.sourceId;
  if (sameSource) {
    return { kind: 'near_duplicate', existing, estimate: hit.estimatedJaccard };
  }
  const relationship = await syndications.getBetween(
    newStory.sourceId as string,
    existing.sourceId as string,
  );
  if (relationship !== null && relationship.status === 'confirmed') {
    return {
      kind: 'syndicated_known',
      existing,
      estimate: hit.estimatedJaccard,
      syndicationId: relationship.syndicationId,
    };
  }
  return { kind: 'syndicated_candidate', existing, estimate: hit.estimatedJaccard };
}
