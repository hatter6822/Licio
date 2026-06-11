// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F unit tests for the remaining pure services: HTML metadata extraction
// (quote-aware scanning, every metadata channel, entity decoding), language
// detection (5+ languages), sensitivity classification, the copyright
// excerpt bound, search scoring/cursor math, runtime-config validation, the
// deterministic embedding provider's mathematical properties, the
// backfill → validate → cutover → cleanup migration path (WS-F.3.2f), the
// submission limiter, and claim extraction.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemorySlidingWindowStore } from '../events/ingest-limiter.js';
import { InMemoryPwattConfigStore } from '../events/stores.js';
import {
  HeuristicClaimExtractor,
  normalizedClaimHash,
  persistCandidateClaims,
} from '../ingestion/claims.js';
import {
  DEFAULT_INGESTION_CONFIG,
  loadIngestionConfig,
  storeIngestionConfigValue,
  validateIngestionConfigValue,
} from '../ingestion/config.js';
import {
  DeterministicLexicalProvider,
  EMBEDDING_MODEL_REGISTRY,
  embedTarget,
  getBackfillProgress,
  HttpEmbeddingProvider,
  rankBiasedOverlap,
  runBackfillStep,
  startBackfill,
  validateBackfill,
} from '../ingestion/embeddings.js';
import {
  boundedExcerpt,
  classifySensitivity,
  decodeEntities,
  detectLanguage,
  extractMetadata,
  scanHtml,
} from '../ingestion/extraction.js';
import {
  evaluatePrechecks,
  LocalDenylistUrlSafety,
  SubmissionRateLimiter,
  titleHash,
} from '../ingestion/prechecks.js';
import {
  decodeSearchCursor,
  encodeSearchCursor,
  InMemorySearchIndex,
  scoreDocument,
  tokenizeQuery,
} from '../ingestion/search.js';
import {
  cosineSimilarity,
  InMemoryClaimStore,
  InMemoryEmbeddingStore,
  InMemoryReviewQueueStore,
} from '../ingestion/stores.js';
import { articleHtml } from './ws-f-helpers.js';

describe('HTML scanning + metadata extraction (WS-F.1.4e)', () => {
  it('extracts every supported channel from a realistic article', () => {
    const meta = extractMetadata(articleHtml(), 'news.example');
    expect(meta.title).toBe('Reservoir level fell 12% in May');
    expect(meta.author).toBe('A. Reporter');
    expect(meta.publisher).toBe('Example News');
    expect(meta.publishedAt).toBe('2026-06-10T08:00:00.000Z');
    expect(meta.mediaType).toBe('article');
    expect(meta.description).toContain('reservoir decline');
    expect(meta.language).toBe('en');
    expect(meta.bodyText).toContain('reservoir level fell by 12 percent');
    // Script content is NEVER text.
    expect(meta.bodyText).not.toContain('never extracted');
  });

  it('handles attribute values containing > and quoted apostrophes', () => {
    const scanned = scanHtml(
      `<meta property="og:title" content="a > b &amp; c's"><meta name='author' content='O&#39;Brien'>`,
    );
    expect(scanned.metas[0]?.attributes['content']).toBe("a > b & c's");
    expect(scanned.metas[1]?.attributes['content']).toBe("O'Brien");
  });

  it('records publisher robots directives and falls back to the domain', () => {
    const meta = extractMetadata(articleHtml({ robotsMeta: 'noindex, noarchive' }), 'x.example');
    expect(meta.noindex).toBe(true);
    expect(meta.noarchive).toBe(true);
    const bare = extractMetadata('<html><body><p>plain</p></body></html>', 'bare.example');
    expect(bare.publisher).toBe('bare.example');
    expect(bare.author).toBeNull();
    expect(bare.mediaType).toBeNull();
  });

  it('decodes numeric/hex/named entities and rejects out-of-range code points', () => {
    expect(decodeEntities('&#72;&#x69;&nbsp;&lt;tag&gt; &quot;q&quot; &amp;')).toBe(
      'Hi <tag> "q" &',
    );
    expect(decodeEntities('&#x110000;')).toBe(''); // beyond U+10FFFF
  });
});

describe('language detection (WS-F.1.4e: 5+ languages)', () => {
  it('prefers the document declaration and canonicalizes it', () => {
    expect(detectLanguage('PT-br', 'whatever text')).toBe('pt-BR');
  });

  it.each([
    [
      'en',
      'the report and the council said that the vote of the city was for the new plan with the votes that was in the room',
    ],
    [
      'es',
      'el informe de la ciudad y los planes de las obras que una vez por la tarde con los datos para el futuro de la region',
    ],
    [
      'de',
      'der bericht und die stadt mit das neue projekt ist nicht ein problem für die menschen und eine lösung mit der zeit',
    ],
    [
      'fr',
      'le rapport de la ville et les plans dans une réunion pour les habitants est dans le centre avec que une décision',
    ],
    [
      'pt',
      'o relatório de uma cidade que não tem os planos para as obras com mais detalhes de como das ruas e uma praça',
    ],
    [
      'it',
      'il rapporto di una città che per la riunione sono con il consiglio del piano e una decisione più importante con del tempo',
    ],
  ])('classifies %s from stopword frequencies', (tag, text) => {
    expect(detectLanguage(null, text)).toBe(tag);
  });

  it('reports und honestly for short or indeterminate text', () => {
    expect(detectLanguage(null, 'zzz qqq')).toBe('und');
    // No token below is a stopword in any supported language.
    expect(
      detectLanguage(null, 'wq lk pf mz tr xb nv cd ks lw pq rs tu vw xy za bc dx fg hi jk'),
    ).toBe('und');
  });
});

describe('sensitivity classification + excerpt bound (WS-F.1.4e/f)', () => {
  it('labels known categories conservatively and defaults to none', () => {
    expect(classifySensitivity('The election ballot count continues')).toEqual(['political']);
    expect(classifySensitivity('Hospital reports on the new vaccine clinical trial')).toEqual([
      'medical',
    ]);
    expect(classifySensitivity('Earthquake triggers evacuation orders across the region')).toEqual([
      'crisis',
    ]);
    expect(classifySensitivity('A pleasant story about gardening')).toEqual(['none']);
    // Multi-label content carries every applicable label.
    expect(classifySensitivity('Election held during the wildfire evacuation')).toEqual([
      'political',
      'crisis',
    ]);
  });

  it('bounds the excerpt on a word boundary with an ellipsis', () => {
    const text = 'word '.repeat(200);
    const excerpt = boundedExcerpt(text, 100) as string;
    expect(excerpt.length).toBeLessThanOrEqual(100);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(boundedExcerpt('short text', 100)).toBe('short text');
    expect(boundedExcerpt('   ', 100)).toBeNull();
  });
});

describe('search scoring + cursor math (WS-F.3.1a/b)', () => {
  const doc = {
    resultType: 'story' as const,
    id: randomUUID(),
    storyId: null,
    title: 'Quantum reservoir breakthrough',
    body: 'Researchers announced new results today.',
    snippet: null,
    topicIds: [],
    sourceId: null,
    language: 'en',
    createdAt: '2026-06-11T00:00:00.000Z',
    visible: true,
  };

  it('weights title over body, requires every token (AND), supports prefix on the last token', () => {
    expect(scoreDocument(doc, ['quantum'], false)).toBe(1);
    expect(scoreDocument(doc, ['researchers'], false)).toBe(0.4);
    expect(scoreDocument(doc, ['quantum', 'missing'], false)).toBe(0);
    expect(scoreDocument(doc, ['quantum', 'research'], true)).toBeGreaterThan(0);
    expect(scoreDocument(doc, ['quantum', 'research'], false)).toBe(0);
  });

  it('tokenization strips every operator/quote character (injection-safe input)', () => {
    expect(tokenizeQuery(`quantum' OR 1=1; -- ($!&|:*)`)).toEqual(['quantum', 'or', '1', '1']);
    expect(tokenizeQuery('')).toEqual([]);
  });

  it('cursor round-trips and rejects garbage', () => {
    const cursor = encodeSearchCursor(1.25, doc.createdAt, doc.id);
    expect(decodeSearchCursor(cursor)).toEqual({
      relevance: 1.25,
      createdAt: doc.createdAt,
      id: doc.id,
    });
    expect(decodeSearchCursor('!!!not-a-cursor')).toBeNull();
    expect(decodeSearchCursor(Buffer.from('a|b').toString('base64url'))).toBeNull();
  });

  it('the index hides invisible docs and paginates a stable total order', async () => {
    const docs = [
      doc,
      { ...doc, id: randomUUID(), title: 'Quantum hidden', visible: false },
      { ...doc, id: randomUUID(), title: 'Quantum second', createdAt: '2026-06-10T00:00:00.000Z' },
    ];
    const index = new InMemorySearchIndex(async () => docs);
    const page = await index.search({ q: 'quantum', limit: 10, prefix: false });
    expect(page.items.map((i) => i.title)).toEqual([
      'Quantum reservoir breakthrough',
      'Quantum second',
    ]);
  });
});

describe('runtime config (WS-F admin; fail-closed loader)', () => {
  it('validates writes per key (the 422 path) and round-trips valid overrides', async () => {
    expect(validateIngestionConfigValue('nearDuplicateThreshold', 0.8)).toBeNull();
    expect(validateIngestionConfigValue('nearDuplicateThreshold', 5)).not.toBeNull();
    expect(validateIngestionConfigValue('no_such_key', 1)).toMatch(/unknown/);
    expect(validateIngestionConfigValue('malwareDomains', ['evil.example'])).toBeNull();
    expect(validateIngestionConfigValue('malwareDomains', 'evil.example')).not.toBeNull();

    const store = new InMemoryPwattConfigStore();
    await storeIngestionConfigValue(store, 'submissionPerHour', 5);
    const loaded = await loadIngestionConfig(store);
    expect(loaded.submissionPerHour).toBe(5);
    expect(loaded.submissionPerDay).toBe(DEFAULT_INGESTION_CONFIG.submissionPerDay);
  });

  it('keeps the default and reports when a stored value is invalid (fail closed)', async () => {
    const store = new InMemoryPwattConfigStore();
    await store.set('ingestion.submissionPerHour', { value: -5 });
    const invalid: string[] = [];
    const loaded = await loadIngestionConfig(store, (key) => invalid.push(key));
    expect(loaded.submissionPerHour).toBe(DEFAULT_INGESTION_CONFIG.submissionPerHour);
    expect(invalid).toEqual(['submissionPerHour']);
  });
});

describe('deterministic lexical embedding provider (WS-F.3.2a)', () => {
  const provider = new DeterministicLexicalProvider();

  it('produces unit vectors of the pinned dimension, deterministically', async () => {
    const a = await provider.embed('The reservoir level fell by 12 percent.');
    const b = await provider.embed('The reservoir level fell by 12 percent.');
    expect(a.length).toBe(384);
    expect([...a]).toEqual([...b]);
    let norm = 0;
    for (const x of a) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 6);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 9);
  });

  it('orders lexical overlap correctly (more shared text ⇒ higher cosine)', async () => {
    const base = await provider.embed('the city council approved the reservoir bond on tuesday');
    const nearVec = await provider.embed(
      'the city council approved the reservoir bond on tuesday evening',
    );
    const far = await provider.embed('completely unrelated text about migratory bird patterns');
    expect(cosineSimilarity(base, nearVec)).toBeGreaterThan(cosineSimilarity(base, far));
    expect(cosineSimilarity(base, nearVec)).toBeGreaterThan(0.8);
    expect(cosineSimilarity(base, far)).toBeLessThan(0.3);
  });

  it('the registry documents both models with HONEST limitations', () => {
    const lexical = EMBEDDING_MODEL_REGISTRY.find((m) => m.model_version === 'lexical-fnv-v1');
    expect(lexical?.known_limitations).toMatch(/not.*semantic|Lexical only/i);
    const minilm = EMBEDDING_MODEL_REGISTRY.find((m) => m.model_version === 'all-MiniLM-L6-v2');
    expect(minilm?.license).toContain('Apache-2.0');
    expect(minilm?.dimension).toBe(384);
  });

  it('the HTTP provider refuses a dimension that mismatches the table', () => {
    expect(
      () =>
        new HttpEmbeddingProvider({
          url: 'https://embed.internal',
          model: 'other',
          modelVersion: 'v9',
          dimension: 768,
        }),
    ).toThrow(/migration/);
  });
});

describe('re-embedding migration (WS-F.3.2f)', () => {
  it('backfills resumably, validates neighbor drift, cuts over, and cleans up', async () => {
    const store = new InMemoryEmbeddingStore();
    const configStore = new InMemoryPwattConfigStore();
    const v1 = new DeterministicLexicalProvider();
    // Seed 5 story embeddings under v1.
    const ids: string[] = Array.from({ length: 5 }, () => randomUUID()).sort();
    const texts = new Map<string, string>(
      ids.map((id, i) => [id, `story text number ${i} about topic ${i}`]),
    );
    for (const id of ids) {
      await embedTarget(store, v1, 'story', id, texts.get(id) as string);
    }
    // A v2 provider (same math, different version label — the migration path
    // is version-agnostic).
    const v2 = {
      modelName: v1.modelName,
      modelVersion: 'lexical-fnv-v2',
      dimension: v1.dimension,
      embed: (text: string) => v1.embed(text),
    };

    await startBackfill(configStore, v1.modelVersion, v2.modelVersion, Date.now);
    // Rate-limited steps of 2: three steps complete the corpus, resumably.
    const textOf = async (_type: string, id: string) => texts.get(id) ?? null;
    let progress = await runBackfillStep(store, configStore, v2, textOf, 2, Date.now);
    expect(progress?.embedded).toBe(2);
    expect(progress?.completed).toBe(false);
    progress = await runBackfillStep(store, configStore, v2, textOf, 2, Date.now);
    expect(progress?.embedded).toBe(4);
    progress = await runBackfillStep(store, configStore, v2, textOf, 2, Date.now);
    expect(progress?.completed).toBe(true);
    // Both versions coexist (atomic cutover is a config flip).
    expect(await store.countByVersion(v1.modelVersion)).toBe(5);
    expect(await store.countByVersion(v2.modelVersion)).toBe(5);
    // Identical math ⇒ identical neighbors ⇒ overlap 1 (drift metric sane).
    const validation = await validateBackfill(
      store,
      'story',
      ids,
      v1.modelVersion,
      v2.modelVersion,
      3,
    );
    expect(validation.sampled).toBe(5);
    // Identical math ⇒ identical neighbors AND identical order ⇒ both metrics 1.
    expect(validation.meanNeighborOverlap).toBeCloseTo(1, 6);
    expect(validation.meanRankAgreement).toBeCloseTo(1, 6);
    // Cleanup removes the superseded version only.
    expect(await store.deleteVersion(v1.modelVersion, 1_000)).toBe(5);
    expect(await store.countByVersion(v2.modelVersion)).toBe(5);
    // Progress is queryable.
    expect((await getBackfillProgress(configStore))?.completed).toBe(true);
  });

  it('rankBiasedOverlap distinguishes order, not just membership (the C9 fix)', () => {
    expect(rankBiasedOverlap(['a', 'b', 'c'], ['a', 'b', 'c'])).toBeCloseTo(1, 9);
    expect(rankBiasedOverlap(['a', 'b', 'c'], ['x', 'y', 'z'])).toBeCloseTo(0, 9);
    // SAME items, reversed order: set overlap = 1 but RBO is strictly < 1 —
    // exactly the ordering drift the set metric is blind to.
    const reordered = rankBiasedOverlap(['a', 'b', 'c'], ['c', 'b', 'a']);
    expect(reordered).toBeGreaterThan(0);
    expect(reordered).toBeLessThan(1);
    // Top-weighted: a swap deeper in the list disturbs RBO less than a swap
    // at the head.
    const deepSwap = rankBiasedOverlap(['a', 'b', 'c', 'd'], ['a', 'b', 'd', 'c']);
    const headSwap = rankBiasedOverlap(['a', 'b', 'c', 'd'], ['b', 'a', 'c', 'd']);
    expect(deepSwap).toBeGreaterThan(headSwap);
    expect(rankBiasedOverlap([], [])).toBe(1);
  });
});

describe('pre-checks units (WS-F.1.4c)', () => {
  it('the submission limiter enforces hour AND day windows with exact retry math', async () => {
    const limiter = new SubmissionRateLimiter(new InMemorySlidingWindowStore());
    const limits = { perHour: 2, perDay: 3 };
    const t0 = Date.parse('2026-06-11T00:00:00.000Z');
    expect((await limiter.hit('u', limits, t0)).allowed).toBe(true);
    expect((await limiter.hit('u', limits, t0 + 1_000)).allowed).toBe(true);
    const third = await limiter.hit('u', limits, t0 + 2_000);
    expect(third.allowed).toBe(false);
    // The hour window violated: wait until the oldest entry ages out.
    expect(third.retryAfterSec).toBeGreaterThan(3_500);
    // An hour later the hour window admits, but the DAY budget (3) is used up
    // (denied attempts count — conservative).
    const later = await limiter.hit('u', limits, t0 + 3_700_000);
    expect(later.allowed).toBe(false);
  });

  it('titleHash normalizes case/whitespace; denylist matches parents only', async () => {
    expect(titleHash('  Exactly THE Same  headline ')).toBe(titleHash('exactly the same headline'));
    const safety = new LocalDenylistUrlSafety(() => ['evil.example']);
    expect(await safety.check('evil.example')).toBe('malicious');
    expect(await safety.check('a.b.evil.example')).toBe('malicious');
    expect(await safety.check('notevil.example')).toBe('safe');
    expect(await safety.check('evil.example.org')).toBe('safe');
  });

  it('evaluatePrechecks orders rejections and computes the waiting period', () => {
    const base = {
      accountCreatedAtIso: '2026-06-11T00:00:00.000Z',
      nowMs: Date.parse('2026-06-11T00:30:00.000Z'),
      minAccountAgeMinutes: 60,
      duplicateTitleCount: 0,
      duplicateTitleLimit: 3,
      canonicalDomain: null,
      urlVerdict: null,
    };
    expect(evaluatePrechecks(base)).toEqual({ code: 'account_too_new', waitMinutes: 30 });
    expect(evaluatePrechecks({ ...base, minAccountAgeMinutes: 0, duplicateTitleCount: 3 })).toEqual(
      { code: 'duplicate_title_spam' },
    );
    expect(
      evaluatePrechecks({
        ...base,
        minAccountAgeMinutes: 0,
        canonicalDomain: 'x.example',
        urlVerdict: 'malicious',
      }),
    ).toEqual({ code: 'malicious_url' });
    expect(
      evaluatePrechecks({
        ...base,
        minAccountAgeMinutes: 0,
        canonicalDomain: 'x.example',
        urlVerdict: 'unavailable',
      }),
    ).toEqual({ code: 'url_safety_unavailable_hold' });
    expect(
      evaluatePrechecks({
        ...base,
        minAccountAgeMinutes: 0,
        canonicalDomain: 'x.example',
        urlVerdict: 'safe',
      }),
    ).toBeNull();
  });
});

describe('claim extraction units (WS-F.1.2b)', () => {
  it('keeps declarative claims, filters questions/hedges/opinions, dedups + review-routes', async () => {
    const extractor = new HeuristicClaimExtractor();
    const candidates = await extractor.extract(
      'Reservoir report',
      'The reservoir level fell by 12 percent in May. Is the city prepared for summer? ' +
        'I think the council acted too late. Maybe the rains will help. ' +
        'The council approved additional funding for the pipeline replacement.',
    );
    const texts = candidates.map((c) => c.text);
    expect(texts.some((t) => t.includes('fell by 12 percent'))).toBe(true);
    expect(texts.some((t) => t.includes('approved additional funding'))).toBe(true);
    expect(texts.some((t) => t.includes('prepared for summer'))).toBe(false); // question
    expect(texts.some((t) => t.includes('I think'))).toBe(false); // opinion
    expect(texts.some((t) => t.includes('Maybe'))).toBe(false); // hedge

    const claims = new InMemoryClaimStore();
    const reviews = new InMemoryReviewQueueStore();
    const story = { storyId: randomUUID(), title: 'Reservoir report' };
    const first = await persistCandidateClaims(
      claims,
      reviews,
      extractor,
      story,
      'The reservoir level fell by 12 percent in May.',
      0.9, // floor above the heuristic confidence ⇒ review-routed
    );
    expect(first.created).toHaveLength(1);
    expect(first.created[0]?.claimStatus).toBe('candidate');
    expect(first.created[0]?.modelVersion).toBe(extractor.modelVersion);
    expect(await reviews.list({ kind: 'low_confidence_claim' }, 10)).toHaveLength(1);
    // The same normalized text from another story LINKS, never duplicates.
    const second = await persistCandidateClaims(
      claims,
      reviews,
      extractor,
      { storyId: randomUUID(), title: 'Other story' },
      'The reservoir level FELL by 12 percent in May!',
      0.1,
    );
    expect(second.created).toHaveLength(0);
    expect(second.linked.map((c) => c.claimId)).toEqual([first.created[0]?.claimId]);
  });

  it('normalizedClaimHash is case/punctuation/whitespace-insensitive', () => {
    expect(normalizedClaimHash('The vote PASSED, 62-30!')).toBe(
      normalizedClaimHash('the vote passed 6230'),
    );
  });
});
