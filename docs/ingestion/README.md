<!--
  Licio — Participation-Weighted Attention PWA
  Copyright (C) 2026  Adam Hall
  SPDX-License-Identifier: AGPL-3.0-or-later
-->

# WS-F: Ingestion, Source Model, and Search — implementation reference

This document is the implementation reference for WS-F (plan:
`docs/planning/07-ingestion-and-search.md`; SPEC §14, §21.2, §22.1/22.3,
§23.2).  It records where each task landed, the architectural decisions and
their rationale, the mathematics, the security posture, and the seams left
for downstream workstreams.

## Architecture at a glance

WS-F follows the WS-D/WS-E house pattern end to end:

- **Wire contracts** live in `packages/shared/src/schemas/` (`story.ts`,
  `claim.ts`, `source.ts`, `search.ts`, `takedown.ts`) — zod schemas
  co-located with the route types so compile-time and runtime contracts
  cannot diverge (§23.1).  Pure shared utilities live in
  `packages/shared/src/utils/` (`url.ts`, `story-lifecycle.ts`,
  `financial-fields.ts`).
- **Pure math** lives in `packages/invariants` (`text/minhash.ts`,
  `freshness/baseline.ts`) with deterministic property tests.
- **Tables + migration** live in `packages/db` (`schema/story.ts`,
  `claim.ts`, `source.ts`, `thread.ts`, `takedown.ts`,
  `ingestion-review.ts`, `embedding.ts`; migration
  `drizzle/0007_ws_f_ingestion.sql`), plus the pgvector similarity helpers
  (`similarity.ts`) and the WS-F.2.5b financial-denylist assertion
  (`content-schema-check.ts`).
- **Services** live in `apps/api/src/ingestion/`: store interfaces +
  in-memory adapters (`stores.ts`), the injectable container + module
  singleton (`services.ts`), and production Drizzle adapters
  (`drizzle-ingestion-stores.ts`) swapped in at boot — identical lifecycle to
  the WS-D/WS-E containers.
- **Async work rides the WS-E event router** as durable consumers
  (`ingestion-pipeline`, `ingestion-embeddings`, `ingestion-signals`): at
  least-once delivery, bounded retries, dead-lettering, and checkpoint
  replay at boot come from the existing pipeline — no parallel job system.
- **Routes**: `apps/api/src/routes/stories.ts` (POST `/v1/stories`, claim/
  evidence/source reads, GET `/v1/search`, POST `/v1/takedowns`) and
  `apps/api/src/routes/ingestion-admin.ts` (steward surface at
  `/v1/ingestion/admin/*`, `requireSteward` + TOTP-cleared session).
- **Hourly maintenance** (`ingestion/scheduler.ts`) runs under its own
  Postgres job lease (`ingestion_hourly`): lifecycle low-activity sweep,
  freshness refresh, extraction retries, one rate-limited embedding-backfill
  step, and config reload.

## Submission flow (WS-F.1.4a, the §14.2 pipeline)

`POST /v1/stories` guard order (after route auth + zod discriminated-union
validation of all six §14.1 types):

1. per-account submission rate limit — hour + day sliding windows keyed by
   the non-reversible account ref (10/h, 50/d defaults; 429 + Retry-After)
2. URL normalization (link stories; typed 400s)
3. pre-checks: account age (default 60 min), repeated-identical-title spam
   pattern, locally-maintained malware/phishing domain denylist (403). The
   account-age gate has a fail-closed DEV/TEST escape hatch
   (`skipAccountAgeGate`, set at boot from a `development`/`test` `NODE_ENV`
   allowlist — never production/staging/unset) so a freshly created local
   account can post immediately; it is the ingestion-side parallel of the
   `POST /v1/auth/dev/verify` verification shortcut, and it relaxes ONLY the
   account-age gate (the spam-title and URL-safety checks still apply)
4. evidence-card claim-reference existence (400)
5. exact-URL duplicate via the partial unique index (409 + existing story id;
   the create path's unique-violation handler closes the concurrent race)
6. transactional story + thread-shell creation (WS-F.1.4d: both or neither)
7. synchronous near-duplicate pass on the locally available text — the
   submitter is informed via `similar_story_ids` + `review_flags`
8. `content.submitted` stored durably, then published DETACHED so extraction
   latency never delays the 201 (crash-safety = durable log + checkpoint
   replay, not the in-flight promise).

The async `ingestion-pipeline` consumer then runs the §14.2 body per story:
robots gate → SSRF-hardened fetch → metadata extraction → source resolution
(idempotent upsert + primary source link + publisher display restrictions) →
language + sensitivity classification → copyright-bounded excerpt → MinHash
signature on the FETCHED text → near-duplicate/syndication classification →
candidate claims → freshness baseline → `content.normalized` (deterministic
UUIDv8 event id ⇒ idempotent under redelivery).

Extraction failure is non-blocking: the story stays readable, an
`extraction_failure` review item with exponential `not_before` backoff
(5/25/125 min) schedules the retry, and the attempt that succeeds emits
`content.normalized`.

An **evidence-card submission** additionally creates the `EvidenceCard` row in
the same request (WS-F.2.5a), resolves a WEB citation URL to an in-app source
(so the §14.3 evidence-type frequency populates; a non-web citation stays
source-less), and emits `evidence.added` — stored durably, published detached
— so the `ingestion-embeddings` consumer generates the card's vector
(WS-F.3.2c) without blocking the 201.

## Mathematics

### URL canonicalization (WS-F.1.3a)

Pure, total, idempotent (`normalize∘normalize = normalize`, property-tested).
**Documented deviation from the task text:** the URL *path keeps its case*.
RFC 3986 §6.2.2.1 makes only scheme and host case-insensitive; paths are
case-sensitive at most publishers (video ids, wiki titles), so lowercasing
would collide distinct resources into one canonical URL (false-positive 409s
via the unique index) and break the stored link-out.  Scheme/host lowercase +
punycode, `www.` stripped (only when a registrable remainder stays), userinfo
stripped, default port dropped, dot segments resolved, percent-encoding
normalized per §6.2.2.2 (unreserved decoded, hex uppercased — reserved
characters never decoded, so no new separators can appear), trailing slashes
trimmed (root kept), denylisted trackers removed (exact set + `utm_`/`ref_`
prefix rules, runtime-extensible), remaining params stably sorted, fragment
dropped.

### Near-duplicate detection (WS-F.1.3c/d)

Character 5-shingles (casefolded, whitespace-collapsed) → 128 MinHash
components over the fixed universal-hash family
`hᵢ(x) = (aᵢ·x + bᵢ) mod p`, `p = 4 294 967 311` (smallest prime > 2³²),
evaluated in EXACT double arithmetic (`universalHashMod`): a 16-bit split of
`x` keeps every intermediate product below 2⁵³ and therefore exact, so the hot
per-shingle/per-hash loop needs no BigInt.  It is proven equivalent to a
BigInt reference across the full uint32 range and pinned by a
golden-signature regression test.  The family is generated from a pinned seed
and frozen as `MINHASH_FAMILY_VERSION = 1` — signatures are persisted
(`story_signatures`, bytea, big-endian uint32) and compared across machines,
so neither the family nor the modmul may silently change (bump the version and
re-signature instead).

Estimator: component agreement fraction; `E[est] = J(A,B)`, standard error
`√(J(1−J)/128) ≤ 0.0442` (tested against the exact-Jaccard oracle at 4.5σ
per pair).

LSH banding `b = 32 × r = 4` over the `story_lsh_bands` index — candidate
retrieval is 32 point lookups, never a scan.  **Corrected math for the task
sketch:** the sketch labels (32, 4) "a ~0.7 crossover"; exactly, the 50 %
point of `P(s) = 1 − (1 − s⁴)³²` is `s* = (1 − 2^(−1/32))^(1/4) ≈ 0.3826`,
and the conventional steep-point approximation `(1/b)^(1/r) ≈ 0.4204` sits at
`P ≈ 0.636`.  Both are *deliberately below* the 0.7 decision threshold: the
banding is the high-recall RETRIEVAL stage (`P(candidate | J = 0.7) ≈
0.999847`) and the flag DECISION is the signature estimate against the
runtime-configurable threshold.  Detection therefore satisfies both
acceptance bounds: ≥ 70 % overlap flags (retrieval ≈ certain, estimate above
threshold at > 5σ) and < 50 % overlap does not (estimate filter).

Classification is source-aware (WS-F.1.3d): same source ⇒ `near_duplicate`
review flag (flag-for-review, never auto-reject — auto-rejection would be a
denial-of-publication vector); different source with a steward-CONFIRMED
syndication edge ⇒ auto-link the copy's source onto the existing story's
source list (`story_source_links`; no new MERI exposure; the original is
never replaced); different source without one ⇒ `syndication_candidate`
review flag (auto-trusting self-asserted edges would attach spam to
reputable stories).

### Freshness baseline (WS-F.1.4g)

`score = w_s·e^(−A_submit/τ_topic) + w_u·e^(−A_update/τ_update) +
w_e·e^(−A_event/τ_event)` with weights summing to 1 and
`τ_topic = clamp(median-inter-arrival × 2, 6 h, 14 d)` — freshness is judged
relative to the topic's cadence (multi-topic stories use the fastest).  An
unknown event time redistributes its weight onto the submission term.
Property-tested: bounded (0, 1]; **weakly** decreasing in every age over the
full float range and **strictly** decreasing in the fresh regime (the exact
IEEE-754 statement: once a term decays below the ulp of the score — months
past any ranking horizon — older inputs compare equal, never greater);
slower topic cadence never scores lower.  The persisted record
(`story_freshness`) is versioned (`FRESHNESS_FEATURE_VERSION = 1`), reads no
financial field (denylist-checked), and is the WS-I.2.3d input.

### Embeddings (WS-F.3.2)

`embeddings` table: unique `(target_type, target_id, model_version)` —
duplicate prevention AND the safe-upgrade mechanism in one constraint —
with a 384-dimension `vector` column and an **HNSW** cosine index
(`m = 16, ef_construction = 64`; query-time `ef_search` settable per call).
**Index decision (WS-F.3.2e):** HNSW over IVFFlat because IVFFlat trains its
centroids from data present at build time (degenerate on the empty table
every deployment starts with) while HNSW builds incrementally, has better
recall/latency at the targeted 10K–1M scale, and tunes recall without a
rebuild.  Maintenance: HNSW needs no scheduled rebuild on insert-heavy
growth; a rebuild (`REINDEX CONCURRENTLY`) is only warranted after mass
deletes (e.g. version cleanup), and similarity queries keep functioning
throughout.

**Measured operating point (WS-F.3.2e).**  The gated benchmark
(`apps/api/src/__tests__/ingestion-performance.test.ts`, opt-in via
`DATABASE_URL` + `RUN_PERF=1`) seeds a clustered corpus and measures recall@10
(vs the exact seq-scan neighbours) and latency across `hnsw.ef_search`
settings.  At N = 20 000 the forced-HNSW path records (representative; HNSW
construction is not perfectly deterministic, so figures vary a few percent
run to run):

| `ef_search` | recall@10 | p99 latency |
|---|---|---|
| 10 | ≈ 0.89–0.92 | ≈ 5 ms |
| 40 | ≈ 0.987 | ≈ 6 ms |
| 100 | ≈ 0.990 | ≈ 6 ms |

So **`ef_search = 40` is the operating point** — recall ≈ 0.987 at ~6 ms, with
diminishing returns above it (the gated assertion is recall ≥ 0.9 at
ef_search = 100).  The same run records exact-URL duplicate lookup p99 ≈ 5–11
ms (target < 50 ms, WS-F.1.3b — the unique b-tree is O(log n), so the 1 M
target is microseconds further) and the unfiltered similarity production
query p99 ≈ 20–26 ms (target < 100 ms, WS-F.3.2d).  Note
the production similarity query is filtered by `model_version`: below the
HNSW crossover the planner answers EXACTLY (b-tree-on-version + sort, still
fast); HNSW takes over as the corpus grows.  Full-scale (1 M) validation
remains a WS-P load-harness concern, but the constants and the operating
point are now measured, not assumed.

Providers behind one interface (`EmbeddingProvider`):

- `HttpEmbeddingProvider` — the production binding: a SELF-HOSTED embedding
  service (e.g. text-embeddings-inference running all-MiniLM-L6-v2) over
  fetch, configured by the all-or-none `EMBEDDING_*` env group.  §19.1
  forbids a third-party embedding API (content text must not leak).  Boot
  fails closed if `EMBEDDING_DIMENSION` disagrees with the table's pinned
  384.
- `DeterministicLexicalProvider` (`lexical-fnv-v1`) — dev/CI default:
  seeded signed feature hashing of character 3-grams, L2-normalized.  It is
  a real *lexical*-similarity embedding (cosine correlates with n-gram
  overlap; deterministic everywhere) and is HONESTLY labeled non-semantic:
  the registry entry's `known_limitations` states that MERI/SCOI semantic
  conclusions are gated on the self-hosted model, and production boot warns
  loudly when running on it.

`EMBEDDING_MODEL_REGISTRY` (in `ingestion/embeddings.ts`) carries the
WS-K.1.1b registry-entry shape (name, version, provider, dimension, token
limit, license, evaluation, known limitations) until the WS-K registry owns
it — a documented seam.

**Model migration (WS-F.3.2f):** `startBackfill` → resumable, rate-limited
`runBackfillStep` per scheduler tick (keyset cursor in the config store; new
vectors written alongside the old version) → `validateBackfill` → atomic
cutover by flipping `ingestion.embeddingActiveVersion` → steward-triggered
cleanup of the superseded version (refused for the ACTIVE version).
`validateBackfill` reports TWO drift metrics so the human cutover decision
sees membership AND order: `meanNeighborOverlap` (top-k neighbour-SET Jaccard)
and `meanRankAgreement` (Rank-Biased Overlap of the top-k RANKINGS,
top-weighted).  Set overlap alone scores reordered-but-same neighbours as
zero drift; RBO catches a quality shift that keeps the same ids.

**Embedding-similarity claim dedup (WS-F.1.2b, soft).**  Beyond exact
normalized-text linking, a candidate claim is embedded and — via the general
`EmbeddingStore.findSimilarToVector` primitive (an ANN query against an
arbitrary vector, no stored anchor row; the same primitive WS-H MERI/SCOI
will use) — LINKED to an existing claim above `ingestion.claimDedupSimilarity`
(default 0.92) instead of being created.  With the lexical provider this
catches reorderings/rephrasings the text hash misses; true semantic-paraphrase
dedup needs the self-hosted model.  Cross-story by construction (a story's own
claims are embedded only after its `content.normalized`), and best-effort (an
embedding error degrades to no-link, never failing ingestion).

Similarity helpers (WS-F.3.2d, `packages/db/src/similarity.ts`):
`findSimilarStories` / `findSimilarClaims` (≥ threshold, hidden/retracted
excluded), `findSimilarInterpretations` (pairwise similarity over supplied
interpretation ids, LOW pairs first — SCOI divergence; WS-G's lens-tagged
contributions now provide the per-lens interpretation entity, and the
embedding/SCOI consumption that feeds ids into this helper lands with WS-H),
`findNearestEvidenceCards`.  All order by `<=>` so the HNSW index drives the
scan (EXPLAIN-asserted in the gated tests), all bind parameters, and all
exclude the query target and removed content.

## Search (WS-F.3.1)

Generated STORED `tsvector` columns on `stories` (title A, excerpt B,
publisher+author C — weighting integration-tested: title hits outrank
excerpt hits), `claims` (text A) and `evidence_cards` (note A, citation B),
each GIN-indexed.  Language awareness: rows index under the `english`
configuration when `language LIKE 'en%'` and `simple` otherwise (constant
config per CASE branch keeps the expression immutable); queries match
`to_tsquery('simple', q) || to_tsquery('english', q)` so either
representation hits.

User input is tokenized to `[\p{L}\p{N}]+` only and each token quoted into
the tsquery (no operator/quote character can survive tokenization —
injection-safe by construction; prefix mode adds `:*` to the last token for
typeahead).  Filters: type, topic, source, language, date range.  Ordering
is relevance (ts_rank_cd) → recency → id, with keyset pagination (the cursor
encodes the triple).  Visibility is server-side: takedown/safety-hidden
stories, retracted claims/evidence, and claims of hidden stories never
appear.  No financial signal exists in any input (no-pay-to-rank, §13.6).

The in-memory `InMemorySearchIndex` mirrors the SQL semantics exactly (same
weights, same total order) so unit tests and the Postgres adapter agree.

## Source model (WS-F.2)

`sources` carries the §14.3 profile — name, canonical domain (partial
case-insensitive unique), publisher lineage, typical topics, append-mostly
correction history with provenance, evidence-type frequency, community
notes, robots/copyright display restrictions — and **no truth score**: the
absence is enforced three times (strict zod schemas reject the field names,
a shared-schema test pattern-matches every key, and the db column-name test
does the same).  Profiles are created idempotently on first ingestion
(unique-index-resolved get-or-create; concurrent first submissions yield one
row) and updated incrementally: `typical_topics` from each ingested story's
topics, and `evidence_type_frequency` from each web-cited evidence card's
relationship type (an evidence-card submission whose citation resolves to a
domain bumps that source's count — the mechanism that makes the §14.3
frequency field actually populate).  Steward edits (WS-F.2.3a) run through
`PATCH /v1/ingestion/admin/sources/:id` with one immutable audit record per
edited field (before → after → reason).

Syndication edges (WS-F.2.4) are canonicalized to `syndicates_to`
(from = origin; a `syndicated_from` input swaps endpoints — enforced by a DB
CHECK), unique per directed pair, evidence-referenced, and only CONFIRMED
edges auto-link content; system-proposed candidates require steward
confirmation.

## Lifecycle (WS-F.1.1c)

The pure transition function lives in
`packages/shared/src/utils/story-lifecycle.ts` — an exact transcription of
the plan's authoritative table, exhaustively tested (every legal pair, every
illegal pair → `INVALID_LIFECYCLE_TRANSITION`, full §14.4 happy path).  The
service (`ingestion/lifecycle.ts`) persists transitions and writes one
append-only `story_lifecycle_audits` record each (from/to/trigger/actor),
with per-transition counters.  Trigger sources are structural: WS-E events
(`attention.aggregate` ⇒ `first_attention`; the rolling contribution counter
⇒ `sustained_participation`/`renewed_activity`/`reactivation`, whichever is
legal for the current state), the hourly low-activity sweep, and the steward
admin endpoint — no client-facing route can force a transition.  Invalid
transitions under at-least-once redelivery are reported no-ops, never
consumer failures.  WS-G's real `contribution.created`/`evidence.added`
events now drive the rolling contribution counter; SCOI/evidence-gap
triggers (`scoi_evidence_gap`, `context_added`, …) arrive with WS-H through
the same `applyLifecycleTrigger` seam.

## Security posture

- **SSRF (WS-F.1.4e):** `safe-fetch.ts` is built on node:http(s) — not
  global fetch — because the request `lookup` option is the only
  rebinding-safe place to validate addresses: EVERY resolution (every
  redirect hop's included) passes the gate, so a DNS answer changing between
  check and connect cannot reach a private address.  Blocked: loopback, RFC
  1918 + CGNAT, link-local (incl. 169.254.169.254), multicast/reserved/
  documentation ranges, IPv6 ULA/link-local/NAT64, and IPv4-mapped forms;
  only ports 80/443; ≤ 5 redirects re-validated per hop; response bytes
  capped WHILE streaming; one deadline across the chain.  The only gate
  override is a test-only function that throws outside `NODE_ENV=test`.
- **robots.txt (WS-F.1.4f):** RFC 9309 matching (most-specific agent group,
  longest rule, Allow wins ties, `*`/`$` patterns), TTL cache, crawl-delay
  deferral.  An UNREACHABLE robots.txt fails CLOSED (nothing fetched; retry
  scheduled); a 4xx means no restrictions per the RFC.
- **Copyright (WS-F.1.4f):** only a bounded excerpt (default 500 chars,
  publisher-tightenable, `noarchive` ⇒ none) plus attribution and the
  canonical link-out are ever persisted — the fetched body is shingled and
  embedded in memory and discarded, so full-body redistribution is
  structurally impossible.  Publisher `noindex`/`noarchive` metas are
  recorded on the source profile and honored.
- **Takedowns (WS-F.1.4f):** public structured intake (rate-limited; a
  rights holder needs no account) → steward review → actioning hides the
  target everywhere (story reads 404, search excludes; evidence retracts;
  source restrictions tighten), writes an audit record, and best-effort
  notifies the submitter via the existing fail-closed Mailer.  Nothing
  auto-removes: the takedown path is itself a censorship-abuse vector.
  `POST /v1/takedowns` is CSRF-EXEMPT (alongside telemetry/CSP-report):
  an anonymous intake carries no session cookie, so there is no victim
  session for CSRF to ride, and the Origin check would wrongly block a
  legitimate embedded intake form on a rights holder's own site; the
  endpoint's own 30/min global rate limit plus mandatory review bound abuse.
- **HTML handling:** extracted documents are parsed (quote-aware scanner +
  JSON.parse for JSON-LD), never executed; script/style content never
  becomes text.
- **No-pay-to-rank at the data layer (WS-F.2.5b):** the shared
  segment-matching financial denylist
  (`packages/shared/src/utils/financial-fields.ts`, future WS-I.2.1b
  consumer) is asserted over every WS-F table's columns AND the documented
  JSONB sub-field names in CI; a deliberately financial fixture table proves
  the matcher bites; and every WS-F table is a BFS target of the
  wallet↔ranking isolation proof.
- **Privacy (§19.1):** no IP anywhere (the submission limiter keys on the
  non-reversible account ref); the malware check is a LOCAL denylist — no
  external scanning API ever sees a submitted URL (if one were ever
  privacy-approved, an unavailable provider HOLDS link stories for review,
  fail-toward-caution); `location_scope` is a property of the news event,
  never the reader.

## Justified deviations and schema evolutions

| Decision | Rationale |
|---|---|
| URL paths keep their case | RFC 3986; lowercasing collides distinct resources and breaks link-outs (task text said lowercase). |
| LSH (32, 4) crossover documented as ≈ 0.38, not ≈ 0.7 | The sketch's "~0.7 crossover" is mathematically incorrect; (32, 4) is kept as the high-recall retrieval stage with the estimate making the 0.7 decision. |
| `content.normalized.source_id` and `evidence.added.source_id` became nullable | WS-F is the first real producer: non-link submissions have no web source; §22.1 user-experience evidence has none either. |
| Claim ENTITY statuses (`candidate/accepted/contested/retracted`) vs the WS-E `claim.updated` EVENT vocabulary | Two distinct dimensions; the documented emission mapping is candidate→unverified, accepted→supported, contested→challenged, retracted→retracted. |
| EvidenceCard `evidence_type` is the RELATIONSHIP taxonomy (`supports/contradicts/…`), distinct from the WS-E event's MATERIAL taxonomy | §22.3 edges require the relationship dimension; both legitimately exist and are named apart (`EVIDENCE_RELATIONSHIP_TYPES`). |
| Evidence-card story submissions default to `contextualizes` | §14.1 carries no relationship field; asserting `supports` would fabricate a stance. WS-G's evidence flows attach explicit types. |
| `stories_topics_nonempty` uses `cardinality()` | `array_length('{}', 1)` is NULL and a NULL CHECK silently passes (caught by the gated tests). |
| docker-compose runs `pgvector/pgvector:pg16` | The stock postgres image does not bundle the `vector` extension the migration chain now requires (drop-in replacement; pin to digest on first pull per the in-file comment). |

## Operations

- **Env:** `EMBEDDING_URL` / `EMBEDDING_MODEL` / `EMBEDDING_MODEL_VERSION` /
  `EMBEDDING_DIMENSION` (all-or-none; absent ⇒ lexical provider + production
  warning).  Runtime tunables (rate limits, thresholds, denylists, excerpt
  bound, lifecycle windows, active embedding version, …) live under
  `ingestion.*` keys in the shared config store: validated at write time
  (steward PATCH → 422 on rejection) and fail-closed at load (invalid stored
  values are logged and the default kept).  NOT runtime-tunable by design:
  the MinHash family/banding (persisted signatures; changing them is a
  versioned re-signature migration) and the embedding dimension (a table
  migration).
- **Observability:** in-process counters (submissions by type, dedup
  outcomes, per-transition lifecycle counts, embedding/search activity —
  ids and counts only, never content) at `GET /v1/ingestion/admin/metrics`;
  backfill progress at `GET /v1/ingestion/admin/embeddings/backfill`.
- **Gated tests:** `packages/db/src/__tests__/integration-ws-f.test.ts` and
  `apps/api/src/__tests__/ingestion-integration.test.ts` run the REAL
  migration chain (including `CREATE EXTENSION vector`) against live
  Postgres when `DATABASE_URL` is set, asserting index usage via EXPLAIN
  (GIN topic containment, partial unique URL lookups, FTS GIN, HNSW cosine)
  and exact cosine ordering.  Cleanup is row-scoped because vitest projects
  share the live database.  The Drizzle adapters and pgvector helpers are
  excluded from unit coverage on the same precedent as every other
  production adapter.
- **Performance benchmarks** (`ingestion-performance.test.ts`) are gated on
  `DATABASE_URL` **and** `RUN_PERF=1` (opt-in — they seed tens of thousands
  of rows and build an HNSW index, so they never run in CI or a normal gated
  pass).  Run, e.g.:
  `DATABASE_URL=… RUN_PERF=1 PERF_N=20000 pnpm --filter api test ingestion-performance`.
  They establish the WS-F.1.3b / WS-F.3.2d latency targets and the WS-F.3.2e
  recall-vs-latency operating point (table above).

## Closed residuals from earlier workstreams

- **WS-E "story emission"**: `content.submitted` / `content.normalized` are
  now emitted by their real producer, and the Signal Ledger's `storyTitle`
  seam resolves real story titles (write-through cache over the story store,
  demo fixtures as fallback).
- **WS-D `exportContributions`**: the DSAR export now includes ALL of the
  user's submitted stories — the hook keyset-paginates `listBySubmitter` to
  exhaustion (no truncation cap; the export must be COMPLETE, §19.3 / GDPR
  Art. 15).  WS-G composes forum contributions, evidence cards, and room
  subscriptions into the same hook, and `anonymizeContributions` is closed
  by WS-G too (`docs/forum/README.md`) — story/contribution rows carry no
  scrubbable PII: the tombstoned user row is the anonymization and public
  contributions persist per §22.4.

## Residuals (tracked for later workstreams)

- **WS-G (CLOSED)**: the full Thread/Contribution schema owns the shell
  table (migration 0008 recreated the enums with USING maps); evidence
  flows attach explicit material × relationship types; lens-tagged
  contributions provide the per-lens interpretation entity; room visibility
  gates thread/contribution reads.  See `docs/forum/README.md`.
- **WS-H**: MERI/SCOI consumption of the similarity helpers and signature
  grouping; semantic conclusions gated on a self-hosted embedding model;
  the story→interpretation embedding join for `findSimilarInterpretations`.
- **WS-I**: freshness-baseline consumption (WS-I.2.3d) and search/feed
  ranking beyond textual relevance.
- **WS-J**: the full moderation queue takes ownership of the ingestion
  review inbox (`ingestion_review_items`) and the takedown console.
- **WS-K**: the governed claim extractor, topic/sensitivity classifiers, and
  the model registry replace the heuristic defaults behind the existing
  seams (`ClaimExtractor`, `detectLanguage`/`classifySensitivity` fallbacks,
  `EMBEDDING_MODEL_REGISTRY`).
- **Client surfaces**: the WS-G composer ships CONTRIBUTION submission
  end-to-end; the story-URL submission UI and the search page still need to
  consume the typed RPC contract (WS-C follow-ups); browser-level E2E for
  the submission flow needs the BFF-in-the-loop harness (WS-P, the WS-D
  precedent) — the CSRF token round-trip is integration-tested at the
  full-app level meanwhile.
- **Full-scale (1 M) load validation**: the latency/recall benchmarks are
  measured at N = 20 000 (operating-point table above); validating the same
  constants at the 1 M-story / 100K-embedding target is a WS-P load-harness
  concern.  Topic classification stays unmapped until the WS-K topic taxonomy
  exists (the field accepts submitter-supplied topics meanwhile, the soft
  WS-K.1.3a dependency).

## WS-Q deltas — room-owned content, visibility, and media

WS-Q makes every story belong to a room and carry a visibility tier, and
adds native image/video posts.  The submission flow above gains room and
visibility guards; dedup, search, and event classification all become
tier-aware.

- **Room ownership (`Story.room_id` NOT NULL).** `submitStory` now takes the
  target room and runs a room guard chain before any safety pre-check: room
  existence (absent → 404), access (an outsider to a **private** room → 404,
  no oracle; a public room auto-joins the submitter), and posting policy (a
  member who fails `userMayPostTopLevel` → `403 posting_restricted`).  The
  story's thread shell is stamped with the same `room_id` (a DB trigger,
  `enforce_thread_room_consistency`, makes the thread↔story room agreement a
  schema invariant).  Pre-WS-Q content backfills to the Commons room.
- **Visibility forcing.** `deriveStoryVisibility(roomVisibility, requested?)`
  computes the stored tier: a story in a **private** room is forced
  `room_only` regardless of request (a `forced` metric fires when a requested
  `public` is clamped); in a public room the author chooses
  `public | room_only` (default `public`).
- **Tier-scoped canonical-URL dedup.** Exact-URL uniqueness is now scoped by
  tier — `public` stories are unique **globally**, `room_only` stories are
  unique **per room** — enforced by two partial unique indexes
  (`stories_canonical_url_public_uq`, `stories_canonical_url_room_uq`) and the
  matching `getByCanonicalUrl(url, tier)` store split.  A duplicate in the
  same tier is the usual `409` carrying the existing story id; when a
  `room_only` submission matches a live **public** story the new row is
  cross-linked via `canonical_public_story_id` (the "this also exists publicly"
  pointer) rather than rejected.
- **Takedown reach across tiers.** The canonical-URL takedown denylist is
  re-checked on every submission and every widen through `hasHiddenForUrl`
  (no new table — it reads the existing hidden-state rows), so a URL taken
  down in one tier cannot re-enter through the other.
- **Near-duplicate scope.** MinHash/LSH near-dup flagging runs **only for
  public stories** (`findNearDuplicates(signatures, stores, …)` filters
  candidates to live public content); `room_only` content is never
  near-dup-correlated across rooms, preserving room containment.
- **Media intake (`image_post` / `video_post`).** The two new §14.1
  submission types carry an owned, correctly-typed, scan-gated,
  claim-unique `media_upload_ref`: the upload must belong to the submitter,
  match the post type's content-type allowlist (images, or `video/mp4` /
  `video/webm` up to the 200 MB ceiling), be unreferenced by any other story,
  and have cleared scanning — a flagged upload is `403`, a still-pending scan
  holds the story (`hiddenState='safety'` + a review item) instead of
  publishing it.  At creation each media upload (main media, caption track,
  poster) is back-linked to the story (`uploads.owner_story_id`) so the
  serving route can re-derive its visibility: a `room_only` story's media is
  served ONLY through a short-lived signed URL minted after the read-bar check,
  and a taken-down story's media is refused at fetch time (WS-Q.5.2c; see
  `docs/forum/README.md` → restricted-media serving gate).
- **Author visibility transitions.** `changeStoryVisibility` (in
  `ingestion/visibility.ts`) is the author-only narrow/widen: narrowing
  `public → room_only` always succeeds; widening `room_only → public` is
  `422` inside a private room, and otherwise re-runs the full public-entry
  gate (takedown denylist, tier dedup → `409` + pointer, public near-dup)
  before flipping the tier.  Every transition audits `story_visibility_change`
  and emits `content.visibility.changed` (`trigger=author`).
- **Two-tier search predicate.** The search index carries each document's
  story visibility and its room's visibility.  A query with no `?room=`
  returns only `public`-from-a-`public`-room documents; `?room=<id>` returns
  that room's documents (subject to the caller's content bar).  Both the
  in-memory and Postgres (`storyVisibilityFilter`/`ownerVisibilityFilter`)
  indexes enforce the same predicate.
- **Content-event classification firewall (WS-Q.1.7c).**
  `content.submitted` / `content.normalized` / `content.visibility.changed`
  carry a `privacy_classification` coupled to the story tier
  (`public → 'public'`, `room_only → 'restricted'`, via
  `contentEventClassification`), and the consumer router delivers each event
  only to consumers cleared for its classification.  In-room content thus
  never reaches a `public`-only consumer — the same containment the
  distribution side enforces, applied at the event boundary.  The stored
  event row is persisted with the event's own classification (not a static
  topic default), so replay/redrive preserve containment too.
- **Video caps + rollout flags (`ingestion/config.ts`, `content-flags.ts`).**
  Steward-tunable, fail-closed `ingestion.video_max_bytes` (clamped to the hard
  200 MB DB ceiling) and `ingestion.video_max_seconds` bound native video.
  Three fail-closed WS-Q.6.2 rollout flags — `content.media_posts_enabled`,
  `content.in_room_visibility_enabled`, `rooms.binary_visibility_ui` — gate the
  user-visible surface (ON by default, steward-toggleable, audited); CONTAINMENT
  IS NOT FLAGGABLE (a private room still forces `room_only` with the flag off,
  and the distribution gate/read bar have no off switch).
- **Migration validation harness** (`packages/db/.../migration-harness.test.ts`,
  gated): seeds a pre-WS-Q dataset (public/restricted/expert_led rooms;
  thread-roomed, room-less, near-duplicate public stories) in a throwaway
  database, runs the WS-Q chain, and asserts the monotonic-visibility property
  (a story is public iff its home room is public), no room-less story, axis
  derivation, near-dup survival, and backfill/seed idempotency.
