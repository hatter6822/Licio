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
   pattern, locally-maintained malware/phishing domain denylist (403)
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
computed in BigInt (the product exceeds 2⁵³).  The family is generated from a
pinned seed and frozen as `MINHASH_FAMILY_VERSION = 1` — signatures are
persisted (`story_signatures`, bytea, big-endian uint32) and compared across
machines, so the family may never silently change.

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
vectors written alongside the old version) → `validateBackfill` (mean
top-k neighbor-set Jaccard overlap, the human-facing drift metric) → atomic
cutover by flipping `ingestion.embeddingActiveVersion` → steward-triggered
cleanup of the superseded version (refused for the ACTIVE version).

Similarity helpers (WS-F.3.2d, `packages/db/src/similarity.ts`):
`findSimilarStories` / `findSimilarClaims` (≥ threshold, hidden/retracted
excluded), `findSimilarInterpretations` (pairwise similarity over supplied
interpretation ids, LOW pairs first — SCOI divergence; the
story→interpretation join arrives with WS-G.2's entity, documented seam),
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
row) and updated incrementally (topics, evidence-type counts).  Steward
edits (WS-F.2.3a) run through `PATCH /v1/ingestion/admin/sources/:id` with
one immutable audit record per edited field (before → after → reason).

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
consumer failures.  SCOI/evidence-gap triggers (`scoi_evidence_gap`,
`context_added`, …) arrive with WS-H/WS-G through the same
`applyLifecycleTrigger` seam.

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

## Closed residuals from earlier workstreams

- **WS-E "story emission"**: `content.submitted` / `content.normalized` are
  now emitted by their real producer, and the Signal Ledger's `storyTitle`
  seam resolves real story titles (write-through cache over the story store,
  demo fixtures as fallback).
- **WS-D `exportContributions`**: the DSAR export now includes the user's
  submitted stories (WS-G composes forum contributions into the same hook
  when it lands; `anonymizeContributions` remains WS-G's — story rows carry
  no scrubbable PII: the tombstoned user row is the anonymization and public
  contributions persist per §22.4).

## Residuals (tracked for later workstreams)

- **WS-G**: the full Thread/Contribution schema takes ownership of the
  shell table (enums already superset the WS-C vocabulary so no destructive
  migration); evidence flows with explicit relationship types; community
  interpretations (which also unlock the story→interpretation join for
  `findSimilarInterpretations` and interpretation embeddings); room
  visibility in search.
- **WS-H**: MERI/SCOI consumption of the similarity helpers and signature
  grouping; semantic conclusions gated on a self-hosted embedding model.
- **WS-I**: freshness-baseline consumption (WS-I.2.3d) and search/feed
  ranking beyond textual relevance.
- **WS-J**: the full moderation queue takes ownership of the ingestion
  review inbox (`ingestion_review_items`) and the takedown console.
- **WS-K**: the governed claim extractor, topic/sensitivity classifiers, and
  the model registry replace the heuristic defaults behind the existing
  seams (`ClaimExtractor`, `detectLanguage`/`classifySensitivity` fallbacks,
  `EMBEDDING_MODEL_REGISTRY`).
- **Client surfaces**: story-submission UI and the search page consume the
  now-typed RPC contract (tracked with WS-C follow-ups/WS-G); browser-level
  E2E for the submission flow needs the BFF-in-the-loop harness (WS-P, the
  WS-D precedent) — the CSRF token round-trip is integration-tested at the
  full-app level meanwhile.
- **Performance benchmarks at 100K+ scale** (WS-F.1.3b/3.2d latency
  targets): the query plans are EXPLAIN-asserted today; corpus-scale
  benchmarks belong to the WS-P load harness.
