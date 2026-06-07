# WS-F: Ingestion, Source Model, and Search

**Milestone:** M1
**Priority:** P1
**Dependencies:** WS-D.1 (accounts and authentication), packages/db (Drizzle ORM)
**Wave:** 3-4
**Estimated duration:** 3 weeks

---

## Overview

WS-F builds the content pipeline that feeds everything downstream: stories enter the system, are deduplicated and normalized, receive source and claim metadata, and become searchable. Every story creates a thread shell. Duplicate detection operates at three levels -- exact URL match, near-duplicate text similarity, and syndicated copy detection -- to prevent MERI-violating content floods before they reach the ranking pipeline. Search uses PostgreSQL full-text indexing for keyword queries and pgvector for embedding-based similarity, which later powers MERI independence checks and SCOI interpretation comparison. No ranking influence from wallet or payment data touches any table in this workstream (Section 21.5).

This workstream realizes the Section 14.2 ingestion pipeline end to end: normalize URL and canonical source; detect duplicates and syndicated copies; extract metadata, author, date, publisher, and primary media type; generate a candidate claim list; classify topic, location, language, sensitivity, and source type; compute embeddings and similarity links; run initial safety checks; initialize MERI/SCOI/cascade-tracking state; and create the story card and thread shell. It also realizes the Section 14.3 source model (context and history, never a "truth score") and the Section 14.4 story lifecycle state machine. Copyright-aware display and a mandatory takedown intake path are first-class, not afterthoughts.

WS-F is a producer for several downstream workstreams, and the IDs below are referenced verbatim by their dependency tables:

- **WS-G (Forum):** `WS-F.1.1` (story schema for the `story_id` FK), `WS-F.1.2` (claims schema for contribution targeting and the claim-evidence graph), and the thread shell from `WS-F.1.4d`.
- **WS-H (Invariants):** `WS-F.1` (URL canonicalization and source/claim profiles for MERI), `WS-F.2` (source model/history), `WS-F.3.2` (embeddings for MERI/SCOI), and `WS-F.1` sensitivity labels for PHI.
- **WS-I (Ranking):** `WS-F.1` (story/claim schema), `WS-F.2` (source model), and `WS-F.1.4` (freshness baseline for the cold-start mitigation in the risk matrix and the WS-I.2.3d baseline computation).
- **WS-K (AI governance):** `WS-F.1` ingestion and claims for the topic-classification and claim-extraction pipelines.

### Workstream conventions

- **Schema isolation:** All WS-F tables live in the default content/social schema. No table in this workstream may contain wallet, payment, donation, treasury, governance, or any other financial field (Section 21.5, Section 13.6). A CI assertion (WS-F.2.5b) verifies the column set against a financial-term denylist.
- **No truth scores:** Per Section 14.3, the source model exposes context and history (correction history, evidence-type frequency, syndication lineage) and must never compute or surface a simplistic "truth score," "credibility score," or "reliability percentage" as a user-facing number that substitutes for reader judgment.
- **Crawling discipline:** Every fetch (metadata extraction, embedding text retrieval) respects robots.txt and publisher restrictions (Section 14.2). Copyright-aware display (excerpt/quote limits, attribution, canonical-link-out) and a takedown intake path are mandatory.
- **Determinism and reversibility:** Each task is independently reviewable, testable, and reversible (Section 30.8). Schema tasks ship with up/down migrations; pipeline tasks ship behind a job-queue boundary so they can be paused without blocking the API.

---

## WS-F.1 Story ingestion

### WS-F.1.1a Story Drizzle schema
**ID:** WS-F.1.1a
**Ref:** Sections 22.1, 14.4

**Description:**
Define the `Story` entity in Drizzle ORM in `packages/db/src/schema/story.ts`, matching the Section 22.1 core entity: `story_id` (UUID PK, generated), `canonical_url` (text, nullable -- null for non-link submission types; unique index when present), `title` (text, non-null), `submitted_by` (UUID FK -> `user.user_id`), `source_id` (UUID FK -> `source.source_id`, nullable until the source profile is resolved/created), `language` (text, BCP 47), `topic_ids` (UUID array, at least one), `location_scope` (JSONB, nullable -- structured `{ type: 'global' | 'country' | 'region' | 'city', value }`), `sensitivity_labels` (text array -- subset of `none | graphic | medical | political | crisis`), `lifecycle_state` (enum, see WS-F.1.1c), `submission_type` (enum: `link | original_brief | question | evidence_card | local_update | live_thread`), `submission_metadata` (JSONB -- the type-specific payload validated by WS-F.1.4b), `created_at`, `updated_at` (timestamptz). Add a partial unique index `unique(canonical_url) where canonical_url is not null`, a B-tree index on `source_id`, a GIN index on `topic_ids`, and an index on `(lifecycle_state, updated_at)` for lifecycle sweeps and freshness queries.

```ts
export const story = pgTable('story', {
  storyId: uuid('story_id').primaryKey().defaultRandom(),
  canonicalUrl: text('canonical_url'),                       // null for non-link types
  title: text('title').notNull(),
  submittedBy: uuid('submitted_by').notNull().references(() => user.userId),
  sourceId: uuid('source_id').references(() => source.sourceId), // resolved post-ingest
  language: text('language'),                                // BCP 47, e.g. 'en', 'pt-BR'
  topicIds: uuid('topic_ids').array().notNull(),
  locationScope: jsonb('location_scope'),                    // { type, value } | null
  sensitivityLabels: text('sensitivity_labels').array().notNull().default([]),
  lifecycleState: storyLifecycleEnum('lifecycle_state').notNull().default('submitted'),
  submissionType: submissionTypeEnum('submission_type').notNull(),
  submissionMetadata: jsonb('submission_metadata').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
}, (t) => ({
  canonicalUrlUq: uniqueIndex('story_canonical_url_uq')
    .on(t.canonicalUrl).where(sql`${t.canonicalUrl} is not null`),
  sourceIdx: index('story_source_idx').on(t.sourceId),
  topicGin: index('story_topic_gin').using('gin', t.topicIds),
  lifecycleIdx: index('story_lifecycle_idx').on(t.lifecycleState, t.updatedAt),
}));
// No wallet/payment/treasury/donor columns may ever be added here (Section 21.5, 13.6).
```

**Acceptance criteria:**
- Migration applies cleanly and rolls back without data loss.
- All column types match the Section 22.1 `Story` entity; `submission_type` and `submission_metadata` are added to carry the Section 14.1 payload.
- Partial unique index on `canonical_url` permits many rows with `null` (non-link types) but rejects duplicate non-null canonical URLs.
- GIN index on `topic_ids` and B-tree on `source_id` exist; `(lifecycle_state, updated_at)` index exists.
- No financial/wallet/payment column is present.
- Insert, select, and update round-trip correctly in a Vitest integration test.

**Testing:**
- Integration: Migration up/down cycle. Insert link and non-link stories. Verify the partial unique index allows multiple null canonical URLs but rejects a duplicate non-null one. Verify GIN index usage for a topic-array containment query via EXPLAIN.
- Unit: Schema column-set assertion confirms no financial fields.

**Security considerations:**
- `submitted_by` ties content to an account for moderation and rate-limiting; it is never exposed in search ranking as an authority signal (Section 13.6 -- no reputation-based boost). `submission_metadata` is free-form JSONB and must be validated by zod (WS-F.1.1b/WS-F.1.4b) before persistence to prevent injection of unexpected keys.

**Dependencies:** WS-D.1 (User table for `submitted_by`), WS-F.2.1a (Source table for the `source_id` FK -- nullable until resolved), WS-F.1.1c (lifecycle enum), WS-F.1.4b (submission-type enum and metadata shape).

---

### WS-F.1.1b Story zod schema and DTOs
**ID:** WS-F.1.1b
**Ref:** Sections 22.1, 23.1

**Description:**
Define the runtime `zod` schemas co-located with the Story route types in `packages/shared/src/schema/story.ts` (Section 23.1: compile-time and runtime contracts cannot diverge). Provide: `StorySelect` (full row), `StoryPublic` (API-safe projection that omits any internal-only fields), and `StoryCreateInput` (the request body, delegating the type-specific portion to the WS-F.1.4b discriminated union). Enforce: `title` length bounds (e.g., 1-300 chars), `language` is a valid BCP 47 tag, `topic_ids` is a non-empty array of UUIDs, `sensitivity_labels` is a subset of the allowed enum, and `location_scope` matches the structured shape. Export inferred TypeScript types so handlers and the client share one definition.

**Acceptance criteria:**
- `StoryCreateInput` rejects empty titles, over-length titles, empty `topic_ids`, invalid BCP 47 tags, and unknown `sensitivity_labels`.
- `StoryPublic` never includes internal-only fields (e.g., raw extraction diagnostics, moderation flags).
- Inferred types match the Drizzle row types (a type-level test asserts assignability).
- Strict parsing strips unknown keys.

**Testing:**
- Unit: Valid and invalid inputs for each field bound. BCP 47 acceptance for 5+ tags and rejection of malformed tags. Subset enforcement for `sensitivity_labels`.
- Type: Compile-time assertion that the zod-inferred type is assignable to the Drizzle select type.

**Security considerations:**
- The `StoryPublic` projection is the only shape returned by read endpoints; this prevents accidental leakage of internal extraction or moderation metadata to clients.

**Dependencies:** WS-F.1.1a (Story Drizzle schema), WS-F.1.4b (submission-type discriminated union).

---

### WS-F.1.1c Story lifecycle state machine
**ID:** WS-F.1.1c
**Ref:** Section 14.4

**Description:**
Implement the Section 14.4 story lifecycle as an explicit, auditable state machine in `packages/db` (or a dedicated service module). States and transitions:

`submitted -> gathering_attention -> deepening -> context_needed -> bridging -> stable -> archived`,
plus the realistic non-linear edges the spec implies: `gathering_attention -> deepening`, `deepening -> context_needed` (when SCOI obstruction or evidence gaps are elevated), `context_needed -> bridging` (when divergent lenses are being reconciled), `bridging -> stable`, `deepening -> stable` (no context issue), `stable -> deepening` (renewed activity), any active state `-> archived` (sustained low activity), and `archived -> deepening` (reactivation on new activity). Each transition is driven by signals supplied by other services (attention aggregates from WS-E, SCOI/MERI from WS-H, evidence completeness from WS-G) and writes a `thread.state.changed`-adjacent story-lifecycle audit record (`story_id`, `from_state`, `to_state`, `trigger`, `actor` which may be `system`, `created_at`). The transition function is pure given (current state, trigger) and rejects illegal transitions with a typed error. Lifecycle changes never depend on wallet/payment/treasury state.

**State transition table (authoritative):**

| From \ To | gathering_attention | deepening | context_needed | bridging | stable | archived |
|---|---|---|---|---|---|---|
| **submitted** | ✅ first attention | ❌ | ❌ | ❌ | ❌ | ✅ stale/no activity |
| **gathering_attention** | — | ✅ sustained participation | ❌ | ❌ | ❌ | ✅ low activity |
| **deepening** | ❌ | — | ✅ SCOI/evidence gap | ❌ | ✅ resolved cleanly | ✅ low activity |
| **context_needed** | ❌ | ❌ | — | ✅ lens reconciliation | ✅ context added | ✅ low activity |
| **bridging** | ❌ | ❌ | ✅ regressed | — | ✅ reconciled | ✅ low activity |
| **stable** | ❌ | ✅ renewed activity | ❌ | ❌ | — | ✅ low activity |
| **archived** | ❌ | ✅ reactivation | ❌ | ❌ | ❌ | — |

Any cell not marked ✅ is rejected with `INVALID_LIFECYCLE_TRANSITION`.

**Acceptance criteria:**
- All valid transitions are accepted and produce an audit record; invalid transitions are rejected with a typed error code.
- `context_needed` is only reachable from `deepening` or `bridging` (regression), driven by an SCOI/evidence-gap trigger.
- `archived` is reachable from any active state on a low-activity trigger; reactivation routes to `deepening`.
- The transition function is deterministic given (state, trigger) and has no dependency on financial state.
- Every transition writes an audit record with `from_state`, `to_state`, `trigger`, and `actor`.

**Testing:**
- Unit: Every valid transition pair is accepted; a representative set of invalid pairs is rejected. Reactivation from `archived` routes to `deepening`. Determinism: same (state, trigger) yields the same result.
- Integration: Drive a story through `submitted -> gathering_attention -> deepening -> context_needed -> bridging -> stable -> archived` and assert the audit trail is complete and ordered.

**Observability:**
- Emit a counter per transition labeled by `from_state`/`to_state` and a histogram of dwell time in each state, so cold-start and "stuck in context_needed" pathologies are visible on a dashboard.

**Security considerations:**
- Lifecycle is a content-health signal, not a financial or authority signal. The trigger source must be restricted to system services and authorized stewards; clients cannot force a transition (e.g., to fake "stable" status).

**Dependencies:** WS-F.1.1a (Story schema), WS-E (attention aggregates as triggers -- soft, lifecycle degrades gracefully without them), WS-H.4 (SCOI signal for `context_needed`, soft), WS-G (evidence-completeness signal, soft).

---

### WS-F.1.2a Claim Drizzle and zod schema
**ID:** WS-F.1.2a
**Ref:** Sections 22.3, 21.1, 14.2

**Description:**
Define the `Claim` entity, which the Section 22.3 relationship graph references ("Claim supported-by / challenged-by Evidence"; "Contribution clarifies Claim") and the Section 21.1 "source and claim" service owns. Create `packages/db/src/schema/claim.ts`: `claim_id` (UUID PK), `story_id` (UUID FK -> `story.story_id`, nullable -- a claim may be shared across stories), `canonical_text` (text -- the normalized claim statement), `claim_status` (enum: `candidate | accepted | contested | retracted` -- lifecycle of the claim itself), `first_seen_story_id` (UUID FK, nullable), `independence_group_id` (UUID, nullable -- shared with `EvidenceCard.independence_group_id` so MERI can group non-independent claim/evidence lineages), `created_by` (UUID FK, nullable -- system-extracted claims have null), `extraction_source` (enum: `system | user | steward`), `created_at`, `updated_at`. Add a B-tree index on `story_id`, an index on `claim_status`, and an index on `independence_group_id`. Define the co-located zod schema in `packages/shared/`.

**Acceptance criteria:**
- Migration applies cleanly and rolls back.
- A claim can exist without a story (`story_id` nullable) to support cross-story claims.
- `claim_status` enum enforces exactly the four defined values.
- `independence_group_id` is present and indexed for MERI grouping and is shared semantically with `EvidenceCard.independence_group_id`.
- Zod schema validates claim text length and enum values.
- Insert/select/update round-trip in an integration test.

**Testing:**
- Unit: Zod accepts valid claims and rejects invalid status/empty text.
- Integration: Migration up/down. Insert system-extracted and user-authored claims. Query claims by story and by status.

**Security considerations:**
- Claims are public content artifacts; the `created_by` link is for moderation/attribution and is never used as a ranking authority signal (Section 13.6).

**Dependencies:** WS-F.1.1a (Story schema for the FK), WS-F.2.5a (EvidenceCard schema -- shares `independence_group_id` semantics; either may land first, the shared concept is documented in both).

---

### WS-F.1.2b Candidate claim extraction
**ID:** WS-F.1.2b
**Ref:** Section 14.2, WS-K (AI governance)

**Description:**
Generate a candidate claim list during ingestion (Section 14.2: "generate a candidate claim list"). After story content is extracted (WS-F.1.4e), an async worker calls the claim-extraction model registered and governed by WS-K (the actual model lives in WS-K.1.3b; this task is the WS-F producer that persists results). The worker: (1) submits story title + body text to the extraction service, (2) receives candidate claims with confidence scores, (3) persists each as a `Claim` row with `claim_status: candidate`, `extraction_source: system`, and a confidence captured in the WS-K output record, (4) deduplicates against existing claims for the same story by normalized text and (later) embedding similarity (WS-F.3.2), linking to an existing claim rather than creating a duplicate. Sub-threshold or low-confidence extractions are routed to the WS-K review queue (WS-K.1.3c) rather than auto-accepted. Extraction failure is non-blocking: the story exists with zero candidate claims and is flagged for retry.

**Acceptance criteria:**
- Story creation triggers async candidate-claim extraction (no blocking of the submission response).
- Candidate claims are persisted with `claim_status: candidate` and `extraction_source: system`.
- Duplicate candidate claims for the same story are linked to an existing claim, not duplicated.
- Low-confidence candidates are routed to the WS-K review queue, not auto-accepted.
- Extraction failure does not block story creation; the story is flagged for retry.

**Testing:**
- Integration: Submit a story with a mocked extractor returning N claims; verify N candidate claims persisted with correct status/source. Submit content that produces a near-duplicate claim; verify linkage instead of duplication. Force extractor failure; verify story still exists and is flagged.
- Unit: Deduplication/linking logic against existing claims.

**Security considerations:**
- Extracted claims are model output and must carry provenance (model version via WS-K's output record) so a faulty model version's claims can be identified and re-run. No claim text is trusted as fact -- claims are `candidate` until human/steward review per WS-K.

**Dependencies:** WS-F.1.1a (Story), WS-F.1.2a (Claim schema), WS-F.1.4e (extracted text), WS-K.1.3b (claim-extraction model), WS-K.1.1f (model output record), WS-K.1.3c (review queue), WS-F.3.2c (embeddings for similarity-based dedup -- soft; exact-text dedup works without it).

---

### WS-F.1.3a URL normalization
**ID:** WS-F.1.3a
**Ref:** Section 14.2

**Description:**
Implement a URL normalization function in `packages/shared/src/utils/url.ts`. The function accepts a raw URL and returns a canonical form by applying the following transformations in order: (1) parse the URL (reject malformed URLs), (2) normalize the scheme to `https` (upgrade `http` to `https`; reject non-http(s) schemes), (3) normalize the host to lowercase, (4) remove `www.` prefix if present, (5) remove default ports (80, 443), (6) normalize the path: lowercase, remove trailing slash (except for root `/`), resolve `.` and `..` segments, (7) remove tracking query parameters: `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `utm_id`, `fbclid`, `gclid`, `msclkid`, `twclkd`, `dclid`, `mc_cid`, `mc_eid`, `ref`, `ref_src`, `ref_url` and other common tracking parameters from a configurable denylist, (8) sort remaining query parameters alphabetically, (9) remove the fragment (hash). The denylist is configurable and stored in the application configuration (not hardcoded) so new trackers can be added without a code deployment.

**Tracking-parameter denylist (initial, configurable):** `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `utm_id`, `utm_name`, `utm_cid`, `utm_reader`, `utm_referrer`, `fbclid`, `gclid`, `gclsrc`, `dclid`, `gbraid`, `wbraid`, `msclkid`, `twclkd`, `twclid`, `igshid`, `igsh`, `mc_cid`, `mc_eid`, `yclid`, `_openstat`, `oly_anon_id`, `oly_enc_id`, `vero_id`, `vero_conv`, `wickedid`, `s_kwcid`, ` ref`, `ref_`, `ref_src`, `ref_url`, `referrer`, `source`, `cmpid`, `campaign_id`, `spm`, `scm`, `__twitter_impression`, `guccounter`, `guce_referrer`, `guce_referrer_sig`. Entries are matched case-insensitively; prefix entries (e.g., `utm_`) may be expressed as a configurable prefix rule.

**Normalization edge cases (must be specified and tested):** IDN/punycode hosts normalize consistently (`xn--` form is canonical; do not mix Unicode and ASCII forms); percent-encoding is normalized to uppercase hex and unreserved characters are decoded; duplicate query keys are preserved in sorted order (not collapsed) unless the key is on the denylist; userinfo (`user:pass@`) is stripped for safety; an empty query after stripping yields no `?`; default ports for the scheme are removed but non-default ports are preserved.

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
- IDN/punycode hosts and percent-encoding normalize deterministically per the edge-case rules.

**Testing:**
- Unit: Comprehensive test suite with at least 30 URL normalization cases covering: protocol normalization, www removal, case normalization, trailing slash removal, tracking parameter stripping (each parameter individually), parameter sorting, fragment removal, default port removal, path normalization, malformed URL rejection, non-http scheme rejection, Unicode/punycode domain handling, percent-encoding normalization, URLs with authentication components (stripped for safety), and non-default port preservation.
- Property-based: `normalize(normalize(url)) === normalize(url)` (idempotency); for any URL differing only by denylisted params or fragment, the normalized output is identical.

**Security considerations:**
- Rejecting `javascript:`, `data:`, and other non-http(s) schemes prevents stored-XSS/open-redirect vectors from entering via the canonical URL. Stripping userinfo prevents credential leakage and phishing-style `https://bank.com@evil.com` confusion.

**Dependencies:** None (pure utility); consumed by WS-F.1.3b, WS-F.1.1a (canonical URL storage), WS-H.2.1a (MERI URL canonicalization).

---

### WS-F.1.3b Exact-URL duplicate detection
**ID:** WS-F.1.3b
**Ref:** Section 14.2

**Description:**
Implement post-canonicalization exact-URL duplicate detection. When a story is submitted, the canonical URL (from WS-F.1.3a) is looked up against the `canonical_url` index on the `Story` table (WS-F.1.1a). If an exact match is found: (1) do not create a new story, (2) return a 409 Conflict response with the existing story's ID and a redirect suggestion, (3) log the duplicate detection (submission user, existing story ID, timestamp) for analytics. If no match, proceed with story creation. The lookup uses the existing partial unique index on `canonical_url` for O(log n) performance.

**Acceptance criteria:**
- Submitting a URL that normalizes to the same canonical URL as an existing story returns 409 with the existing story ID.
- The response includes a link to the existing story so the user can participate in the existing thread.
- Different URLs that normalize to the same canonical form are correctly detected as duplicates (e.g., `http://example.com/path?utm_source=x` and `https://example.com/path`).
- URLs that are genuinely different (different paths, different query parameters that are not trackers) are not flagged as duplicates.
- Duplicate detection uses the database index (no full table scan).
- Detection latency is < 50ms at p99 for databases with up to 1 million stories.

**Testing:**
- Integration: Submit a URL. Submit the same URL with different tracking parameters -- verify 409. Submit a different URL -- verify 201. Verify the existing story ID is returned in the duplicate response.
- Performance: Benchmark duplicate lookup with 100K and 1M story fixtures; assert index usage via EXPLAIN.

**Security considerations:**
- The duplicate response intentionally redirects to existing public content only; it must not leak whether a story exists in a private/restricted room the user cannot access (return the same 409 shape without privileged detail if the existing story is not visible to the requester).

**Dependencies:** WS-F.1.3a (URL normalization), WS-F.1.1a (Story table and `canonical_url` index).

---

### WS-F.1.3c Near-duplicate text detection
**ID:** WS-F.1.3c
**Ref:** Section 14.2

**Description:**
Implement near-duplicate text detection using shingling and MinHash. After a story is submitted and its content is extracted (title + body text), compute a set of character-level n-gram shingles (k=5), then compute a MinHash signature (128 hash functions). Compare the MinHash signature against existing stories using Locality-Sensitive Hashing (LSH) with a Jaccard similarity threshold of 0.7 (configurable). If a near-duplicate is found: (1) flag the submission for review (do not auto-reject -- the submitter may have a valid reason, such as adding commentary), (2) include the similar stories in the review context, (3) a steward or automated rule can merge, link, or allow the submission. Store MinHash signatures in the database for future comparisons. The comparison scales sub-linearly via LSH bands (not pairwise comparison).

**Storage and parameters (must be specified):** persist the MinHash signature in a `StorySignature` table (`story_id` FK, `minhash` integer array / bytea, `shingle_k`, `num_hashes`, `created_at`) and the LSH bands in a banded index structure (e.g., `band_index`, `band_hash`, `story_id`) so candidate retrieval is `O(bands)` lookups, not a scan. Choose `b` bands of `r` rows with `b * r = 128` tuned so the LSH S-curve threshold approximates the configured Jaccard threshold (e.g., `b=32, r=4` for a ~0.7 crossover). Document the chosen `(b, r)` and the resulting probability-of-detection curve.

**Acceptance criteria:**
- Articles with >= 70% text overlap are flagged as near-duplicates.
- Articles with < 50% overlap are not flagged.
- Near-duplicate detection returns the IDs of similar existing stories.
- The submitter is informed that a similar story exists and given the option to add their submission as a contribution to the existing thread.
- MinHash signatures are stored for future comparisons.
- LSH ensures sub-linear scaling (not O(n) pairwise comparison against all stories).
- The similarity threshold is configurable, and the `(b, r)` banding is documented with its detection curve.

**Testing:**
- Unit: Compute MinHash for known texts with known overlap percentages. Verify flagging at threshold. Verify no flagging below threshold. Verify the estimated Jaccard from MinHash approximates the true Jaccard within tolerance.
- Integration: Submit a story, then submit a paraphrased version (70%+ overlap) -- verify flagged. Submit an unrelated story -- verify not flagged.
- Performance: Benchmark LSH lookup with 100K signatures; assert band lookups, not a full scan.

**Security considerations:**
- Flag-for-review (not auto-reject) avoids suppressing legitimate commentary/duplication and avoids a denial-of-publication vector where an attacker pre-submits content to block a later legitimate submission. Steward review is the safeguard.

**Dependencies:** WS-F.1.1a (Story), WS-F.1.4e (extracted text), WS-J.2 (steward review queue for flagged near-duplicates). Shares the MinHash approach with WS-H.2.1a (MERI near-duplicate grouping) -- both reference the same shingling/MinHash technique.

---

### WS-F.1.3d Syndicated copy detection
**ID:** WS-F.1.3d
**Ref:** Section 14.2

**Description:**
Detect syndicated copies: the same content published by different publishers (e.g., an AP wire story appearing on 10 different news sites). This extends near-duplicate detection (WS-F.1.3c) with source-awareness. When a near-duplicate is detected and the `source_id` differs from the existing story's source, classify it as a potential syndicated copy rather than a user-submitted duplicate. Check for syndication relationships in the source model (WS-F.2.4: `SourceSyndication` relationships). If a known syndication relationship exists, auto-link the submission to the existing story as a syndicated source (no new story created, but the source is added to the story's source list). If no known relationship exists, flag for steward review to establish the relationship. Syndicated copies do not create independent MERI exposure -- they are grouped with the original.

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

**Security considerations:**
- Syndication auto-linking must be directional and evidence-based (WS-F.2.4) to avoid an attacker registering a bogus syndication edge to attach spam to a reputable story. New relationships require steward confirmation.

**Dependencies:** WS-F.1.3c (near-duplicate detection), WS-F.2.4 (`SourceSyndication` relationship model), WS-F.2.1a (Source table), WS-J.2 (steward review).

---

### WS-F.1.4a POST /v1/stories endpoint
**ID:** WS-F.1.4a
**Ref:** Sections 14.1, 23.2

**Description:**
Implement the `POST /v1/stories` Hono route. The endpoint accepts story submissions from authenticated users. Request body is validated against a zod schema that includes: `submission_type` (enum: `link`, `original_brief`, `question`, `evidence_card`, `local_update`, `live_thread` per Section 14.1), `url` (required for `link`, forbidden for other types), `title` (required), `body` (optional for `link`, required for `original_brief` and `question`), `topic_ids` (array, at least one required), `reason` (short text: why this is being submitted), and type-specific fields (see WS-F.1.4b). The endpoint runs URL normalization (WS-F.1.3a) and duplicate detection (WS-F.1.3b-d) before creating the story. On success, returns 201 Created with the story ID, thread ID (auto-created per WS-F.1.4d), and the story's initial lifecycle state (`submitted`). The route is registered with the Hono RPC contract (Section 23.1) so the client gets end-to-end types, and uses `SameSite=Strict` cookies with CSRF protection.

**Acceptance criteria:**
- All six submission types are accepted with correct validation per type.
- Link stories require a URL; other types reject a URL field.
- URL normalization and duplicate detection run before story creation.
- Response includes story_id, thread_id, and lifecycle_state.
- Unauthenticated requests return 401.
- Invalid submissions return 400 with field-level error details.
- The endpoint respects rate limiting (WS-F.1.4c).
- The route is part of the Hono RPC type contract and enforces CSRF.

**Testing:**
- Integration: Submit each of the six types with valid data -- verify 201. Submit with missing required fields -- verify 400. Submit unauthenticated -- verify 401. Submit a duplicate URL -- verify 409.
- E2E: Full submission flow from the client, including CSRF token handling.

**Security considerations:**
- Authorization is object-level: only authenticated accounts in good standing may submit; banned/suspended accounts are rejected. CSRF protection and `SameSite=Strict` cookies prevent cross-site submission. No financial state is read or written.

**Dependencies:** WS-D.1 (auth/session/CSRF), WS-F.1.1a/b (Story schema + zod), WS-F.1.3a-d (normalization + dedup), WS-F.1.4b (per-type validation), WS-F.1.4c (safety pre-checks), WS-F.1.4d (thread shell).

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

The zod schema uses `z.discriminatedUnion("submission_type", [...])` so validation is type-specific and error messages reference the correct required fields for the submitted type. This discriminated union is the canonical definition of `submission_metadata` (stored by WS-F.1.1a) and is re-exported for the client.

**Acceptance criteria:**
- Each submission type validates its specific required fields.
- Submitting an evidence card without a valid claim reference returns a 400 with a message about the missing claim reference.
- Submitting a link story without a URL returns a 400.
- Submitting a local update without a location scope returns a 400.
- Extra fields not defined for the submission type are stripped (strict parsing).
- The discriminated union produces clear, type-specific error messages.

**Testing:**
- Unit: Test each submission type with valid data, missing required fields, and extra fields. Verify error messages reference the correct missing field for each type.
- Integration: Submit evidence cards with valid and invalid claim references (the referenced `claim_id` must exist -- WS-F.1.2a).

**Security considerations:**
- Strict parsing (unknown-key stripping) prevents metadata-injection of unexpected fields that downstream consumers might trust. The evidence-card `claim_id` reference is validated for existence and visibility to prevent dangling or cross-tenant references.

**Dependencies:** WS-F.1.1a (stores `submission_metadata`), WS-F.1.2a (Claim table for evidence-card claim references).

---

### WS-F.1.4c Safety pre-checks
**ID:** WS-F.1.4c
**Ref:** Sections 14.2, 18.2, 25.5

**Description:**
Implement safety pre-checks that run before a story is created. Checks: (1) spam detection -- reject submissions from accounts with high submission rates (configurable: default 10 stories per hour, 50 per day), accounts younger than a configurable age threshold (default 1 hour), or submissions matching known spam patterns (repeated titles, known spam domains). (2) Malware link scanning -- for link stories, check the URL against a malware/phishing domain list (e.g., Google Safe Browsing API or a locally-maintained denylist). Reject URLs that match. (3) Rate limiting -- per-user submission rate limits (configurable, separate from global API rate limits). Rate-limited submissions return 429 with Retry-After. Pre-checks run asynchronously where possible to minimize submission latency; malware checks may add up to 500ms. This realizes the Section 18.2 "automated pre-checks" layer (obvious spam, malware links, duplicate floods).

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

**Security considerations:**
- If the malware-scanning provider is unavailable, fail toward caution for link stories (hold for review rather than silently allow a potentially malicious link), consistent with the platform's safety posture. The scanning request must send only the URL, never user attention/behavior data, to the external provider.

**Dependencies:** WS-D.1 (account age/state), WS-F.1.3b-d (duplicate-flood signal feeds spam detection), WS-J (safety policy taxonomy and review routing).

---

### WS-F.1.4d Thread shell creation
**ID:** WS-F.1.4d
**Ref:** Sections 14.2, 15

**Description:**
Automatically create a thread shell for every submitted story. When a story is created (after passing all validation and pre-checks), create a `Thread` record linked to the story: `thread_id` (UUID), `story_id` (FK), `room_id` (nullable -- assigned when the story is placed in a room), `branch_index` (0 for the initial branch), `current_summary_id` (null -- no summary yet), `conversation_state` (enum: `empty`), `safety_state` (enum: `normal`), `created_at`. The thread is the container for all contributions (questions, evidence, corrections, etc.) related to the story. The thread ID is returned in the story submission response (WS-F.1.4a). (The full `Thread`/`Contribution` schema and conversation/safety state machines are owned by WS-G.1; this task creates the minimal shell as part of the ingestion transaction.)

**Acceptance criteria:**
- Every story creation results in exactly one thread creation (transactional).
- The thread is linked to the story via `story_id` FK.
- The thread starts with `conversation_state: empty` and `safety_state: normal`.
- If story creation fails (duplicate, validation error), no orphan thread is created.
- The thread ID is included in the story creation response.
- Thread creation is part of the same database transaction as story creation.

**Testing:**
- Integration: Submit a story -- verify thread created. Query thread by story_id -- verify link. Fail a story submission (duplicate) -- verify no orphan thread. Verify transactional behavior (rollback on failure).

**Security considerations:**
- Transactional creation prevents orphan threads that could be exploited to attach content to a non-existent story. The shell carries no financial fields.

**Dependencies:** WS-F.1.1a (Story), WS-G.1.1 (Thread schema owner -- this task uses the schema; sequencing notes that the minimal shell fields must exist before WS-F ships, coordinated with WS-G.1.1).

---

### WS-F.1.4e Metadata extraction
**ID:** WS-F.1.4e
**Ref:** Section 14.2

**Description:**
Implement metadata extraction for link stories. After a link story is created, an async worker fetches the linked URL (respecting robots.txt, per Section 14.2 and WS-F.1.4f) and extracts: author name (from meta tags, JSON-LD, or byline patterns), publication date (from meta tags, JSON-LD, or Open Graph), publisher name (from domain, meta tags, or JSON-LD), primary media type (enum: article, video, podcast, dataset, report, document, image), and raw text content (for embedding generation and near-duplicate detection). Additionally, run classification: topic classification (map to existing topic taxonomy), language detection (BCP 47 code), and sensitivity classification (enum: none, graphic, medical, political, crisis -- used for content warnings and age-appropriate filtering). Store extracted metadata in the `Story` record. Extraction failures are non-blocking: the story is created with partial metadata and flagged for manual extraction.

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

**Security considerations:**
- The fetcher must mitigate SSRF: resolve and validate the target host, block requests to private/link-local/loopback IP ranges and cloud metadata endpoints (169.254.169.254), cap response size and redirects, and enforce timeouts. Fetch only the document, never credentials or internal services. Extracted HTML is parsed, never executed.

**Dependencies:** WS-F.1.1a (Story), WS-F.1.4f (robots.txt/copyright gate), WS-K.1.3a (topic classifier -- soft; falls back to "unclassified"), WS-F.1.2b (consumes extracted text), WS-F.3.2c (consumes extracted text).

---

### WS-F.1.4f Robots.txt, copyright, and takedown intake
**ID:** WS-F.1.4f
**Ref:** Sections 14.2, 18.1

**Description:**
Implement the mandatory crawling-discipline and copyright/takedown layer that Section 14.2 requires ("Crawling respects robots.txt and publisher restrictions; copyright-aware display and a takedown intake path are mandatory"). Three parts: (1) **robots.txt compliance** -- before any fetch (WS-F.1.4e, WS-F.3.2 text retrieval), fetch and cache the origin's `robots.txt`, parse it, and honor `Disallow` rules for the configured user-agent; cache with a TTL and re-fetch on expiry; if `robots.txt` disallows a path, skip the fetch and mark the story as link-only (no extracted body, no embedding from fetched text). Honor crawl-delay and publisher meta directives (`noindex`, `noarchive`) for display. (2) **Copyright-aware display** -- store and render only a bounded excerpt/quote (configurable character/word limit) plus attribution and a canonical link-out to the publisher; never store or display the full article body for redistribution; record the publisher's display restrictions. (3) **Takedown intake** -- a `TakedownRequest` entity (`takedown_id`, `target_type` (story/source/evidence), `target_id`, `requester_contact`, `legal_basis` (copyright/DMCA, privacy, court order, other), `claim_detail`, `status` (received/under_review/actioned/rejected), `created_at`) and an intake endpoint/queue routed to moderation (WS-J.2); actioned takedowns hide/remove the target with an audit record and notify the affected submitter where appropriate.

**Acceptance criteria:**
- robots.txt is fetched, parsed, cached with a TTL, and honored for the configured user-agent; disallowed paths are never fetched.
- A disallowed URL produces a link-only story (no extracted body, no fetched-text embedding) rather than a fetch attempt.
- Stored/displayed content for link stories is limited to a bounded excerpt plus attribution and canonical link-out; full-body redistribution is not possible.
- `noindex`/`noarchive` publisher directives are recorded and respected in display.
- A takedown request can be submitted with structured fields and is routed to the moderation queue.
- Actioning a takedown hides/removes the target, writes an audit record, and (where appropriate) notifies the submitter.

**Testing:**
- Unit: robots.txt parser honors `Disallow`/`Allow`/`Crawl-delay` and user-agent matching for representative files. Excerpt truncation respects the configured limit.
- Integration: Submit a link whose path is disallowed -- verify no fetch and link-only story. Submit a takedown -- verify queue routing; action it -- verify removal + audit + notification.

**Security considerations:**
- The takedown path is a potential abuse vector (false takedowns to censor content); requests require review (WS-J.2) before action, and rejections/actions are auditable. robots.txt and copyright limits reduce legal risk and respect publisher rights, a compliance requirement, not a nicety.

**Dependencies:** WS-F.1.1a (Story), WS-F.1.4e (gates extraction fetches), WS-F.3.2c (gates fetched-text embedding), WS-J.2 (moderation queue for takedowns), WS-F.2.1a (Source restrictions storage).

---

### WS-F.1.4g Freshness baseline
**ID:** WS-F.1.4g
**Ref:** Sections 14.4, 13.2

**Description:**
Compute and expose a per-story (and per-topic) **freshness baseline** used by ranking to mitigate cold start (referenced as `WS-F.1.4` in the index risk matrix and consumed by WS-I.2.3d baseline computation). The baseline captures, without any financial input: time since submission, time since last material update (new contribution/evidence/claim), recency of the underlying event (`location_scope`/event time where available), and a topic-level activity baseline (typical fresh-content rate for the topic) so that "fresh" is judged relative to a topic's normal cadence rather than absolute time. The output is a small, versioned feature record (`story_id`, `freshness_score`, `topic_baseline_ref`, `computed_at`, `feature_version`) recomputed on relevant events and on a periodic sweep. Candidate generation uses this to preserve the Section 13.2 minimum quota of fresh content; it is explicitly independent of likes, follower counts, wallet activity, payments, and donor status.

**Acceptance criteria:**
- A freshness baseline record is produced per story and updated on material-update events and on a periodic sweep.
- The baseline incorporates topic-level activity so freshness is relative to topic cadence.
- The feature record is versioned (`feature_version`) for reproducibility and re-computation.
- The computation reads no wallet/payment/treasury/donor fields (verified by the same denylist check as the feature store).
- Output is consumable by WS-I.2.3d via a stable interface.

**Testing:**
- Unit: Freshness score monotonicity (newer/more-recently-updated stories score fresher, all else equal); topic-baseline normalization behaves correctly for high- vs low-cadence topics.
- Integration: Submit stories across topics and times; verify baseline values and updates on new contributions; verify no financial field is read.

**Observability:**
- Dashboard the distribution of freshness scores per topic and the fresh-content supply, so personalization-collapse / cold-start conditions are detectable (supports the WS-I.1.1b diversity quota).

**Security considerations:**
- Because this feeds ranking, the no-pay-to-rank invariant applies: the baseline must be provably free of financial inputs and is covered by the financial-field denylist test.

**Dependencies:** WS-F.1.1a (Story), WS-F.1.1c (lifecycle/update signals), WS-F.2.1a (topic/source context), WS-E (activity events -- soft), consumed by WS-I.2.3d.

---

## WS-F.2 Source model

### WS-F.2.1a Source Drizzle and zod schema
**ID:** WS-F.2.1a
**Ref:** Sections 14.3, 22.3

**Description:**
Define the `Source` entity per Section 14.3 ("Source profiles contain: name and canonical domain; ownership/publisher lineage when known; typical topics; correction history within Licio; evidence-type frequency; community notes and context cards; known syndication relationships") and the Section 21.1 "source and claim" service. Create `packages/db/src/schema/source.ts`: `source_id` (UUID PK), `name` (text), `canonical_domain` (text, unique where present, nullable for non-web sources), `publisher_lineage` (JSONB, nullable -- ownership/parent-org chain when known), `typical_topics` (UUID array), `correction_history_ref` (JSONB/array -- references to corrections recorded within Licio), `evidence_type_frequency` (JSONB -- counts by evidence type observed for this source), `display_restrictions` (JSONB -- robots/copyright directives from WS-F.1.4f), `created_at`, `updated_at`. Add a unique index on `canonical_domain` (partial, where non-null) and a GIN index on `typical_topics`. Define the co-located zod schema. The schema must NOT contain any "truth score," "credibility score," or single reliability number (Section 14.3).

**Acceptance criteria:**
- Migration applies cleanly and rolls back.
- All Section 14.3 profile fields are represented; no "truth score"/single reliability number field exists.
- `canonical_domain` is uniquely indexed where present and allows null for non-web sources.
- `correction_history_ref` and `evidence_type_frequency` capture history/context, not a summary judgment.
- Zod schema validates structure; insert/select/update round-trip.

**Testing:**
- Unit: Zod accepts valid sources; rejects malformed lineage/frequency shapes. A schema-shape assertion confirms the absence of any truth/credibility/reliability scalar field.
- Integration: Migration up/down. Insert web and non-web sources. Query by domain and by topic.

**Security considerations:**
- The absence of a truth score is a doctrine requirement (Section 14.3): the source model exposes context and history so readers judge for themselves; a single score would invite gaming and is prohibited. Ownership lineage is factual metadata, not a ranking authority input (Section 13.6).

**Dependencies:** WS-F.1.4f (display restrictions), referenced by WS-F.1.1a (`source_id` FK), WS-H/WS-I (source model/history inputs).

---

### WS-F.2.2a Automatic source profile creation
**ID:** WS-F.2.2a
**Ref:** Section 14.3

**Description:**
Create source profiles automatically on first ingestion. When a link story is submitted, resolve its `canonical_domain` (from the canonical URL) and look up an existing `Source`. If none exists, create one with `name` and `canonical_domain` from extraction (WS-F.1.4e), seed `typical_topics` from the story's topics, and link the story's `source_id`. Resolution is idempotent (concurrent submissions for the same new domain create exactly one source). For non-link submissions (original brief, question, local update), no web source is created; the story's `source_id` remains null (the author is the submitter, tracked via `submitted_by`). As more stories arrive for a source, `typical_topics` and `evidence_type_frequency` are updated incrementally.

**Acceptance criteria:**
- First link story for a new domain creates exactly one `Source` and links `source_id`.
- Concurrent first-submissions for the same domain do not create duplicate sources (idempotent upsert on `canonical_domain`).
- Subsequent stories for the same domain reuse the source and update `typical_topics`/`evidence_type_frequency`.
- Non-link submissions do not create a web source.

**Testing:**
- Integration: Submit two stories from a new domain concurrently -- verify one source. Submit a third -- verify topic/frequency update. Submit an original brief -- verify no source created.
- Unit: Domain resolution and idempotent upsert logic.

**Security considerations:**
- Idempotent upsert prevents a duplicate-source race that could split a source's history/correction record. No financial fields are written.

**Dependencies:** WS-F.2.1a (Source schema), WS-F.1.1a (Story), WS-F.1.4e (extracted publisher/name), WS-F.1.3a (canonical domain).

---

### WS-F.2.3a Steward source profile editing
**ID:** WS-F.2.3a
**Ref:** Sections 14.3, 18.2

**Description:**
Allow stewards (and staff) to edit source profiles, with audit. (Section 33 open question 3 notes editability may be stewards, staff, or both; this task implements the steward+staff path with role checks and a complete audit trail.) Editable fields: `name`, `publisher_lineage`, `typical_topics`, `display_restrictions`, and curated community notes/context references; `correction_history_ref` and `evidence_type_frequency` are append-mostly (corrections are added with provenance, not silently rewritten). Every edit writes an immutable audit record (`source_id`, `editor`, `field`, `before`, `after`, `reason`, `edited_at`). Edits are permission-gated and rate-limited. No edit may introduce a "truth score" field.

**Acceptance criteria:**
- Stewards/staff with the appropriate role can edit the allowed fields; other users receive 403.
- Every edit produces an immutable, append-only audit record with before/after, editor, reason.
- `correction_history_ref` is append-mostly with provenance; corrections are not silently overwritten.
- The edit API cannot add a truth/credibility scalar field (rejected by schema and validation).

**Testing:**
- Unit: Permission checks reject non-stewards. Audit record creation with before/after.
- Integration: Edit a source as a steward -- verify change + audit. Attempt as a regular user -- verify 403. Append a correction -- verify provenance preserved.

**Security considerations:**
- Source profiles influence reader judgment and (indirectly, via context) the product; edit access must be limited and fully auditable to prevent manipulation of a source's reputation/context. Audit immutability supports later review of disputed edits.

**Dependencies:** WS-F.2.1a (Source schema), WS-A.2 (steward roles/permissions), WS-J.2 (steward console surface for editing).

---

### WS-F.2.4 Source syndication relationships
**ID:** WS-F.2.4
**Ref:** Sections 14.3, 22.3

**Description:**
Model "known syndication relationships" (Section 14.3) and the Section 22.3 edge "Source syndicated-from Source." Create a `SourceSyndication` table (`syndication_id`, `from_source_id` FK, `to_source_id` FK, `direction` (`syndicates_to` | `syndicated_from`), `relationship_type` (`wire` | `republish` | `aggregator` | `partner`), `established_by` (steward/system), `evidence_ref`, `confidence`, `created_at`) with a unique constraint on the directed pair. Provide lookup helpers used by WS-F.1.3d (is there a known relationship between these two sources?) and by MERI grouping (treat syndicated lineage as non-independent). New relationships default to steward-established; system may propose candidates (from repeated co-occurring near-duplicates) for steward confirmation rather than auto-trusting.

**Acceptance criteria:**
- A directed syndication relationship can be created between two sources with a type and evidence reference.
- The directed pair is unique (no duplicate edges in the same direction).
- WS-F.1.3d can query whether a relationship exists between two sources.
- System-proposed relationships are marked as candidates and require steward confirmation before they auto-link content.
- MERI grouping can consume syndication lineage to avoid counting syndicated copies as independent.

**Testing:**
- Unit: Relationship lookup (exists/direction). Unique-pair enforcement.
- Integration: Establish a relationship; verify WS-F.1.3d auto-links from a known partner. Propose a candidate from repeated near-duplicates; verify it does not auto-link until confirmed.

**Security considerations:**
- Auto-trusting syndication edges would let an attacker attach spam to reputable stories; therefore auto-linking requires a steward-confirmed (not merely proposed) relationship. Edges are evidence-referenced and auditable.

**Dependencies:** WS-F.2.1a (Source schema), WS-F.1.3c/d (near-duplicate + syndication detection), WS-J.2 (steward confirmation), consumed by WS-H.2 (MERI grouping).

---

### WS-F.2.5a EvidenceCard Drizzle and zod schema
**ID:** WS-F.2.5a
**Ref:** Sections 22.1, 22.3

**Description:**
Define the `EvidenceCard` entity per Section 22.1: `evidence_id` (UUID PK), `claim_id` (UUID FK -> `claim.claim_id`), `source_id` (UUID FK -> `source.source_id`, nullable for user-experience evidence), `submitted_by` (UUID FK), `evidence_type` (enum: `supports | contradicts | contextualizes | corrects | counterexample`, aligned with the Section 22.3 "supported-by / challenged-by" edges and the relationship-graph link types), `citation_url_or_ref` (text), `relevance_note` (text), `verification_state` (enum: `unverified | verified | disputed | retracted`), `independence_group_id` (UUID, nullable -- shared with `Claim.independence_group_id` for MERI grouping so multiple cards from one lineage do not count as independent validation, per Section 13.6). Add indexes on `claim_id`, `source_id`, and `independence_group_id`. Define the co-located zod schema. Evidence-card links must be navigable in both directions (claim -> cards, card -> claim) per the DoD.

**Acceptance criteria:**
- Migration applies cleanly and rolls back.
- All Section 22.1 `EvidenceCard` fields are represented.
- `evidence_type` enum covers supports/contradicts/contextualizes (and corrects/counterexample) so the claim-evidence link types are navigable.
- `independence_group_id` is present and indexed and is shared semantically with `Claim.independence_group_id`.
- Links are navigable both directions (claim->cards and card->claim queries exist).
- Zod validates structure; insert/select/update round-trip.

**Testing:**
- Unit: Zod accepts valid cards; rejects invalid evidence_type/verification_state.
- Integration: Migration up/down. Insert cards of each type for a claim. Query claim->cards and card->claim. Verify independence grouping for two cards sharing a lineage.

**Security considerations:**
- Evidence is public content; `submitted_by` is for attribution/moderation only and is never a ranking authority signal. Duplicate/non-independent evidence sharing an `independence_group_id` must not inflate exposure (Section 13.6; enforced by MERI in WS-H).

**Dependencies:** WS-F.1.2a (Claim schema), WS-F.2.1a (Source schema), WS-D.1 (User for `submitted_by`); shares `independence_group_id` with WS-F.1.2a.

---

### WS-F.2.5b Content-schema financial-field denylist assertion
**ID:** WS-F.2.5b
**Ref:** Sections 21.5, 13.6

**Description:**
Add an automated, CI-enforced assertion that no WS-F content table (`story`, `claim`, `source`, `source_syndication`, `evidence_card`, `story_signature`, freshness feature records, embeddings) contains any wallet/payment/treasury/donation/financial column. The check introspects the Drizzle schema (and/or `information_schema`) and matches column names against a financial-term denylist (`wallet`, `payment`, `donation`, `donor`, `treasury`, `token`, `balance`, `amount_paid`, `price`, `fee`, `tx_hash`, `chain_id`, etc.), with case-insensitive nested-field matching for JSONB-documented shapes. The assertion fails the build if any denied field is present, mirroring the WS-I.2.1b feature-store denylist so the no-pay-to-rank boundary is enforced at the producer as well as the consumer.

**Acceptance criteria:**
- The check enumerates all WS-F content tables and their columns (including documented JSONB sub-fields) and matches against the financial denylist.
- A deliberately-added financial column (test fixture) fails the check.
- The check runs in CI as a required status and blocks merge on violation.
- The denylist is shared with / consistent with WS-I.2.1b.

**Testing:**
- Unit: Denylist matcher flags `wallet_*`, `*_payment`, `donor_id`, etc., and passes clean schemas.
- CI: The assertion is wired as a required check; a fixture branch adding a denied column is rejected.

**Security considerations:**
- This is a structural guarantee of the no-pay-to-rank invariant at the data layer: financial data cannot enter the content/ranking surface because the columns cannot exist. Defense in depth with WS-I.2.1b and the neutrality tests (WS-I.3).

**Dependencies:** WS-F.1.1a, WS-F.1.2a, WS-F.2.1a, WS-F.2.4, WS-F.2.5a, WS-F.3.2b; consistent with WS-I.2.1b, WS-0.4 (CI lint gate).

---

## WS-F.3 Search

### WS-F.3.1a Full-text search schema and indexing
**ID:** WS-F.3.1a
**Ref:** Sections 21.2, 23.2

**Description:**
Implement PostgreSQL full-text search for stories, claims, and evidence cards (Section 21.2 relational store for content metadata; the DoD requires keyword search with relevance ranking and filters). Add a generated `tsvector` column (or materialized search table) per searchable entity combining weighted fields -- e.g., for stories: `title` (weight A), extracted body/excerpt (weight B), source name and topics (weight C) -- using an appropriate text-search configuration with language awareness where feasible. Create a GIN index on the `tsvector`. Provide a query function that accepts a query string, parses it to a `tsquery`, ranks with `ts_rank_cd`, and supports prefix matching for typeahead. The relevance ranking uses only textual relevance and recency; it must not incorporate any financial signal (no-pay-to-rank).

**Acceptance criteria:**
- A `tsvector` (generated column or maintained table) exists for stories, claims, and evidence cards with field weighting.
- A GIN index exists and is used by search queries (verified via EXPLAIN).
- Search returns results ranked by textual relevance; weighting favors title matches over body matches.
- Prefix/typeahead matching works.
- No financial field participates in indexing or ranking.

**Testing:**
- Integration: Index a corpus; query for terms appearing in titles vs bodies and verify weighting; verify GIN index usage via EXPLAIN.
- Unit: tsquery parsing for multi-word and prefix queries; sanitization of user input.

**Security considerations:**
- User-supplied query strings are parsed via parameterized `to_tsquery`/`websearch_to_tsquery` (never string-concatenated SQL) to prevent injection. Results are scoped to content the requester is permitted to see.

**Dependencies:** WS-F.1.1a (Story), WS-F.1.2a (Claim), WS-F.2.5a (EvidenceCard), WS-F.1.4e (extracted text for body weighting).

---

### WS-F.3.1b Search API with filters
**ID:** WS-F.3.1b
**Ref:** Sections 23.2, 21.2

**Description:**
Expose a search endpoint (Hono RPC, zod-validated) over the WS-F.3.1a index. Supports filtering by date range, source, content type (story/claim/evidence), topic, and language, with pagination and a stable sort (relevance, then recency tiebreak). Results return the `*Public` projections (WS-F.1.1b and analogues) plus the relevance score. The endpoint is rate-limited and returns only content visible to the requester (respects room visibility, moderation/safety-hidden state, and takedown removals). Hybrid retrieval (combining this lexical search with WS-F.3.2 embedding similarity) is supported as an optional mode for later ranking use, but the default keyword path is fully functional on its own.

**Acceptance criteria:**
- Search accepts and validates filters (date, source, content type, topic, language) and pagination via zod.
- Results are the public projections plus relevance score, sorted by relevance with a recency tiebreak.
- Safety-hidden, takedown-removed, and non-visible content is excluded from results.
- The endpoint is part of the Hono RPC type contract and is rate-limited.
- No financial signal affects ranking or filtering.

**Testing:**
- Integration: Query with each filter and combinations; verify correct subset and ordering. Verify excluded content (safety-hidden/takedown/private) does not appear. Verify pagination stability.
- E2E: Client search flow with filters.

**Security considerations:**
- Visibility filtering is enforced server-side; the client cannot widen scope via parameters. Rate limiting mitigates scraping/enumeration. No-pay-to-rank holds for search ordering (Section 13.6 explicitly forbids paid boosts in search).

**Dependencies:** WS-F.3.1a (full-text index), WS-F.1.4f (takedown removals), WS-J.2 (safety-hidden state), WS-G.2 (room visibility), WS-D.1 (requester identity).

---

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

**Security considerations:**
- Self-hosting (no mandatory external embedding API) prevents content text and, by extension, reader/topic interest from leaking to a third party (Section 19.1). The license check protects the AGPL posture (Section 20.4).

**Dependencies:** WS-K.1.1b (model registry entry/governance), WS-K.1.1f (model output/version record). Consumed by WS-F.3.2b/c (dimensionality), WS-H (MERI/SCOI).

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

**Security considerations:**
- The embedding table carries no financial fields and is subject to the WS-F.2.5b denylist assertion. `model_version` provenance supports safe re-embedding when a model is deprecated.

**Dependencies:** WS-F.3.2a (model + dimensionality), WS-F.3.2e (index strategy/tuning may refine the index choice).

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

**Observability:**
- Emit queue-depth, processing-latency, and failure-rate metrics so embedding lag (which would delay MERI/SCOI signals) is visible; alert when backlog exceeds a threshold.

**Security considerations:**
- For link stories, the pipeline only embeds text obtained in compliance with robots.txt/copyright (WS-F.1.4f); disallowed sources contribute no fetched-text embedding. No external API is required (Section 19.1).

**Dependencies:** WS-F.3.2a (model), WS-F.3.2b (Embedding table), WS-F.1.4e (extracted text), WS-F.1.4f (fetch compliance), WS-F.1.2a (claims), WS-F.2.5a (evidence cards). Community-interpretation embeddings depend on WS-G.2 (lenses/interpretations).

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

**Security considerations:**
- These helpers feed invariants (MERI/SCOI), not ranking boosts; they carry no financial input. Result scoping to active, visible entities prevents leakage of deleted or restricted content via similarity.

**Dependencies:** WS-F.3.2b (Embedding table + index), WS-F.3.2c (populated embeddings), WS-F.3.2e (ANN tuning for the p99 target). Consumed by WS-H.2 (MERI), WS-H.4 (SCOI).

---

### WS-F.3.2e ANN index strategy and tuning
**ID:** WS-F.3.2e
**Ref:** Sections 21.2, 21.4

**Description:**
Define and document the ANN index strategy so the WS-F.3.2d latency/recall targets are met as the corpus grows. Compare IVFFlat vs HNSW for the expected dataset size and query mix, choose one, and document the rationale and parameters: for HNSW, `m` and `ef_construction` at build time and `ef_search` at query time; for IVFFlat, `lists` at build time and `probes` at query time. Provide a tuning procedure that measures the recall/latency trade-off against a labeled similarity set and records the chosen operating point. Include a re-index/maintenance plan (when to rebuild after large inserts, how to rebuild without downtime) and per-distance-metric configuration (cosine for semantic similarity). This task may refine the index created in WS-F.3.2b.

**Acceptance criteria:**
- A documented choice between IVFFlat and HNSW with rationale for the expected scale.
- Index build parameters and query-time parameters are documented and configurable.
- A recall-vs-latency measurement against a labeled set establishes the operating point meeting the WS-F.3.2d p99 (<100ms) and an agreed recall target.
- A re-index/maintenance plan exists, including non-blocking rebuild guidance.

**Testing:**
- Performance: Recall and latency measured at 10K/50K/100K embeddings for the chosen index/params; operating point meets targets.
- Integration: Rebuild the index after a bulk insert and verify queries continue to return correct, indexed results.

**Observability:**
- Track query latency percentiles and (sampled) recall against exact search so index drift/degradation as data grows is detectable.

**Security considerations:**
- Tuning data and labeled sets contain only public content embeddings; no attention or financial data is involved. Maintenance jobs run within the content schema boundary.

**Dependencies:** WS-F.3.2b (base index), WS-F.3.2c (data to tune against), consumed by WS-F.3.2d.

---

### WS-F.3.2f Re-embedding and model-version migration
**ID:** WS-F.3.2f
**Ref:** Sections 21.4, WS-K

**Description:**
Provide a safe path to re-embed the corpus when the embedding model is upgraded (Section 21.4 reproducible runs / feature versioning; the `model_version` field exists precisely for this). Implement a backfill job that, given a new `model_version`, generates embeddings for all targets and writes them alongside the old version (the unique constraint is on `(target_type, target_id, model_version)`), so similarity consumers can be cut over atomically once the backfill completes and is validated. Support a dual-read/validation window comparing old vs new neighbors on a sample, a cutover switch (which `model_version` similarity queries use), and cleanup of superseded embeddings after a retention window. The job is resumable, rate-limited to protect the database, and records progress.

**Acceptance criteria:**
- A backfill job re-embeds all targets under a new `model_version` without deleting the current version's embeddings.
- Similarity queries can be switched to the new `model_version` atomically after validation.
- A validation step compares old vs new neighbor sets on a sample and reports drift before cutover.
- Superseded embeddings are cleaned up after a configurable retention window.
- The job is resumable and rate-limited; progress is recorded.

**Testing:**
- Integration: Seed embeddings under model v1; run backfill to v2; verify both versions coexist; switch to v2; verify queries use v2; run cleanup; verify v1 removed after window.
- Unit: Resume-from-progress logic; rate limiter.

**Observability:**
- Report backfill progress (percent complete, throughput) and the validation drift metric so a problematic model upgrade is caught before cutover.

**Security considerations:**
- Model provenance (`model_version`) ensures a faulty model's embeddings can be identified and rolled back; cutover is reversible (the prior version remains until cleanup), satisfying the Section 30.8 reversibility requirement.

**Dependencies:** WS-F.3.2b (versioned Embedding table), WS-F.3.2c (generation worker), WS-F.3.2a (new model registration), WS-K (model governance/version record).

---

## Task dependency summary

| Task | Title | Size (days) | Depends on | Blocks |
|---|---|---|---|---|
| WS-F.1.1a | Story Drizzle schema | 1 | WS-D.1, WS-F.2.1a, WS-F.1.1c, WS-F.1.4b | WS-F.1.1b, WS-F.1.3b, WS-F.1.4*, WS-G.1.1 |
| WS-F.1.1b | Story zod schema and DTOs | 1 | WS-F.1.1a, WS-F.1.4b | WS-F.1.4a, WS-F.3.1b |
| WS-F.1.1c | Story lifecycle state machine | 2 | WS-F.1.1a, WS-E (soft), WS-H.4 (soft), WS-G (soft) | WS-F.1.4g, story-page UI (WS-B/C) |
| WS-F.1.2a | Claim Drizzle and zod schema | 1 | WS-F.1.1a, WS-F.2.5a | WS-F.1.2b, WS-F.1.4b, WS-F.3.1a, WS-G.1.3 |
| WS-F.1.2b | Candidate claim extraction | 1.5 | WS-F.1.2a, WS-F.1.4e, WS-K.1.3b/1.1f/1.3c, WS-F.3.2c (soft) | claim-evidence graph (WS-G) |
| WS-F.1.3a | URL normalization | 1.5 | — | WS-F.1.3b, WS-F.1.1a, WS-H.2.1a |
| WS-F.1.3b | Exact-URL duplicate detection | 1 | WS-F.1.3a, WS-F.1.1a | WS-F.1.4a |
| WS-F.1.3c | Near-duplicate text detection | 2 | WS-F.1.1a, WS-F.1.4e, WS-J.2 | WS-F.1.3d, WS-F.2.4 |
| WS-F.1.3d | Syndicated copy detection | 1.5 | WS-F.1.3c, WS-F.2.4, WS-F.2.1a, WS-J.2 | MERI grouping (WS-H.2) |
| WS-F.1.4a | POST /v1/stories endpoint | 1.5 | WS-D.1, WS-F.1.1a/b, WS-F.1.3a-d, WS-F.1.4b/c/d | client submission (WS-C), WS-G |
| WS-F.1.4b | Required metadata validation per type | 1 | WS-F.1.1a, WS-F.1.2a | WS-F.1.1a/b, WS-F.1.4a |
| WS-F.1.4c | Safety pre-checks | 1.5 | WS-D.1, WS-F.1.3b-d, WS-J | WS-F.1.4a |
| WS-F.1.4d | Thread shell creation | 1 | WS-F.1.1a, WS-G.1.1 | WS-G (contributions) |
| WS-F.1.4e | Metadata extraction | 2 | WS-F.1.1a, WS-F.1.4f, WS-K.1.3a (soft) | WS-F.1.2b, WS-F.3.2c, WS-F.3.1a |
| WS-F.1.4f | Robots.txt, copyright, takedown intake | 2 | WS-F.1.1a, WS-J.2, WS-F.2.1a | WS-F.1.4e, WS-F.3.2c, WS-F.3.1b |
| WS-F.1.4g | Freshness baseline | 1.5 | WS-F.1.1a, WS-F.1.1c, WS-F.2.1a, WS-E (soft) | WS-I.2.3d, WS-I.1.1b |
| WS-F.2.1a | Source Drizzle and zod schema | 1.5 | WS-F.1.4f | WS-F.1.1a, WS-F.2.2a/2.3a/2.4/2.5a, WS-H, WS-I |
| WS-F.2.2a | Automatic source profile creation | 1 | WS-F.2.1a, WS-F.1.1a, WS-F.1.4e, WS-F.1.3a | source history (WS-H/I) |
| WS-F.2.3a | Steward source profile editing | 1.5 | WS-F.2.1a, WS-A.2, WS-J.2 | curated source context |
| WS-F.2.4 | Source syndication relationships | 1.5 | WS-F.2.1a, WS-F.1.3c/d, WS-J.2 | WS-F.1.3d, WS-H.2 (MERI) |
| WS-F.2.5a | EvidenceCard Drizzle and zod schema | 1.5 | WS-F.1.2a, WS-F.2.1a, WS-D.1 | WS-F.3.1a, WS-G (evidence), WS-H.2 |
| WS-F.2.5b | Content-schema financial-field denylist assertion | 1 | WS-F.1.1a, WS-F.1.2a, WS-F.2.1a, WS-F.2.4, WS-F.2.5a, WS-F.3.2b | no-pay-to-rank guarantee (M3 gate) |
| WS-F.3.1a | Full-text search schema and indexing | 1.5 | WS-F.1.1a, WS-F.1.2a, WS-F.2.5a, WS-F.1.4e | WS-F.3.1b |
| WS-F.3.1b | Search API with filters | 1.5 | WS-F.3.1a, WS-F.1.4f, WS-J.2, WS-G.2, WS-D.1 | discovery, client search |
| WS-F.3.2a | Embedding model selection and registry | 1 | WS-K.1.1b/1.1f | WS-F.3.2b/c, WS-H |
| WS-F.3.2b | pgvector extension setup | 1 | WS-F.3.2a, WS-F.3.2e | WS-F.3.2c/d, WS-F.2.5b |
| WS-F.3.2c | Embedding generation pipeline | 2 | WS-F.3.2a/b, WS-F.1.4e/4f, WS-F.1.2a, WS-F.2.5a, WS-G.2 (interpretations) | WS-F.3.2d, WS-H (MERI/SCOI) |
| WS-F.3.2d | Similarity query optimization | 1.5 | WS-F.3.2b/c/e | WS-H.2 (MERI), WS-H.4 (SCOI) |
| WS-F.3.2e | ANN index strategy and tuning | 1.5 | WS-F.3.2b/c | WS-F.3.2d |
| WS-F.3.2f | Re-embedding and model-version migration | 1.5 | WS-F.3.2a/b/c, WS-K | safe model upgrades |

Notes: "(soft)" dependencies are inputs that improve a feature but whose absence is handled by graceful degradation (the task ships and functions without them). Several WS-F IDs are referenced verbatim by sibling workstreams (WS-G, WS-H, WS-I, WS-K) and the master index; those IDs are preserved exactly.

---

## Workstream definition of done

WS-F is complete when ALL of the following conditions hold:

1. **Story schema and submission:** The `Story` entity (WS-F.1.1a/b) exists with co-located zod contracts, and stories can be submitted via `POST /v1/stories` (WS-F.1.4a) for all six Section 14.1 submission types with per-type discriminated-union validation (WS-F.1.4b) and safety pre-checks (WS-F.1.4c).

2. **Story lifecycle:** The Section 14.4 lifecycle state machine (WS-F.1.1c) drives stories through submitted -> gathering_attention -> deepening -> context_needed -> bridging -> stable -> archived (with the documented non-linear edges), with an audit trail and no dependency on financial state.

3. **Story submission and dedup:** Duplicate and near-duplicate stories are detected and handled (merged, linked, or flagged for review) before publication via exact-URL match (WS-F.1.3b), MinHash/LSH near-duplicate detection (WS-F.1.3c), and source-aware syndication detection (WS-F.1.3d) -- preventing MERI-violating floods.

4. **Crawling, copyright, and takedown:** Fetching respects robots.txt and publisher restrictions, display is copyright-aware (bounded excerpt + attribution + canonical link-out), and a takedown intake path routed to moderation is operational (WS-F.1.4f). Metadata extraction (WS-F.1.4e) is SSRF-hardened and non-blocking.

5. **Claims and evidence cards:** Claims can be system-extracted or attached to stories (WS-F.1.2a/b), and evidence cards link to claims with typed relationships (supports, contradicts, contextualizes, corrects, counterexample) that are navigable in both directions (WS-F.2.5a). Shared `independence_group_id` lets MERI avoid counting non-independent claims/evidence as independent validation.

6. **Source profiles:** Sources (publications, authors, domains) have profiles with Section 14.3 metadata (WS-F.2.1a), are created automatically on first ingestion (WS-F.2.2a), are editable by stewards with audit (WS-F.2.3a), and carry syndication relationships (WS-F.2.4). The source model exposes context and history and contains no "truth score."

7. **Full-text search:** Keyword search (WS-F.3.1a/b) returns relevant results for stories, claims, and evidence cards ranked by textual relevance, with filters by date, source, content type, topic, and language, respecting visibility/safety/takedown state, and using no financial signal.

8. **Embeddings for MERI/SCOI:** A self-hostable embedding model is selected and registered (WS-F.3.2a); pgvector is set up with a tuned ANN index (WS-F.3.2b/e); embeddings are generated asynchronously for stories, claims, evidence cards, and community interpretations (WS-F.3.2c); similarity helpers (findSimilarStories, findSimilarClaims, findSimilarInterpretations, findNearestEvidenceCards) use the ANN index within the latency target (WS-F.3.2d); and a safe re-embedding/model-upgrade path exists (WS-F.3.2f).

9. **Freshness baseline:** A versioned, financial-input-free freshness baseline (WS-F.1.4g) is computed per story/topic and consumable by ranking (WS-I.2.3d) for cold-start mitigation.

10. **No-pay-to-rank at the data layer:** No WS-F content/search/embedding table contains any wallet, payment, donation, treasury, or financial field, enforced by a CI denylist assertion (WS-F.2.5b) consistent with the WS-I.2.1b feature-store denylist. The no-pay-to-rank invariant holds structurally in ingestion and search.
