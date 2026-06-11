// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Embedding providers + model registry + generation/backfill (WS-F.3.2a/c/f,
// SPEC §21.4/§19.1). Two providers behind one interface:
//
//   • `HttpEmbeddingProvider` — the PRODUCTION binding: a SELF-HOSTED
//     embedding service (TEI/ONNX server running e.g. all-MiniLM-L6-v2)
//     reached over plain fetch. §19.1 requires that content text never leak
//     to a third party, so the endpoint is operator-deployed; the all-or-none
//     EMBEDDING_* env group configures it.
//   • `DeterministicLexicalProvider` — the dev/CI default and graceful
//     fallback: a seeded random-projection of hashed character n-grams
//     (feature hashing). It is a real LEXICAL-similarity embedding —
//     cosine-correlated with n-gram overlap, deterministic across machines —
//     and is honestly labeled NOT SEMANTIC: MERI/SCOI semantic conclusions
//     require the self-hosted model (registry `known_limitations`), and
//     production boot WARNS when running on it.
//
// The registry entry (WS-F.3.2a) lives here until the WS-K.1.1b model
// registry lands (documented seam); the dimension is pinned to the
// `embeddings` table's vector(384).
import { EMBEDDING_DIMENSION } from '@licio/db';
import { fnv1a32 } from '@licio/invariants';
import type { PwattConfigStore } from '../events/stores.js';
import type { EmbeddingStore, EmbeddingTargetType } from './stores.js';

export interface EmbeddingProvider {
  modelName: string;
  modelVersion: string;
  dimension: number;
  embed(text: string): Promise<Float32Array>;
}

/** WS-K.1.1b registry-entry shape (kept here until WS-K owns the registry). */
export interface EmbeddingModelRegistryEntry {
  model_name: string;
  model_version: string;
  provider: string;
  dimension: number;
  input_token_limit: number;
  license: string;
  evaluation: string;
  known_limitations: string;
}

export const EMBEDDING_MODEL_REGISTRY: readonly EmbeddingModelRegistryEntry[] = [
  {
    model_name: 'licio-lexical-fnv',
    model_version: 'lexical-fnv-v1',
    provider: 'in-process (deterministic feature hashing)',
    dimension: EMBEDDING_DIMENSION,
    input_token_limit: 8_192,
    license: 'AGPL-3.0-or-later (first-party)',
    evaluation:
      'Exact-duplicate cosine = 1.0 by construction; lexical-overlap monotonicity property-tested. NOT benchmarked on MTEB — it is not a semantic model.',
    known_limitations:
      'Lexical only: paraphrases with disjoint wording score near 0. MERI/SCOI semantic conclusions must not be drawn from this provider (WS-H gate); deploy the self-hosted model before relying on semantic similarity.',
  },
  {
    model_name: 'sentence-transformers/all-MiniLM-L6-v2',
    model_version: 'all-MiniLM-L6-v2',
    provider: 'self-hosted HTTP embedding service (EMBEDDING_URL)',
    dimension: EMBEDDING_DIMENSION,
    input_token_limit: 512,
    license: 'Apache-2.0 (AGPL-compatible)',
    evaluation: 'MTEB retrieval avg ≈ 41.95 (published); strong English, fair multilingual.',
    known_limitations:
      '512-token input truncation; English-centric. Registered for production via the EMBEDDING_* env group; never an external third-party API (SPEC §19.1).',
  },
];

// ---------------------------------------------------------------------------
// Deterministic lexical provider (feature hashing + seeded signs).
// ---------------------------------------------------------------------------

/**
 * Hashed character-3-gram bag → 384-d signed feature vector, L2-normalized.
 * Deterministic everywhere (fnv1a32 + fixed sign hash); embed(x)·embed(x)=1.
 */
export class DeterministicLexicalProvider implements EmbeddingProvider {
  readonly modelName = 'licio-lexical-fnv';
  readonly modelVersion = 'lexical-fnv-v1';
  readonly dimension = EMBEDDING_DIMENSION;

  async embed(text: string): Promise<Float32Array> {
    const vector = new Float32Array(this.dimension);
    const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (normalized.length === 0) return vector;
    const n = 3;
    const upTo = Math.max(1, normalized.length - n + 1);
    for (let i = 0; i < upTo; i += 1) {
      const gram = normalized.slice(i, i + n);
      const hash = fnv1a32(gram);
      const bucket = hash % this.dimension;
      // Sign from an independent bit so buckets cancel rather than only add
      // (the standard signed feature-hashing construction — unbiased dot).
      const sign = (fnv1a32(`±${gram}`) & 1) === 0 ? 1 : -1;
      vector[bucket] = (vector[bucket] as number) + sign;
    }
    let norm = 0;
    for (let i = 0; i < vector.length; i += 1) norm += (vector[i] as number) ** 2;
    if (norm > 0) {
      const inv = 1 / Math.sqrt(norm);
      for (let i = 0; i < vector.length; i += 1) {
        vector[i] = (vector[i] as number) * inv;
      }
    }
    return vector;
  }
}

// ---------------------------------------------------------------------------
// Self-hosted HTTP provider (production binding).
// ---------------------------------------------------------------------------

export class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly modelName: string;
  readonly modelVersion: string;
  readonly dimension: number;
  readonly #url: string;

  constructor(config: { url: string; model: string; modelVersion: string; dimension: number }) {
    if (config.dimension !== EMBEDDING_DIMENSION) {
      // The vector(384) column is a migration-level commitment (WS-F.3.2b);
      // booting against a mismatched model would corrupt similarity space.
      throw new Error(
        `EMBEDDING_DIMENSION ${config.dimension} does not match the embeddings table dimension ${EMBEDDING_DIMENSION}; a dimension change requires a migration`,
      );
    }
    this.#url = config.url;
    this.modelName = config.model;
    this.modelVersion = config.modelVersion;
    this.dimension = config.dimension;
  }

  async embed(text: string): Promise<Float32Array> {
    const response = await fetch(this.#url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.modelName, input: text.slice(0, 32_768) }),
    });
    if (!response.ok) {
      throw new Error(`embedding service responded ${response.status}`);
    }
    const payload = (await response.json()) as { embedding?: unknown; data?: unknown };
    const raw = Array.isArray(payload.embedding)
      ? payload.embedding
      : Array.isArray(payload.data) &&
          Array.isArray((payload.data[0] as { embedding?: unknown })?.embedding)
        ? ((payload.data[0] as { embedding: unknown[] }).embedding as unknown[])
        : null;
    if (raw === null || raw.length !== this.dimension || raw.some((x) => typeof x !== 'number')) {
      throw new Error('embedding service returned an invalid vector');
    }
    return Float32Array.from(raw as number[]);
  }
}

// ---------------------------------------------------------------------------
// Generation + model-version migration (WS-F.3.2c/f).
// ---------------------------------------------------------------------------

/** Embed + upsert one target (idempotent on (type, id, version)). */
export async function embedTarget(
  store: EmbeddingStore,
  provider: EmbeddingProvider,
  targetType: EmbeddingTargetType,
  targetId: string,
  text: string,
): Promise<void> {
  const embedding = await provider.embed(text);
  await store.upsert({ targetType, targetId, modelVersion: provider.modelVersion, embedding });
}

export interface BackfillProgress {
  model_version: string;
  from_version: string;
  last_target_id: string | null;
  embedded: number;
  completed: boolean;
  updated_at: string;
}

const BACKFILL_KEY = 'ingestion.embedding_backfill';

export async function getBackfillProgress(
  configStore: PwattConfigStore,
): Promise<BackfillProgress | null> {
  const stored = await configStore.get(BACKFILL_KEY);
  return (stored as BackfillProgress | null) ?? null;
}

/** Start (or restart) a backfill toward `provider.modelVersion`. */
export async function startBackfill(
  configStore: PwattConfigStore,
  fromVersion: string,
  toVersion: string,
  now: () => number,
): Promise<BackfillProgress> {
  const progress: BackfillProgress = {
    model_version: toVersion,
    from_version: fromVersion,
    last_target_id: null,
    embedded: 0,
    completed: false,
    updated_at: new Date(now()).toISOString(),
  };
  await configStore.set(BACKFILL_KEY, progress as unknown as Record<string, unknown>);
  return progress;
}

/**
 * One RESUMABLE, RATE-LIMITED backfill step (WS-F.3.2f): re-embed up to
 * `batch` targets that exist under the old version but not the new one,
 * advancing the recorded keyset cursor. New-version vectors are written
 * ALONGSIDE the old (the unique constraint is per version) so consumers cut
 * over atomically by switching the active version after validation.
 */
export async function runBackfillStep(
  store: EmbeddingStore,
  configStore: PwattConfigStore,
  provider: EmbeddingProvider,
  textOf: (targetType: EmbeddingTargetType, targetId: string) => Promise<string | null>,
  batch: number,
  now: () => number,
): Promise<BackfillProgress | null> {
  const progress = await getBackfillProgress(configStore);
  if (progress === null || progress.completed) return progress;
  if (progress.model_version !== provider.modelVersion) return progress; // wrong provider live
  const missing = await store.listMissingForVersion(
    progress.from_version,
    progress.model_version,
    progress.last_target_id,
    batch,
  );
  for (const target of missing) {
    const text = await textOf(target.targetType, target.targetId);
    if (text !== null) {
      await embedTarget(store, provider, target.targetType, target.targetId, text);
      progress.embedded += 1;
    }
    progress.last_target_id = target.targetId;
  }
  if (missing.length < batch) progress.completed = true;
  progress.updated_at = new Date(now()).toISOString();
  await configStore.set(BACKFILL_KEY, progress as unknown as Record<string, unknown>);
  return progress;
}

export interface BackfillValidation {
  sampled: number;
  /** Mean Jaccard overlap of top-k neighbor SETS (membership drift). */
  meanNeighborOverlap: number;
  /**
   * Mean Rank-Biased Overlap of the top-k neighbor RANKINGS (ordering drift,
   * top-weighted). Set overlap alone scores reordered-but-same neighbors as
   * zero drift; RBO catches a quality shift that keeps the same ids. Both
   * are reported so the human cutover decision sees membership AND order.
   */
  meanRankAgreement: number;
}

/**
 * Rank-Biased Overlap (Webber et al. 2010), truncated at the supplied lists'
 * depth and normalized to [0, 1]: identical rankings → 1, disjoint → 0,
 * same-items-different-order → strictly between. `p` controls top-weighting
 * (0.9 ⇒ the first few ranks dominate but the tail still contributes).
 */
export function rankBiasedOverlap(a: readonly string[], b: readonly string[], p = 0.9): number {
  const depth = Math.max(a.length, b.length);
  if (depth === 0) return 1;
  let weighted = 0;
  let weightTotal = 0;
  for (let d = 1; d <= depth; d += 1) {
    const prefixA = new Set(a.slice(0, d));
    let intersection = 0;
    for (const item of b.slice(0, d)) {
      if (prefixA.has(item)) intersection += 1;
    }
    const weight = (1 - p) * p ** (d - 1);
    weighted += weight * (intersection / d);
    weightTotal += weight;
  }
  return weightTotal === 0 ? 1 : weighted / weightTotal;
}

/**
 * Dual-read validation (WS-F.3.2f): compare old- vs new-version neighbor
 * sets AND rankings on a sample of targets and report the drift BEFORE
 * cutover. Low overlap is expected for a genuinely better model — the
 * metrics inform the human decision, they do not gate automatically.
 */
export async function validateBackfill(
  store: EmbeddingStore,
  targetType: EmbeddingTargetType,
  sampleTargetIds: readonly string[],
  fromVersion: string,
  toVersion: string,
  k: number,
): Promise<BackfillValidation> {
  let overlapTotal = 0;
  let rankTotal = 0;
  let sampled = 0;
  for (const targetId of sampleTargetIds) {
    const oldNeighbors = await store.findSimilar(targetType, targetId, fromVersion, -1, k);
    const newNeighbors = await store.findSimilar(targetType, targetId, toVersion, -1, k);
    if (oldNeighbors.length === 0 && newNeighbors.length === 0) continue;
    const oldRanking = oldNeighbors.map((n) => n.targetId);
    const newRanking = newNeighbors.map((n) => n.targetId);
    const oldSet = new Set(oldRanking);
    const newSet = new Set(newRanking);
    let intersection = 0;
    for (const id of oldSet) {
      if (newSet.has(id)) intersection += 1;
    }
    const union = new Set([...oldRanking, ...newRanking]).size;
    overlapTotal += union === 0 ? 1 : intersection / union;
    rankTotal += rankBiasedOverlap(oldRanking, newRanking);
    sampled += 1;
  }
  return {
    sampled,
    meanNeighborOverlap: sampled === 0 ? 1 : overlapTotal / sampled,
    meanRankAgreement: sampled === 0 ? 1 : rankTotal / sampled,
  };
}
