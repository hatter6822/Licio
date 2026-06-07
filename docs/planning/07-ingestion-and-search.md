# WS-F: Ingestion, Source Model, and Search

**Milestone:** M1
**Priority:** P1
**Dependencies:** WS-D.1 (accounts and authentication), packages/db (Drizzle ORM)
**Wave:** 3-4
**Estimated duration:** 3 weeks

---

## Overview

WS-F builds the content pipeline that feeds everything downstream: stories enter the system, are deduplicated and normalized, receive source and claim metadata, and become searchable. Every story creates a thread shell. Duplicate detection operates at three levels -- exact URL match, near-duplicate text similarity, and syndicated copy detection -- to prevent MERI-violating content floods before they reach the ranking pipeline. Search uses PostgreSQL full-text indexing for keyword queries and pgvector for embedding-based similarity, which later powers MERI independence checks and SCOI interpretation comparison. No ranking influence from wallet or payment data touches any table in this workstream (Section 21.5).

---

## WS-F.1 Story ingestion

### WS-F.1.3a URL normalization
**ID:** WS-F.1.3a
**Ref:** Section 14.2

**Description:**
Implement a URL normalization function in `packages/shared/src/utils/url.ts`. The function accepts a raw URL and returns a canonical form by applying the following transformations in order: (1) parse the URL (reject malformed URLs), (2) normalize the scheme to `https` (upgrade `http` to `https`; reject non-http(s) schemes), (3) normalize the host to lowercase, (4) remove `www.` prefix if present, (5) remove default ports (80, 443), (6) normalize the path: lowercase, remove trailing slash (except for root `/`), resolve `.` and `..` segments, (7) remove tracking query parameters: `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `utm_id`, `fbclid`, `gclid`, `msclkid`, `twclkd`, `dclid`, `mc_cid`, `mc_eid`, `ref`, `ref_src`, `ref_url` and other common tracking parameters from a configurable denylist, (8) sort remaining query parameters alphabetically, (9) remove the fragment (hash). The denylist is configurable and stored in the application configuration (not hardcoded) so new trackers can be added without a code deployment.

**Acceptance criteria:**
- `http://WWW.Example.Com/path/?utm_source=twitter&id=5` normalizes to `https://example.com/path?id=5`.
- Trailing slashes are removed (except root).
- Tracking parameters from the denylist are stripped.
- Non-tracking parameters are preserved and sorted.
- Fragments are removed.
- Malformed URLs are rejected with a clear error.
- Non-http(s) schemes (ftp, javascript, data) are rejected.
- The function is pure (same input always produces same output).
- The tracker denylist is configurable without code changes.

**Testing:**
- Unit: Comprehensive test suite with at least 30 URL normalization cases covering: protocol normalization, www removal, case normalization, trailing slash removal, tracking parameter stripping (each parameter individually), parameter sorting, fragment removal, default port removal, path normalization, malformed URL rejection, non-http scheme rejection, Unicode domain handling, URLs with authentication components (stripped for safety).
- Property-based: `normalize(normalize(url)) === normalize(url)` (idempotency).

---

### WS-F.1.3b Exact-URL duplicate detection
**ID:** WS-F.1.3b
**Ref:** Section 14.2

**Description:**
Implement post-canonicalization exact-URL duplicate detection. When a story is submitted, the canonical URL (from WS-F.1.3a) is looked up against the `canonical_url` index on the `Story` table (WS-F.1.1). If an exact match is found: (1) do not create a new story, (2) return a 409 Conflict response with the existing story's ID and a redirect suggestion, (3) log the duplicate detection (submission user, existing story ID, timestamp) for analytics. If no match, proceed with story creation. The lookup uses the existing B-tree index on `canonical_url` for O(log n) performance.

**Acceptance criteria:**
- Submitting a URL that normalizes to the same canonical URL as an existing story returns 409 with the existing story ID.
- The response includes a link to the existing story so the user can participate in the existing thread.
- Different URLs that normalize to the same canonical form are correctly detected as duplicates (e.g., `http://example.com/path?utm_source=x` and `https://example.com/path`).
- URLs that are genuinely different (different paths, different query parameters that are not trackers) are not flagged as duplicates.
- Duplicate detection uses the database index (no full table scan).
- Detection latency is < 50ms at p99 for databases with up to 1 million stories.

**Testing:**
- Integration: Submit a URL. Submit the same URL with different tracking parameters -- verify 409. Submit a different URL -- verify 201. Verify the existing story ID is returned in the duplicate response.
- Performance: Benchmark duplicate lookup with 100K and 1M story fixtures.

---

### WS-F.1.3c Near-duplicate text detection
**ID:** WS-F.1.3c
**Ref:** Section 14.2

**Description:**
Implement near-duplicate text detection using shingling and MinHash. After a story is submitted and its content is extracted (title + body text), compute a set of character-level n-gram shingles (k=5), then compute a MinHash signature (128 hash functions). Compare the MinHash signature against existing stories using Locality-Sensitive Hashing (LSH) with a Jaccard similarity threshold of 0.7 (configurable). If a near-duplicate is found: (1) flag the submission for review (do not auto-reject -- the submitter may have a valid reason, such as adding commentary), (2) include the similar stories in the review context, (3) a steward or automated rule can merge, link, or allow the submission. Store MinHash signatures in the database for future comparisons. The comparison scales sub-linearly via LSH bands (not pairwise comparison).

**Acceptance criteria:**
- Articles with >= 70% text overlap are flagged as near-duplicates.
- Articles with < 50% overlap are not flagged.
- Near-duplicate detection returns the IDs of similar existing stories.
- The submitter is informed that a similar story exists and given the option to add their submission as a contribution to the existing thread.
- MinHash signatures are stored for future comparisons.
- LSH ensures sub-linear scaling (not O(n) pairwise comparison against all stories).
- The similarity threshold is configurable.

**Testing:**
- Unit: Compute MinHash for known texts with known overlap percentages. Verify flagging at threshold. Verify no flagging below threshold.
- Integration: Submit a story, then submit a paraphrased version (70%+ overlap) -- verify flagged. Submit an unrelated story -- verify not flagged.
- Performance: Benchmark LSH lookup with 100K signatures.

---

### WS-F.1.3d Syndicated copy detection
**ID:** WS-F.1.3d
**Ref:** Section 14.2

**Description:**
Detect syndicated copies: the same content published by different publishers (e.g., an AP wire story appearing on 10 different news sites). This extends near-duplicate detection (WS-F.1.3c) with source-awareness. When a near-duplicate is detected and the `source_id` differs from the existing story's source, classify it as a potential syndicated copy rather than a user-submitted duplicate. Check for syndication relationships in the `Source` table (WS-F.2.1: `syndication_relationships` field). If a known syndication relationship exists, auto-link the submission to the existing story as a syndicated source (no new story created, but the source is added to the story's source list). If no known relationship exists, flag for steward review to establish the relationship. Syndicated copies do not create independent MERI exposure -- they are grouped with the original.

**Acceptance criteria:**
- Same content from a known syndication partner is auto-linked to the existing story.
- Same content from an unknown publisher is flagged for steward review.
- Syndicated copies are grouped with the original for MERI purposes (no independent exposure).
- The story's source list is updated to include the syndicated source.
- Steward review can establish a new syndication relationship between sources.
- Original stories are never replaced by syndicated copies.

**Testing:**
- Integration: Submit a story from Publisher A. Submit the same content from Publisher B (known syndication partner) -- verify auto-link. Submit from Publisher C (unknown) -- verify flagged for review. Verify MERI grouping.
- Unit: Syndication relationship lookup logic.

---

### WS-F.1.4a POST /v1/stories endpoint
**ID:** WS-F.1.4a
**Ref:** Sections 14.1, 23.2

**Description:**
Implement the `POST /v1/stories` Hono route. The endpoint accepts story submissions from authenticated users. Request body is validated against a zod schema that includes: `submission_type` (enum: `link`, `original_brief`, `question`, `evidence_card`, `local_update`, `live_thread` per Section 14.1), `url` (required for `link`, forbidden for other types), `title` (required), `body` (optional for `link`, required for `original_brief` and `question`), `topic_ids` (array, at least one required), `reason` (short text: why this is being submitted), and type-specific fields (see WS-F.1.4b). The endpoint runs URL normalization (WS-F.1.3a) and duplicate detection (WS-F.1.3b-d) before creating the story. On success, returns 201 Created with the story ID, thread ID (auto-created per WS-F.1.4d), and the story's initial lifecycle state (`submitted`).

**Acceptance criteria:**
- All six submission types are accepted with correct validation per type.
- Link stories require a URL; other types reject a URL field.
- URL normalization and duplicate detection run before story creation.
- Response includes story_id, thread_id, and lifecycle_state.
- Unauthenticated requests return 401.
- Invalid submissions return 400 with field-level error details.
- The endpoint respects rate limiting (WS-F.1.4c).

**Testing:**
- Integration: Submit each of the six types with valid data -- verify 201. Submit with missing required fields -- verify 400. Submit unauthenticated -- verify 401. Submit a duplicate URL -- verify 409.
- E2E: Full submission flow from the client.

---

### WS-F.1.4b Required metadata validation per type
**ID:** WS-F.1.4b
**Ref:** Section 14.1

**Description:**
Implement per-submission-type metadata validation as zod discriminated unions. Each submission type has specific required and optional fields per Section 14.1:

- **Link story:** URL (required), topic (required), short reason for submission (required).
- **Original brief:** topic (required), title (required), body (required), disclosure if personal experience (boolean, optional).
- **Question:** question text (required), context (optional), topic (required).
- **Evidence card:** citation URL or reference (required), claim reference (required, must reference an existing claim_id), relevance note (required).
- **Local update:** location scope (required), time reference (optional), source or experience disclosure (required).
- **Live thread:** event description (required), time reference (required), moderation mode (enum: standard, breaking, sensitive; required).

The zod schema uses `z.discriminatedUnion("submission_type", [...])` so validation is type-specific and error messages reference the correct required fields for the submitted type.

**Acceptance criteria:**
- Each submission type validates its specific required fields.
- Submitting an evidence card without a valid claim reference returns a 400 with a message about the missing claim reference.
- Submitting a link story without a URL returns a 400.
- Submitting a local update without a location scope returns a 400.
- Extra fields not defined for the submission type are stripped (strict parsing).
- The discriminated union produces clear, type-specific error messages.

**Testing:**
- Unit: Test each submission type with valid data, missing required fields, and extra fields. Verify error messages reference the correct missing field for each type.
- Integration: Submit evidence cards with valid and invalid claim references.

---

### WS-F.1.4c Safety pre-checks
**ID:** WS-F.1.4c
**Ref:** Sections 14.2, 18.2, 25.5

**Description:**
Implement safety pre-checks that run before a story is created. Checks: (1) spam detection -- reject submissions from accounts with high submission rates (configurable: default 10 stories per hour, 50 per day), accounts younger than a configurable age threshold (default 1 hour), or submissions matching known spam patterns (repeated titles, known spam domains). (2) Malware link scanning -- for link stories, check the URL against a malware/phishing domain list (e.g., Google Safe Browsing API or a locally-maintained denylist). Reject URLs that match. (3) Rate limiting -- per-user submission rate limits (configurable, separate from global API rate limits). Rate-limited submissions return 429 with Retry-After. Pre-checks run asynchronously where possible to minimize submission latency; malware checks may add up to 500ms.

**Acceptance criteria:**
- Submissions exceeding the per-user rate limit return 429.
- Submissions from very new accounts (< 1 hour) are rejected with a message explaining the waiting period.
- Submissions with URLs matching the malware/phishing denylist are rejected with a 403 and a reason.
- Known spam patterns (repeated identical titles within a window) are rejected.
- Legitimate submissions are not delayed by more than 500ms for pre-checks.
- Rate limits and spam patterns are configurable without code deployment.

**Testing:**
- Integration: Submit stories at a rate exceeding the limit -- verify 429. Submit from a new account -- verify rejection. Submit a URL from the malware denylist -- verify 403. Submit a legitimate story -- verify latency < 500ms.
- Unit: Spam pattern detection with mock data.

---

### WS-F.1.4d Thread shell creation
**ID:** WS-F.1.4d
**Ref:** Sections 14.2, 15

**Description:**
Automatically create a thread shell for every submitted story. When a story is created (after passing all validation and pre-checks), create a `Thread` record linked to the story: `thread_id` (UUID), `story_id` (FK), `room_id` (nullable -- assigned when the story is placed in a room), `branch_index` (0 for the initial branch), `current_summary_id` (null -- no summary yet), `conversation_state` (enum: `empty`), `safety_state` (enum: `normal`), `created_at`. The thread is the container for all contributions (questions, evidence, corrections, etc.) related to the story. The thread ID is returned in the story submission response (WS-F.1.4a).

**Acceptance criteria:**
- Every story creation results in exactly one thread creation (transactional).
- The thread is linked to the story via `story_id` FK.
- The thread starts with `conversation_state: empty` and `safety_state: normal`.
- If story creation fails (duplicate, validation error), no orphan thread is created.
- The thread ID is included in the story creation response.
- Thread creation is part of the same database transaction as story creation.

**Testing:**
- Integration: Submit a story -- verify thread created. Query thread by story_id -- verify link. Fail a story submission (duplicate) -- verify no orphan thread. Verify transactional behavior (rollback on failure).

---

### WS-F.1.4e Metadata extraction
**ID:** WS-F.1.4e
**Ref:** Section 14.2

**Description:**
Implement metadata extraction for link stories. After a link story is created, an async worker fetches the linked URL (respecting robots.txt, per Section 14.2) and extracts: author name (from meta tags, JSON-LD, or byline patterns), publication date (from meta tags, JSON-LD, or Open Graph), publisher name (from domain, meta tags, or JSON-LD), primary media type (enum: article, video, podcast, dataset, report, document, image), and raw text content (for embedding generation and near-duplicate detection). Additionally, run classification: topic classification (map to existing topic taxonomy), language detection (BCP 47 code), and sensitivity classification (enum: none, graphic, medical, political, crisis -- used for content warnings and age-appropriate filtering). Store extracted metadata in the `Story` record. Extraction failures are non-blocking: the story is created with partial metadata and flagged for manual extraction.

**Acceptance criteria:**
- Author, date, publisher, and media type are extracted from supported meta tag formats (Open Graph, JSON-LD, Twitter Cards, standard HTML meta).
- Language is detected and stored as a BCP 47 code.
- Topic classification maps to the existing taxonomy.
- Sensitivity classification produces appropriate labels for graphic, medical, or crisis content.
- Extraction respects robots.txt (does not fetch disallowed URLs).
- Extraction failure does not block story creation.
- Failed extractions are flagged for manual review.
- Extracted text is used for near-duplicate detection (WS-F.1.3c) and embedding generation (WS-F.3.2c).

**Testing:**
- Integration: Submit a link story with well-structured meta tags -- verify extraction. Submit a URL with no meta tags -- verify partial extraction with fallbacks. Submit a URL blocked by robots.txt -- verify no fetch attempt. Verify sensitivity classification for known test cases.
- Unit: Meta tag parsing for each supported format. Language detection for 5+ languages.

---

## WS-F.3 Search

### WS-F.3.2a Embedding model selection and registry
**ID:** WS-F.3.2a
**Ref:** Section 21.4, WS-K (AI governance)

**Description:**
Select and register an embedding model for semantic search and similarity computations. The model must: produce dense vector embeddings suitable for cosine similarity, support English as a primary language with reasonable multilingual performance, be deployable locally or via a self-hosted API (no mandatory external API dependency for production -- privacy requirement per Section 19.1), and have a vector dimensionality compatible with pgvector (typically 384-1536 dimensions). Register the model in the AI model registry (WS-K): model name, version, provider, dimensionality, input token limit, license, evaluation results, known limitations. For MVP, a model such as `all-MiniLM-L6-v2` (384 dimensions, permissively licensed, small enough for self-hosting) is appropriate. The registry entry includes an evaluation benchmark (e.g., MTEB retrieval scores on news/social datasets).

**Acceptance criteria:**
- An embedding model is selected with documented rationale.
- The model is registered in the AI model registry with all required fields.
- The model can be loaded and used in a local/self-hosted environment (no mandatory external API).
- Vector dimensionality is documented and consistent across all embedding consumers.
- An evaluation benchmark is recorded in the registry.
- The model license is compatible with AGPL-3.0-or-later.

**Testing:**
- Unit: Model loads and produces embeddings of the expected dimensionality for sample texts.
- Integration: Registry entry is queryable and contains all required fields.

---

### WS-F.3.2b pgvector extension setup
**ID:** WS-F.3.2b
**Ref:** Section 21.2

**Description:**
Set up the pgvector extension in PostgreSQL for vector similarity search. Create a migration that: (1) installs the `vector` extension (`CREATE EXTENSION IF NOT EXISTS vector`), (2) creates an `Embedding` table: `embedding_id` (UUID PK), `target_type` (enum: story, claim, source, evidence_card, community_interpretation), `target_id` (UUID, reference to the embedded entity), `model_version` (text, references the AI registry), `embedding` (vector type with dimensionality matching the selected model, e.g., `vector(384)`), `created_at` (timestamptz), with a unique constraint on `(target_type, target_id, model_version)` to prevent duplicate embeddings. (3) Create an IVFFlat or HNSW index on the embedding column for approximate nearest neighbor queries. Configure the index for the expected dataset size (IVFFlat with `lists = sqrt(n)` or HNSW with appropriate `m` and `ef_construction` parameters).

**Acceptance criteria:**
- pgvector extension is installed and available in the database.
- `Embedding` table is created with correct schema.
- Vector dimensionality matches the selected embedding model.
- Duplicate embeddings for the same entity and model version are rejected by the unique constraint.
- An ANN index exists on the embedding column.
- Similarity queries using `<=>` (cosine distance) or `<->` (L2 distance) use the index.
- Migration applies cleanly and rolls back without data loss.

**Testing:**
- Integration: Insert embeddings, run similarity queries, verify results. Verify index usage via EXPLAIN. Test unique constraint enforcement. Migration up/down cycle.
- Performance: Benchmark similarity query latency with 10K and 100K embeddings.

---

### WS-F.3.2c Embedding generation pipeline
**ID:** WS-F.3.2c
**Ref:** Section 14.2

**Description:**
Implement an async embedding generation pipeline. When a story, claim, evidence card, or community interpretation is created or materially updated, queue an embedding generation job. The worker: (1) loads the registered embedding model (WS-F.3.2a), (2) extracts the relevant text content (story: title + body + extracted text; claim: claim text; evidence card: citation + relevance note; source: name + typical topics; community interpretation: interpretation text), (3) generates the embedding vector, (4) stores it in the `Embedding` table (WS-F.3.2b) with the correct `target_type`, `target_id`, and `model_version`. If the entity already has an embedding for the current model version, update it (upsert). The pipeline uses a job queue (BullMQ/Redis) with retry logic (3 retries, exponential backoff). Embedding generation does not block the API response -- it runs asynchronously after the entity is created.

**Acceptance criteria:**
- Story creation triggers async embedding generation.
- Claim creation triggers async embedding generation.
- Evidence card creation triggers async embedding generation.
- Embeddings are stored with the correct target_type, target_id, and model_version.
- Duplicate embeddings for the same entity and model version are upserted (not duplicated).
- Failed jobs are retried up to 3 times with exponential backoff.
- Embedding generation does not block API responses (async pipeline).
- Model version is recorded so embeddings can be re-generated when the model is upgraded.

**Testing:**
- Integration: Create a story, wait for job processing, verify embedding exists in the database with correct dimensionality and target references. Create a claim, verify embedding. Update a story, verify embedding is updated.
- Unit: Text extraction logic for each entity type. Job queue retry logic.

---

### WS-F.3.2d Similarity query optimization
**ID:** WS-F.3.2d
**Ref:** Sections 7 (MERI), 10 (SCOI)

**Description:**
Implement optimized similarity query functions for MERI and SCOI use cases. Create query helpers in `packages/db/`: (1) `findSimilarStories(storyId, threshold, limit)` -- find stories with cosine similarity above the threshold (for MERI duplicate/independence checking), filtered by `target_type: story`. (2) `findSimilarClaims(claimId, threshold, limit)` -- find claims with similar embeddings (for MERI claim-level independence). (3) `findSimilarInterpretations(storyId, threshold, limit)` -- find community interpretations for the same story that differ significantly (for SCOI -- identify interpretation divergence by finding interpretations with low similarity). (4) `findNearestEvidenceCards(claimId, limit)` -- find evidence cards most relevant to a claim. All queries use the pgvector ANN index and return results with similarity scores. Queries include filters to exclude the source entity itself and to scope results to active (non-deleted) entities.

**Acceptance criteria:**
- `findSimilarStories` returns stories above the similarity threshold, ordered by similarity.
- `findSimilarClaims` returns claims above the threshold for MERI independence analysis.
- `findSimilarInterpretations` identifies divergent interpretations for SCOI (low similarity = high obstruction potential).
- `findNearestEvidenceCards` returns the most semantically relevant evidence for a claim.
- All queries use the ANN index (verified via EXPLAIN ANALYZE).
- Queries exclude the source entity and deleted entities.
- Query latency is < 100ms at p99 for datasets up to 100K embeddings.
- Similarity scores are returned alongside results for downstream use.

**Testing:**
- Integration: Insert known embeddings with known similarities. Verify `findSimilarStories` returns the correct results above threshold. Verify `findSimilarInterpretations` identifies divergent interpretations. Verify index usage.
- Performance: Benchmark query latency with 10K, 50K, and 100K embeddings. Verify sub-100ms p99.
