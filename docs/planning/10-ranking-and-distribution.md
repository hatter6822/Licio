# WS-I. Ranking and Distribution

**Milestone:** M2-M3 | **Priority:** 2-3 | **Dependencies:** WS-E.2 (PWAtt v1), WS-H (all invariants), WS-F (ingestion/source/search), WS-G (forum/rooms/lenses for thread candidates), WS-A.1.1 (signal denylist doctrine), WS-J.2 (moderation state for safety filter) | **Wave:** 5-6 | **Estimated duration:** 4-5 weeks

## Overview

The ranking pipeline assembles PWAtt scores, invariant outputs, and safety constraints into a feed. It NEVER uses likes, upvotes, follower counts, wallet activity, payments, or donor status. A schema-level denylist prevents financial data from entering ranking features. 10 automated neutrality tests run in CI before every crypto release.

This workstream implements the ranking stages defined in SPEC Section 13.3 as discrete, independently testable pipeline components, in this canonical order:

```
candidate generation → invariant feature join (feature store)
  → safety filter → multi-objective scoring (PWAtt + penalties + constraints)
  → diversification (matroid dedup, source/topic/lens balancing, SCOI gating)
  → decision logging → explanation generation → feed response
```

Every stage emits a structured contribution to the per-request `RankingDecisionLog` (Section 23.3) so that any feed can be replayed deterministically from logs at the recorded invariant versions. The pipeline is owned by the Ranking service, which per Section 21.5 owns "candidate scoring, constraints, explanations" but does NOT own policy-enforcement decisions (Moderation) or product policy thresholds (Invariants). Ranking reads only sanitized, aggregate governance context — never wallet wealth or payment amounts (Section 21.5).

### Data-shape conventions

Each pipeline stage has a typed input and output. The shapes referenced throughout this document:

- **`Candidate`** — `{ item_id, item_type, source_type, room_id?, topic_ids[], source_id, freshness_timestamp, retrieval_score, retrieval_origin }`. Produced by candidate generation (WS-I.1).
- **`FeatureVector`** — the per-item feature record defined in WS-I.2.1a. Produced by the feature store, consumed by scoring and diversification.
- **`ScoredItem`** — `{ item_id, pwatt_score, score_components, penalty_components, baseline, constraint_flags[] }`. Produced by scoring (WS-I.2.3).
- **`FeasibleSet`** — candidates remaining after the safety filter and hard-constraint enforcement.
- **`FeedResponse`** — ordered `FeedItem[]` (Section 23.3: `{ story_id, title, source_summary, rating_label, distribution_reason, context_chips[], reader_state, thread_preview, safety_state, user_controls }`) plus an attached `request_id`.
- **`RankingDecisionLog`** — the audit record defined in WS-I.2.5a.

All shapes are defined as zod schemas co-located with their TypeScript types in `packages/ranking/src/schemas/` and validated at stage boundaries.

---

## WS-I.1 Candidate generation

### WS-I.1.1a Candidate source definitions
**ID:** WS-I.1.1a
**Ref:** Section 13.2

**Description:**
Define the complete set of candidate sources for feed generation. Each source type has a retrieval strategy, a relevance heuristic, and a freshness window. The sources are:

- **Subscribed rooms** -- stories and threads from rooms the user has joined, weighted by recency and user activity in the room.
- **Local/regional news** -- location-scoped stories based on user-configured location preferences (never inferred from precise device location without consent).
- **Global candidates** -- front-page-eligible stories that meet a minimum PWAtt threshold across rooms.
- **Emerging discussions** -- threads with high constructive participation velocity (evidence additions, corrections, synthesis) that have not yet reached broad distribution.
- **Independent source additions** -- new evidence cards or primary sources added to existing stories, surfaced when the original story was previously seen.
- **Cross-community bridges** -- content being discussed across multiple rooms where SCOI indicates interpretation divergence, surfaced with context.
- **Expert explanations** -- high-quality summaries and explanations from domain-specific rooms or steward-curated threads.
- **Chronological catch-up** -- recent items the user has not seen, ordered by time, for users returning after absence.

Each source type produces a candidate set with metadata: `source_type`, `room_id` (if applicable), `freshness_timestamp`, `retrieval_score`, and `retrieval_origin` (the named retriever that produced it, for audit). No candidate source uses follower count, wallet balance, payment history, or donor status as a retrieval signal. Each retriever is implemented as a function conforming to a `CandidateRetriever` interface (`retrieve(user, context, limit): Promise<Candidate[]>`) so retrievers are independently testable and the set is extensible.

**Acceptance criteria:**
- All eight candidate source types are implemented and produce candidates.
- Each candidate carries `source_type` and `retrieval_origin` metadata.
- Candidate retrieval queries contain zero references to wallet, payment, follower-count, or donor tables.
- Chronological catch-up respects the user's last-seen timestamp per room.
- Global candidates use the PWAtt threshold, not popularity or engagement count.
- Cross-community bridge candidates include SCOI context metadata.
- Each retriever conforms to the `CandidateRetriever` interface and is registered in a retriever registry.

**Testing:**
- Unit tests for each source retrieval function with fixture data.
- Integration test that all eight source types contribute to a combined candidate set.
- Negative test: inject wallet/payment fields into candidate query parameters and verify retrieval rejects them or produces identical results.
- Performance test: candidate retrieval completes within the latency budget for a 10k candidate pool.
- Interface conformance test: every registered retriever satisfies the `CandidateRetriever` interface at compile time.

**Dependencies:** WS-F.1 (story/claim schema), WS-F.2 (source model), WS-G.1 (thread schema for emerging-discussion candidates), WS-H.4 (SCOI for cross-community bridges), WS-E.2 (PWAtt for global threshold). No dependency on any WS-L/WS-M financial module.

**Observability:** Each retriever emits `candidate.retrieval.completed` with `retrieval_origin`, candidate count, latency, and empty-result flag. A dashboard tracks per-retriever contribution share and latency percentiles.

**Security/privacy:** Location-scoped retrieval uses only user-configured location, never precise device geolocation without explicit consent (Section 19). Retriever queries are statically constrained to the social schema; the financial bounded context (Section 21.5) is not reachable from this module's dependency graph.

---

### WS-I.1.1b Diversity quotas
**ID:** WS-I.1.1b
**Ref:** Section 13.2

**Description:**
Enforce minimum quotas for fresh, independent, and local sources per feed request to prevent personalization collapse. Each feed response must include:

- A minimum percentage of items from sources the user has not previously seen (fresh sources).
- A minimum percentage of items from independent publishers (not syndicated copies of the same article, verified via MERI).
- A minimum percentage of items from local/regional sources when the user has a configured location.

Quotas are configurable per surface (front page, room feed, topic feed) and are enforced after candidate retrieval but before ranking, so the ranker operates on a sufficiently diverse candidate pool. Quota shortfalls are logged for monitoring. When insufficient candidates exist to meet a quota (e.g., a new user with no location set), the system degrades gracefully and logs the shortfall.

**Acceptance criteria:**
- Fresh-source quota is configurable and enforced (default minimum 15% of candidates).
- Independent-source quota is configurable and enforced (default minimum 20% of candidates).
- Local-source quota is configurable and enforced when location is set (default minimum 10% of candidates).
- Quota shortfalls are logged with the feed `request_id` and the shortfall amount.
- Quotas are applied per surface type.
- Graceful degradation when the candidate pool is too small to meet quotas.

**Testing:**
- Unit test: given a candidate pool with known source distribution, verify quotas are enforced.
- Unit test: verify graceful degradation when the candidate pool is smaller than quota requirements.
- Integration test: feed request logs show quota compliance or shortfall entries.
- Regression test: a personalization-heavy user still receives fresh and independent sources.

**Dependencies:** WS-I.1.1a (candidate sources), WS-H.2 (MERI for independent-source verification), WS-D.2 (user location preference). 

**Observability:** Emit `candidate.quota.evaluated` per surface with `{ quota_type, target_pct, achieved_pct, shortfall }`. A "personalization collapse" alert fires when fresh-source achieved percentage stays below target across a configurable rolling window for a cohort.

**Security/privacy:** Fresh-source determination reads only the user's own seen-history (privacy-bucketed); it does not expose other users' reading behavior.

---

### WS-I.1.1c Financial data exclusion verification (candidate stage)
**ID:** WS-I.1.1c
**Ref:** Sections 13.2, 13.6, 30.6

**Description:**
Automated test that candidate retrieval has zero dependency on wallet, payment, follower-count, or donor data. This test runs in CI and validates that the candidate retrieval pipeline cannot access or be influenced by financial data.

The test inspects:
- SQL/query definitions used by candidate retrieval for any JOIN or reference to wallet, payment, treasury, donor, follower-count, or token tables.
- Function signatures and imports in the candidate retrieval module for any dependency on financial data modules.
- Runtime behavior: two identical users with different wallet/payment states produce identical candidate sets.

This task is the candidate-stage counterpart of the schema-level denylist (WS-I.2.1b) and feeds the full neutrality suite (WS-I.3); it specifically guards the retrieval boundary.

**Acceptance criteria:**
- CI test passes on every commit that touches candidate retrieval code.
- Static analysis of candidate retrieval queries finds zero references to financial tables.
- Dependency analysis of the candidate retrieval module finds zero imports from wallet/payment/treasury modules.
- Runtime test with identical users (one with wallet, one without) produces identical candidate sets.

**Testing:**
- Static analysis test scanning query definitions for denied table names.
- Module dependency graph test verifying no path from candidate retrieval to financial modules.
- Integration test: create two test users with identical behavior but different wallet states; verify identical candidate sets.
- CI gate: the test must pass before merge for any file in the candidate retrieval path.

**Dependencies:** WS-I.1.1a (candidate sources), WS-0.4 (CI static-analysis tooling), WS-A.1.1 (canonical denied-signal/table list).

**Observability:** CI emits a `neutrality.candidate.exclusion` result artifact per run; failures page the ranking on-call and block merge.

**Security/privacy:** This task is itself a privacy/integrity control. The denied-table list is sourced from the shared denylist configuration (WS-I.2.1b) so candidate-stage and feature-store-stage controls cannot drift apart.

---

### WS-I.1.1d Candidate generation orchestrator
**ID:** WS-I.1.1d
**Ref:** Sections 13.2, 13.3

**Description:**
Implement the orchestrator that invokes all registered retrievers (WS-I.1.1a), merges their outputs into a single deduplicated candidate pool keyed by `item_id`, applies diversity quotas (WS-I.1.1b), and emits the combined `Candidate[]` to the feature-join stage. The orchestrator handles per-retriever failure gracefully (a failing retriever is skipped and logged, never crashing the pool), enforces an overall candidate-pool size budget, and records each candidate's `retrieval_origin` and `retrieval_score`. When the same item is produced by multiple retrievers, origins are merged into a list and the highest retrieval score is retained.

This task establishes the first stage boundary of the pipeline and the entry point that the scoring orchestrator (WS-I.2.3e) consumes.

**Acceptance criteria:**
- Orchestrator invokes all registered retrievers and merges their results into a deduplicated pool.
- Duplicate items across retrievers are merged with a combined `retrieval_origin` list.
- A failing retriever is skipped with a logged gap event; the pool still returns.
- Overall pool size respects a configurable budget.
- Quotas (WS-I.1.1b) are applied to the merged pool.
- The orchestrator output is validated against the `Candidate` zod schema at the stage boundary.

**Testing:**
- Unit test: merge of overlapping retriever outputs deduplicates correctly and merges origins.
- Unit test: a thrown error in one retriever does not prevent the pool from returning.
- Unit test: pool size is capped at the configured budget.
- Integration test: full orchestrator run produces a quota-compliant, schema-valid pool from fixtures.

**Dependencies:** WS-I.1.1a, WS-I.1.1b, WS-I.1.1c.

**Observability:** Emit `candidate.pool.assembled` with `{ request_id, total_candidates, per_origin_counts, skipped_retrievers[], duration_ms }`. The skipped-retriever rate feeds an availability dashboard.

**Security/privacy:** The orchestrator never logs raw `user_id`; it logs the `user_privacy_bucket` only. The candidate pool carries no financial fields by construction (validated at the stage boundary).

---

## WS-I.2 Ranking pipeline

### WS-I.2.1a Feature vector schema
**ID:** WS-I.2.1a
**Ref:** Sections 5.4, 13.3, 22.1, 30.6

**Description:**
Define the per-item feature vector schema used by the ranking pipeline. The schema includes all fields necessary for PWAtt scoring, invariant constraint enforcement, and diversification. Fields:

- **PWAtt components:** `ActiveAttention`, `ConstructiveParticipation`, `ExposureIndependence`, `SourceAndEvidenceCompleteness`, `ContextCoherenceGain` (each as a normalized float in `[0,1]`).
- **Invariant signals:** `MERI_rank` (integer), `MFCI_score` (float + `risk_state` enum), `SCOI_level` (enum: low/medium/high/very_high), `PHI_risk` (float), `GWEI_cohort_disparity` (float).
- **Penalty terms:** `CoordinationPenalty` (from MFCI), `HolonomyRisk` (from PHI), `HarmfulTensionRisk` (from Hodge), `RedundancyPenalty` (from MERI).
- **Baseline components:** `freshness_decay` (float, time-based), `source_reliability` (float, from source history), `topic_relevance` (float, user interest match).
- **Supporting invariants:** `Hodge_harmonic_tension` (float), `TropicalCascade_rank` (float), `BraidAgenda_entropy` (float), `ReebLandscape_basin_id` (string), `CID_defect` (float), `PathSignature_wellbeing` (float).
- **Metadata:** `item_id`, `item_type`, `room_id`, `topic_ids`, `source_id`, `created_at`, `feature_version`, `invariant_versions` (map of `invariant_name` to version string).

The schema is defined as a zod schema co-located with the TypeScript type and validated at write time. The field set is closed: zod `.strict()` rejects any unknown field, which together with the denylist (WS-I.2.1b) provides defense in depth against financial-field injection. The schema maps onto the `InvariantOutput` entity (Section 22.1) for invariant-derived fields and lives in the feature store described in Section 21.2 ("payment/wallet fields excluded").

**Acceptance criteria:**
- Feature vector schema is defined with all listed fields and their types.
- zod schema validates feature vectors at write time and uses strict mode (unknown fields rejected).
- TypeScript type is generated from or co-located with the zod schema.
- Schema includes the `invariant_versions` map for audit traceability.
- All field names are documented with their source (which service or invariant produces them).
- Schema contains zero fields related to wallet, payment, treasury, donor, or follower count.

**Testing:**
- Unit test: valid feature vectors pass schema validation.
- Unit test: feature vectors with missing required fields are rejected.
- Unit test: feature vectors containing denied fields (wallet, payment, etc.) are rejected (strict mode + denylist).
- Schema snapshot test to detect unreviewed field additions.

**Dependencies:** WS-H.1.1a (InvariantOutput table), WS-H.2/H.3/H.4/H.5/H.6/H.7 (invariant outputs), WS-E.2 (PWAtt components), WS-F.2 (source reliability inputs).

**Observability:** Schema version changes emit a `feature.schema.version.changed` event; a registry tracks current `feature_version` and the set of `invariant_versions` populating it.

**Security/privacy:** Strict-mode closure is a primary control preventing financial fields from ever appearing in the feature store. The schema is the canonical contract referenced by neutrality tests 2 and 3 (WS-I.3.1b, WS-I.3.1c).

---

### WS-I.2.1b Schema-level denylist
**ID:** WS-I.2.1b
**Ref:** Sections 13.6, 24.4, 30.6

**Description:**
Implement a schema-level denylist that rejects any attempt to write wallet, token, payment, treasury, follower-count, or donor fields into the feature store. The denylist operates at the validation layer -- any feature vector containing a denied field name or a field matching a denied pattern produces a validation error and is not written. This realizes the Section 24.4 requirement that "wallet, token, payment, and treasury fields are excluded from organic ranking features by schema."

The denied field patterns include: `wallet*`, `token*`, `payment*`, `treasury*`, `donor*`, `follower*`, `balance*`, `stake*`, `vote_weight*`, `membership_tier*`, `subscription_amount*`. Matching is case-insensitive and also catches nested/prefixed forms (e.g., `user_wallet_address`, `paymentAmountUsd`). The denylist is maintained as a versioned configuration sourced from the shared doctrine denylist (WS-A.1.1), and any modification requires a code review with explicit approval from the ranking team. The rejection raises a typed `DeniedFinancialFieldError` carrying the offending field, the matched pattern, and the denylist version.

**Acceptance criteria:**
- Feature store write operations validate against the denylist before persisting.
- Any feature vector containing a denied field is rejected with a descriptive validation error (`DeniedFinancialFieldError`).
- The denylist is defined as a versioned configuration file, not inline code, and references the WS-A.1.1 canonical list.
- Denylist modifications trigger a CI notification and require explicit review.
- The validation error includes the denied field name, the matched pattern, and the denylist version.
- Rejected writes are logged with request context for audit.
- Pattern matching is case-insensitive and matches nested/prefixed field names.

**Testing:**
- Unit test: attempt to write a feature vector with each denied pattern; verify rejection.
- Unit test: valid feature vectors without denied fields are accepted.
- Unit test: nested/prefixed denied field names (e.g., `user_wallet_address`) are rejected.
- Integration test: end-to-end write attempt with a denied field from the feature population pipeline is rejected.
- CI gate: any change to the denylist configuration file triggers the full neutrality test suite.

**Dependencies:** WS-I.2.1a (feature schema), WS-A.1.1 (canonical denied-signal list), WS-0.4 (CI gating).

**Observability:** Emit `feature.write.denied` with `{ denied_field, matched_pattern, denylist_version, source_pipeline, request_context }`. A denial counter that rises above zero in production triggers a security alert (a denial in production implies an upstream component is attempting to smuggle financial data).

**Security/privacy:** This is the load-bearing pay-to-rank control at the write boundary. It is paired with the read-boundary control (WS-I.1.1c) and the strict-schema closure (WS-I.2.1a) for defense in depth. Denylist edits are an audited, dual-control change.

---

### WS-I.2.1c Feature versioning
**ID:** WS-I.2.1c
**Ref:** Sections 21.4, 30.6

**Description:**
Track which invariant versions produced each feature in the feature store. Every feature vector records the exact version of each invariant service that contributed to its fields. This enables:

- Auditing which invariant version was active when a ranking decision was made.
- Replaying rankings with the same invariant versions.
- Detecting when an invariant upgrade changes ranking behavior.

The versioning system stores: `invariant_name`, `version_string`, `computation_timestamp`, and `config_hash` (hash of the invariant's configuration at computation time). Feature vectors carry an `invariant_versions` map that is immutable after write. The map is the join key used by replay (WS-I.2.5b) to fetch the feature state exactly as it was at decision time.

**Acceptance criteria:**
- Every feature vector includes an `invariant_versions` map with entries for each contributing invariant.
- Version entries include `invariant_name`, `version_string`, `computation_timestamp`, and `config_hash`.
- The `invariant_versions` map is immutable after the feature vector is written.
- A query API returns the invariant versions for any feature vector by `item_id` and `timestamp`.
- Version changes are logged when an invariant service is upgraded.

**Testing:**
- Unit test: feature vectors without `invariant_versions` are rejected at write time.
- Integration test: upgrade an invariant version, verify new feature vectors carry the updated version.
- Audit query test: retrieve invariant versions for a specific ranking decision and verify they match the feature vector.
- Replay test: given a decision log entry, retrieve the feature vector with matching invariant versions.

**Dependencies:** WS-I.2.1a (schema), WS-H.1.1b (InvariantOutput versioning), WS-H.1.2b (invariant card with version).

**Observability:** Emit `invariant.version.observed` aggregates so dashboards can show the distribution of invariant versions in production feature vectors and detect a stalled rollout.

**Security/privacy:** `config_hash` allows detecting silent configuration changes without exposing the configuration contents themselves.

---

### WS-I.2.1d Feature store population pipeline
**ID:** WS-I.2.1d
**Ref:** Sections 13.3, 21.2, 21.4

**Description:**
Implement the batch and real-time update paths for populating the feature store. The pipeline receives invariant outputs (via the `invariant.run.completed` topic, Section 21.3) and assembles them into complete feature vectors.

- **Real-time path:** as invariant services compute new values (MFCI state change, SCOI level update, new PWAtt score), the feature store is updated incrementally. Updates are idempotent and carry a monotonic version number to prevent stale overwrites.
- **Batch path:** periodic recomputation of all feature vectors from source invariant data. Used for backfills after invariant upgrades, cold-start bootstrapping, and consistency reconciliation. Batch runs produce a new feature version and do not overwrite real-time updates that are more recent.

The pipeline validates every feature vector against the schema (WS-I.2.1a) and denylist (WS-I.2.1b) before writing.

**Acceptance criteria:**
- Real-time updates propagate invariant changes to the feature store within the latency budget (target: under 5 seconds for MFCI state changes).
- Batch recomputation completes within the scheduled window and produces consistent feature vectors.
- Stale real-time updates are rejected via the monotonic version check.
- Batch does not overwrite real-time updates that are more recent.
- All writes pass schema validation and denylist checks.
- Pipeline failures are logged, alerted, and do not corrupt existing feature data.

**Testing:**
- Unit test: a real-time update with a newer version succeeds; with a stale version is rejected.
- Integration test: an invariant service publishes a new MFCI score; verify the feature store is updated within the latency budget.
- Batch test: run a batch recomputation and verify all feature vectors are valid and versioned.
- Failure test: simulate a pipeline error and verify existing feature data is not corrupted.
- Denylist test: a batch pipeline attempting to write denied fields is rejected.

**Dependencies:** WS-I.2.1a, WS-I.2.1b, WS-I.2.1c, WS-H.1 (invariant platform + `invariant.run.completed` events), WS-E.2 (PWAtt outputs).

**Observability:** Emit `feature.store.updated` (real-time) and `feature.store.batch.completed` (batch) with freshness lag, write counts, rejection counts, and per-invariant coverage. A staleness dashboard tracks the oldest unrefreshed feature per surface.

**Security/privacy:** Every write path (real-time and batch) passes through the same denylist gate; there is no privileged write path that bypasses validation.

---

### WS-I.2.2a Safety filter stage
**ID:** WS-I.2.2a
**Ref:** Sections 13.3, 13.4, 24.4

**Description:**
Implement the safety filter stage (`remove_policy_disallowed` in the Section 13.4 pseudo-code) that runs after feature join and before scoring. The filter removes or restricts policy-violating content based on moderation state owned by the Moderation service (Section 21.5), not by ranking. The filter excludes: content under active removal, legally restricted content for the requesting jurisdiction, content age-inappropriate for the requesting user (Section 19 minor-safety limits), and content with an active steward hold. Per Section 24.4, ranking "cannot override content removals, severe coordination freezes, minor-safety limits, user personalization-off settings, privacy deletion/retention states." The safety filter is the enforcement point for these non-overridable constraints; scoring runs only on what survives the filter.

The filter reads moderation state via a read-only interface to WS-J; it never computes policy itself. Every exclusion is recorded for the decision log with the `policy_reason` and the moderation case reference (if applicable).

**Acceptance criteria:**
- The safety filter runs after feature join and before scoring.
- Content under active removal, legal restriction, age-inappropriateness, or steward hold is excluded.
- The filter reads moderation/jurisdiction state; it does not compute policy.
- Ranking cannot re-include content the safety filter removed (the filter result is authoritative).
- Personalization-off and privacy-deletion states are honored at this stage.
- Every exclusion is recorded with `item_id`, `policy_reason`, and `moderation_case_ref`.

**Testing:**
- Unit test: an item under active removal is excluded regardless of PWAtt score.
- Unit test: a high-scoring item that is age-inappropriate for the requesting user is excluded.
- Unit test: a personalization-off user's feed does not apply personalized topic relevance.
- Integration test: an item placed under steward hold disappears from feeds within the propagation budget.
- Negative test: scoring code has no path to re-admit a safety-filtered item.

**Dependencies:** WS-J.2 (moderation state/actions), WS-N.1 (jurisdiction engine for legal restriction), WS-D.1.7 (age gating), WS-D.2 (personalization-off and privacy-deletion states), WS-I.2.1d (feature store, for join ordering).

**Observability:** Emit `ranking.safety_filter.applied` with `{ request_id, excluded_count, exclusions:[{item_id, policy_reason}] }`. A dashboard tracks exclusion rate by reason; an anomalous spike (e.g., jurisdiction misconfiguration) alerts operations.

**Security/privacy:** The filter is the boundary that enforces minor-safety and privacy-deletion states in ranking. It honors personalization-off without leaking that a user disabled personalization to other surfaces.

---

### WS-I.2.3a PWAtt score computation
**ID:** WS-I.2.3a
**Ref:** Sections 5.4, 5.5

**Description:**
Implement the PWAtt score computation as defined in the spec. The scoring function computes:

    PWAtt = B + wA*ActiveAttention + wP*ConstructiveParticipation + wE*ExposureIndependence
            + wS*SourceAndEvidenceCompleteness + wC*ContextCoherenceGain
            - pM*CoordinationPenalty - pH*HolonomyRisk - pT*HarmfulTensionRisk - pR*RedundancyPenalty

The five positive weights (wA, wP, wE, wS, wC) are normalized to sum to 100% per ranking profile. Weight ranges are enforced: wA 20-30%, wP 25-40%, wE 10-20%, wS 5-15%, wC 5-15%. A deployed profile must choose shares within those ranges that jointly sum to 100% (e.g., 30/40/15/10/5). Weights vary by surface, topic sensitivity, freshness, age group, jurisdiction, and risk state. Each ranking profile is a named configuration specifying weights within the allowed ranges. The penalty coefficients (pM, pH, pT, pR) are NOT part of the convex combination; they are handled in WS-I.2.3b.

**Acceptance criteria:**
- The PWAtt function accepts a feature vector and a ranking profile, returns a score.
- Positive weights sum to exactly 100% for every ranking profile.
- Each weight is within its specified range (wA 20-30%, wP 25-40%, wE 10-20%, wS 5-15%, wC 5-15%).
- A ranking profile with weights outside the allowed ranges is rejected at load time.
- Penalties are separate nonnegative coefficients, not part of the weight normalization.
- Baseline B is on the same scale as the normalized positive score.
- The breaking-news profile emphasizes timeliness; the evergreen profile emphasizes evidence and synthesis.

**Testing:**
- Unit test: compute PWAtt with known inputs and verify output matches the expected value.
- Unit test: a ranking profile with weights summing to != 100% is rejected.
- Unit test: a ranking profile with a weight outside its range (e.g., wA = 50%) is rejected.
- Property test: for any valid ranking profile, positive weights sum to 100% (generative fuzzing over the allowed ranges).
- Comparison test: the breaking-news profile produces higher scores for fresh, source-verified content; the evergreen profile produces higher scores for evidence-rich content.

**Dependencies:** WS-I.2.1a (feature vector), WS-I.2.3f (ranking profile schema/loader), WS-E.2 (PWAtt component definitions).

**Observability:** Emit per-request score distribution summaries (min/median/max PWAtt, fraction negative). A drift monitor compares the live PWAtt distribution against the prior baseline and flags large shifts coinciding with profile or invariant changes.

**Security/privacy:** Scoring inputs are exactly the feature vector fields; because the feature vector cannot contain financial fields (WS-I.2.1a/b), scoring is structurally incapable of pay-to-rank. This is asserted by neutrality tests 1-3.

---

### WS-I.2.3b Penalty application
**ID:** WS-I.2.3b
**Ref:** Sections 5.4, 5.5

**Description:**
Implement the four penalty terms as separate nonnegative subtractive components. Each penalty is computed from its corresponding invariant signal:

- **pM (CoordinationPenalty):** derived from MFCI score and tropical cascade signals. Higher MFCI risk states produce larger penalties. Severe coordination freezes trend acceleration.
- **pH (HolonomyRisk):** derived from PHI. High-holonomy loops produce increasing penalties. Sensitive topics (self-harm, eating disorders, medical misinformation, extremist ideology) use stricter thresholds.
- **pT (HarmfulTensionRisk):** derived from Hodge harmonic tension combined with safety classifiers. Harmonic tension alone never penalizes legitimate sustained disagreement -- the penalty requires both high tension and hostility/safety signals.
- **pR (RedundancyPenalty):** derived from MERI redundancy rank. Repeated copies of the same claim from the same source lineage accumulate increasing penalties.

Penalties can dominate when risk is high, driving a score below any positive contribution.

**Acceptance criteria:**
- All four penalty terms are nonnegative.
- Each penalty is computed from its specified invariant signal.
- pM reflects MFCI risk states (normal=0, elevated=low, high=medium, severe=high penalty).
- pH uses stricter thresholds for sensitive topics.
- pT requires both high harmonic tension AND a hostility/safety classifier signal -- tension alone produces zero penalty.
- pR increases with the number of redundant copies in the same source lineage.
- High combined penalties can produce a negative total PWAtt score.

**Testing:**
- Unit test: each penalty computes the correct value from fixture invariant data.
- Unit test: pT with high tension but zero hostility produces zero penalty.
- Unit test: pT with high tension AND high hostility produces a positive penalty.
- Unit test: high combined penalties drive the PWAtt score below zero.
- Unit test: pH uses stricter thresholds for content tagged with sensitive topics.
- Integration test: an item with severe MFCI is ranked below items with normal MFCI, all else equal.

**Dependencies:** WS-H.3 (MFCI), WS-H.6 (PHI), WS-H.7 (Hodge harmonic tension + tropical cascade), WS-H.2 (MERI redundancy), WS-J (safety/hostility classifier signal for pT).

**Observability:** Emit per-penalty contribution distributions and the rate at which penalties flip an item's score negative. A "tension-without-hostility" counter verifies pT remains zero for legitimate disagreement, guarding against over-penalizing dissent.

**Security/privacy:** pT's requirement of a paired hostility signal is a documented safeguard against suppressing legitimate sustained disagreement (Section 13.6 prohibition on "treating controversy as quality" in reverse — controversy must not be penalized merely for being controversy).

---

### WS-I.2.3c Risk constraint enforcement
**ID:** WS-I.2.3c
**Ref:** Sections 13.1, 13.4

**Description:**
Enforce hard risk constraints that items must satisfy to remain in the feasible candidate set. Items exceeding constraint thresholds are penalized or restricted from distribution. Constraints:

- **MFCI constraint:** items with MFCI above the severe threshold are excluded from cross-community spread and flagged for immediate review.
- **PHI constraint:** recommendation sequences with holonomy risk above threshold trigger diversification or mode switch.
- **GWEI constraint:** cohort disparity above threshold blocks the ranking configuration from deployment (experiment release gate).
- **MERI constraint:** redundancy bounded -- no more than n near-identical items may appear in a single feed.
- **SCOI constraint:** high-obstruction content requires a context card before distribution.
- **Safety-policy constraint:** content under active moderation, legally restricted, or age-inappropriate for the requesting user is excluded (enforced upstream by WS-I.2.2a; re-asserted here as a feasibility invariant).

Constraint enforcement produces a feasible set from the candidate set. Items removed by constraints are logged with the constraint that excluded them. Constraints are hard limits per Section 13.1: the optimizer (WS-I.2.3e) operates only within the feasible set and cannot trade a constraint violation for a higher objective.

**Acceptance criteria:**
- Each constraint has a configurable threshold.
- Items exceeding the MFCI severe threshold are excluded from cross-community distribution.
- Items exceeding the PHI threshold trigger feed diversification for the affected user.
- GWEI disparity above threshold blocks the ranking profile from production deployment.
- The feed contains at most n items from the same MERI duplicate group.
- High-SCOI items are distributed only with an attached context card.
- Safety-filtered items never appear in the feed.
- Every constraint exclusion is logged with `item_id`, `constraint_name`, `threshold`, `actual_value`.

**Testing:**
- Unit test: items with MFCI above threshold are excluded from the feasible set.
- Unit test: safety-filtered items are always excluded regardless of score.
- Unit test: the MERI constraint limits duplicate group representation.
- Integration test: a feed request with high-SCOI items includes context cards.
- Integration test: constraint exclusion log entries are queryable by constraint type.
- Edge case test: an item that violates multiple constraints is logged with all violated constraints.

**Dependencies:** WS-H.3 (MFCI), WS-H.6 (PHI), WS-H.5 (GWEI), WS-H.2 (MERI), WS-H.4 (SCOI), WS-I.2.2a (safety filter), WS-I.2.3f (thresholds in ranking profile).

**Observability:** Emit `ranking.constraint.applied` per exclusion. A dashboard shows per-constraint exclusion rates; a sudden change in MFCI/PHI exclusion rate is an early signal of a coordination event or a misconfigured threshold.

**Security/privacy:** GWEI release-gating ties this task to the experiment release gate (WS-P) so that a ranking change degrading structural experience parity for a protected cohort cannot ship.

---

### WS-I.2.3d Baseline computation
**ID:** WS-I.2.3d
**Ref:** Sections 5.4, 5.5

**Description:**
Compute the baseline B_i,t for each item. The baseline provides a time-sensitive starting score based on:

- **Freshness decay:** items receive a higher baseline when new, decaying over time. The decay curve is configurable per content type (breaking news decays faster than evergreen analysis).
- **Source reliability:** derived from the source's history within Licio -- correction frequency, evidence-type distribution, community context notes, and citation by later summaries. Source reliability is NEVER derived from popularity, follower count, or external social metrics, and the source model never presents a simplistic "truth score" (Section 14).
- **Topic relevance:** match between the item's topics and the user's configured interests. User interests are derived from their attention and participation history (never from wallet activity or payment history).

The baseline is on the same scale as the normalized positive PWAtt score so that fresh content with no participation yet has a nonzero score.

**Acceptance criteria:**
- Freshness decay produces a higher baseline for newer items.
- Decay curves are configurable per content type (at least breaking-news and evergreen profiles).
- Source reliability is computed from Licio-internal history (corrections, evidence, citations).
- Source reliability has zero dependency on external popularity, follower counts, or social metrics.
- Topic relevance matches item topics to user interests.
- Topic relevance has zero dependency on wallet, payment, or donor data.
- The baseline is on the same scale as the normalized positive PWAtt components.

**Testing:**
- Unit test: two items identical except for age produce different baselines (newer is higher).
- Unit test: a source with high correction accuracy and citation frequency has higher reliability.
- Unit test: source reliability computation has zero references to follower count or external metrics.
- Unit test: topic relevance for a user with configured interests ranks relevant items higher.
- Integration test: a brand-new item with no participation has a nonzero baseline score.

**Dependencies:** WS-F.2 (source model/history), WS-F.1.4 (freshness baseline), WS-D.2 (user interest/personalization settings), WS-I.2.3f (per-content-type decay curves).

**Observability:** Emit baseline component breakdowns so the relative contribution of freshness vs. source reliability vs. topic relevance is auditable. Track the median baseline for brand-new items to confirm cold-start items remain discoverable.

**Security/privacy:** Topic relevance uses only the requesting user's own attention/participation history (privacy-bucketed) and is disabled when personalization is off. It has no read path to financial data (asserted by WS-I.3.1a).

---

### WS-I.2.3e Constrained-optimization scoring orchestrator
**ID:** WS-I.2.3e
**Ref:** Sections 13.1, 13.3, 13.4

**Description:**
Implement the scoring orchestrator that realizes the `constrained_optimize` step of the Section 13.4 pseudo-code. It consumes the feasible set (post-safety-filter, post-feature-join), computes for each item the baseline (WS-I.2.3d), the positive PWAtt score (WS-I.2.3a), and the penalties (WS-I.2.3b); applies hard risk constraints (WS-I.2.3c) to confirm feasibility; and produces an ordered list maximizing the objective `[pwatt, exposure_independence, evidence_completeness, relevance]` subject to constraints `[cohort_parity, context_requirements, holonomy_limits]`. The orchestrator emits `ScoredItem[]` with full `score_components` and `penalty_components` for the decision log, and hands off to diversification (WS-I.2.4). It is deterministic given the same feature vectors, ranking profile, and invariant versions — a hard requirement for replay (WS-I.2.5b).

**Acceptance criteria:**
- The orchestrator produces a deterministic ordering given identical inputs (feature vectors, profile, invariant versions).
- Each `ScoredItem` carries the full PWAtt breakdown, penalty breakdown, and baseline.
- The objective and constraint sets match Section 13.4.
- The optimizer never returns an item outside the feasible set.
- Output is validated against the `ScoredItem` zod schema at the stage boundary.
- The orchestrator records which ranking profile and invariant versions it used for the decision log.

**Testing:**
- Unit test: identical inputs produce byte-identical orderings (determinism).
- Unit test: an infeasible item (constraint-violating) never appears in the output.
- Unit test: changing the ranking profile changes the ordering predictably.
- Integration test: end-to-end scoring of a fixture feasible set produces a complete, schema-valid `ScoredItem[]`.
- Replay-adjacent test: re-running with the recorded profile and versions reproduces the ordering.

**Dependencies:** WS-I.2.3a, WS-I.2.3b, WS-I.2.3c, WS-I.2.3d, WS-I.2.3f, WS-I.2.2a (feasible-set input).

**Observability:** Emit `ranking.scoring.completed` with `{ request_id, scored_count, profile_id, invariant_versions, duration_ms }`. Latency percentiles feed the feed-latency SLO dashboard.

**Security/privacy:** Determinism is itself an integrity property: it makes the ranking auditable and replayable (Section 30.6) and removes hidden nondeterministic inputs that could mask manipulation.

---

### WS-I.2.3f Ranking profile configuration and loader
**ID:** WS-I.2.3f
**Ref:** Sections 5.5, 13.1

**Description:**
Define the ranking-profile schema and a validating loader. A ranking profile is a named, versioned configuration carrying: the five positive weights (within their guardrail ranges, summing to 100%), the four penalty coefficients (nonnegative), all constraint thresholds (MFCI/PHI/GWEI/MERI/SCOI), per-content-type freshness decay curves, and the surface/topic/age-group/jurisdiction/risk-state selector that determines when the profile applies. The loader validates every profile at load time and refuses to start the ranker if any profile violates the weight-sum, range, or nonnegativity rules. Profiles are version-controlled; changing a profile is an auditable, reviewed change. This task centralizes all tunable ranking parameters referenced by WS-I.2.3a-e and WS-I.2.4.

**Acceptance criteria:**
- The profile schema captures weights, penalties, constraint thresholds, decay curves, and the applicability selector.
- The loader rejects any profile whose positive weights do not sum to 100% or fall outside their ranges.
- The loader rejects negative penalty coefficients.
- Profiles are versioned; the active profile version is recorded in each decision log.
- At least breaking-news and evergreen profiles ship as named configurations.
- Profile changes are gated on review and emit a CI notification.

**Testing:**
- Unit test: a valid profile loads; an invalid profile (bad weight sum, out-of-range weight, negative penalty) is rejected at load.
- Unit test: profile selection chooses the correct profile for a given surface/topic/age/jurisdiction/risk-state.
- Snapshot test: shipped profiles are snapshotted to detect unreviewed changes.
- Integration test: the ranker refuses to start with an invalid profile present.

**Dependencies:** WS-A.1 (doctrine: surface/topic sensitivity taxonomy), WS-N.1 (jurisdiction selector inputs), WS-D.1.7 (age-group selector inputs).

**Observability:** Emit `ranking.profile.loaded` with `{ profile_id, version, selector }` at startup and `ranking.profile.selected` per request. A registry shows which profile version is live per surface.

**Security/privacy:** Centralizing thresholds prevents ad-hoc, unreviewed tuning. GWEI thresholds here are the same values enforced by the experiment release gate, ensuring consistency between ranking and experimentation governance.

---

### WS-I.2.4a Matroid-based dedup
**ID:** WS-I.2.4a
**Ref:** Sections 7, 13.4

**Description:**
Implement matroid-rank-based deduplication using MERI to prevent near-identical items from dominating the feed. The diversification pass groups items by their MERI duplicate cluster and limits representation: at most n items from the same cluster may appear in a single feed response.

Within a cluster, items are selected by their PWAtt score after penalties. The remaining items in the cluster are available for "more on this story" expansion but do not occupy primary feed positions. The dedup boundary is configurable (default n=2 per cluster in a 30-item feed page). This realizes `diversify_with_matroid_rank` (Section 13.4) and enforces MERI's principle that repetition is not independence (Section 7).

**Acceptance criteria:**
- Items are grouped by MERI duplicate cluster before feed assembly.
- At most n items per cluster appear in the primary feed (default n=2).
- Within a cluster, the highest-scoring items (by PWAtt) are selected.
- Remaining cluster items are available via a "more on this story" expansion.
- The cluster limit n is configurable per surface.
- Items with no duplicate cluster (unique items) are unconstrained by this rule.

**Testing:**
- Unit test: a feed with 10 items in the same cluster shows at most n in the primary feed.
- Unit test: the selected items within a cluster are the highest-scored by PWAtt.
- Unit test: unique items (cluster size 1) are not affected.
- Integration test: "more on this story" expansion returns the remaining cluster items.
- Edge case test: a cluster with exactly n items shows all n.

**Dependencies:** WS-H.2 (MERI duplicate clusters and matroid rank), WS-I.2.3e (scored items as input), WS-I.2.3f (per-surface n).

**Observability:** Emit `ranking.dedup.applied` with cluster count, items demoted to expansion, and the largest cluster size encountered. A dashboard tracks the fraction of feed slots consumed by single-cluster expansions.

**Security/privacy:** Dedup is a manipulation defense (duplicate flooding); its thresholds are not exposed to users in a way that would reveal how to evade it.

---

### WS-I.2.4b Source and topic balancing
**ID:** WS-I.2.4b
**Ref:** Section 13.4

**Description:**
Ensure no single source or topic cluster dominates the feed. After matroid dedup, apply balancing constraints:

- **Source balancing:** no single source (publisher/domain) may contribute more than a configurable maximum percentage of items in a single feed page (default 15%).
- **Topic balancing:** no single topic cluster may contribute more than a configurable maximum percentage of items (default 25%). Topic clusters are derived from the topic classification pipeline.
- **Lens balancing:** when multiple lenses are active in a room feed, ensure representation from at least two distinct lenses when available.

Balancing is applied by demoting excess items from over-represented sources or topics, replacing them with the next-highest-scoring items from under-represented sources or topics.

**Acceptance criteria:**
- No single source exceeds the configured maximum percentage of feed items.
- No single topic cluster exceeds the configured maximum percentage.
- Lens balancing ensures multi-lens representation when available.
- Demoted items are logged with the balancing rule that demoted them.
- Balancing thresholds are configurable per surface.
- When the candidate pool is dominated by a single source/topic (e.g., a major breaking event), the system degrades gracefully and logs the imbalance.

**Testing:**
- Unit test: a candidate set dominated by one source is balanced after the pass.
- Unit test: a candidate set dominated by one topic cluster is balanced.
- Unit test: lens balancing selects items from multiple lenses when available.
- Integration test: feed audit shows source/topic distribution within configured limits.
- Edge case test: a single-source candidate pool degrades gracefully and is logged.

**Dependencies:** WS-I.2.4a (dedup output), WS-K.1.3a (topic classification for topic clusters), WS-G.2 (lens definitions), WS-I.2.3f (per-surface thresholds).

**Observability:** Emit `ranking.balancing.applied` with per-source and per-topic share before/after, and demotion counts. A dashboard surfaces feeds where a single source/topic exceeded limits due to graceful degradation.

**Security/privacy:** Source balancing prevents a single publisher from dominating distribution; it uses publisher/domain identity only, never any financial relationship with the publisher.

---

### WS-I.2.4c SCOI context gating
**ID:** WS-I.2.4c
**Ref:** Sections 10.4, 10.6, 13.4

**Description:**
Implement context gating for high-obstruction content. When SCOI indicates that an item has high context obstruction (interpretations diverge significantly across communities), the item receives a context card before broad distribution.

Context gating levels:
- **Low SCOI:** normal distribution, no context card.
- **Medium SCOI:** a context card is included with the feed item showing where interpretations differ.
- **High SCOI:** cross-community distribution is reduced until context improves; a context card is required.
- **Very high SCOI:** distribution is paused for bridge/expert context or moderator review.

Context cards include: a lens map showing interpretation differences, bridge attempt links, and a composer prompt "People in another room are reading this differently." Per Section 10, "Needs Context" never means false or banned.

**Acceptance criteria:**
- Items with medium SCOI include a context card in the feed response.
- Items with high SCOI have reduced cross-community distribution.
- Items with very high SCOI are paused from distribution pending review.
- Context cards include lens map data and bridge attempt references.
- Context gating decisions are logged in the decision log.
- Context gating thresholds are configurable.

**Testing:**
- Unit test: an item with low SCOI has no context card.
- Unit test: an item with medium SCOI includes a context card.
- Unit test: an item with high SCOI has reduced distribution scope.
- Integration test: a context card includes lens map data from the SCOI service.
- Integration test: a very-high-SCOI item does not appear in cross-community feeds.

**Dependencies:** WS-H.4 (SCOI levels, lens map, bridge routing), WS-G.2 (lenses), WS-I.2.4b (balancing output), WS-I.2.3f (thresholds).

**Observability:** Emit `ranking.context_gate.applied` with the SCOI level and action (card/reduce/pause). A dashboard tracks the volume of paused items awaiting bridge/expert context so moderation can resource the queue.

**Security/privacy:** Context cards are presented as informational ("interpreting differently"), never as truth verdicts, consistent with Section 10's prohibition on treating "Needs Context" as false or banned.

---

### WS-I.2.5a Decision log schema
**ID:** WS-I.2.5a
**Ref:** Sections 13.3, 22.4, 23.3

**Description:**
Define the `RankingDecisionLog` schema for per-request ranking audit, matching the Section 23.3 payload. Every feed request produces a decision log entry containing:

- **request_id:** unique identifier for the feed request.
- **user_privacy_bucket:** anonymized user cohort (never raw `user_id` in the log).
- **candidate_ids:** list of all item IDs in the candidate pool after retrieval.
- **selected_ids:** ordered list of item IDs in the final feed response.
- **score_components:** per-item breakdown of PWAtt components, penalties, and baseline for selected items.
- **invariant_versions:** map of `invariant_name` to `version_string` for each invariant used.
- **constraints_applied:** list of constraints that affected the result (exclusions, diversification, context gating).
- **explanation_ids:** per-item explanation identifiers linking to the explanation service.
- **experiment_ids:** list of active experiment IDs that influenced the ranking (if any).
- **timestamp:** ISO 8601 timestamp of the decision.

In addition to the Section 23.3 fields, the log records the `profile_id`/`profile_version` used (for replay) and the `feature_version`. The schema is defined as a zod schema. Logs are retained 180-365 days with access controls per Section 22.4.

**Acceptance criteria:**
- The `RankingDecisionLog` schema is defined with all Section 23.3 fields plus `profile_id`/`profile_version` and `feature_version`.
- Every feed request produces exactly one decision log entry.
- `user_privacy_bucket` is used instead of raw `user_id`.
- `score_components` include the full PWAtt breakdown per selected item.
- The `invariant_versions` map covers all invariants used in the decision.
- `constraints_applied` lists every constraint that excluded or modified an item.
- Logs are access-controlled and retained per the retention policy (180-365 days).

**Testing:**
- Unit test: a decision log passes schema validation with all required fields.
- Unit test: a decision log with missing fields is rejected.
- Integration test: a feed request produces a decision log entry with correct candidate and selected IDs.
- Audit test: decision log entries are retrievable by `request_id`.
- Privacy test: the decision log contains `user_privacy_bucket`, not raw `user_id`.

**Dependencies:** WS-I.2.3e (score components), WS-I.2.1c (invariant versions), WS-I.2.3f (profile id/version), WS-I.2.6 (explanation ids), WS-P (experiment ids), WS-D.2 (privacy-bucket derivation).

**Observability:** Emit `ranking.decision.logged` (matching Section 21.3 topic) on every write; track decision-log write success rate and ensure 1:1 correspondence with served feed requests (a missing log is an auditability incident).

**Security/privacy:** No raw `user_id` is ever written. Logs are access-controlled to ranking engineers, safety moderators, and auditors (WS-I.2.5c). Retention follows the 180-365 day ranking-decision-log default (Section 22.4); after retention they are deleted or anonymized.

---

### WS-I.2.5b Replay capability
**ID:** WS-I.2.5b
**Ref:** Sections 13.3, 13.4, 30.6

**Description:**
Given a decision log entry, reproduce the exact same ranking. Replay reads the decision log, retrieves the feature vectors at the recorded invariant versions (via WS-I.2.1c) and the recorded ranking profile version (via WS-I.2.3f), applies the same constraints, and verifies that the output matches the logged `selected_ids` and ordering.

Replay is used for:
- Auditing past ranking decisions.
- Debugging ranking anomalies.
- Validating that ranking code changes do not alter past decisions (regression detection).
- Transparency investigations.

The replay function accepts a `request_id`, retrieves the decision log entry and corresponding feature vectors, executes the ranking pipeline deterministically (WS-I.2.3e), and returns a pass/fail comparison with a diff of any discrepancies. Replay is the operational proof that ranking is "reproducible from logs" (M2/M3 gates).

**Acceptance criteria:**
- The replay function accepts a `request_id` and produces a ranking result.
- The replayed ranking matches the original logged `selected_ids` and ordering.
- Discrepancies are reported as a structured diff (`item_id`, `expected_position`, `actual_position`, `score_diff`).
- Replay uses the invariant versions and profile version recorded in the decision log, not current versions.
- Replay works for any decision log entry within the retention period.

**Testing:**
- Unit test: replay a known decision log entry and verify an exact match.
- Unit test: replay with a modified ranking profile produces a diff.
- Integration test: after a ranking code change, replay a set of historical decisions and report any regressions.
- Edge case test: replay of a decision log entry near the retention boundary still works.

**Dependencies:** WS-I.2.5a (decision log), WS-I.2.1c (versioned features), WS-I.2.3e (deterministic scoring), WS-I.2.3f (versioned profiles).

**Observability:** Emit `ranking.replay.completed` with `{ request_id, match: bool, diff_size }`. A scheduled "replay regression" job replays a rolling sample of recent decisions after each deploy and alerts on any mismatch.

**Security/privacy:** Replay reads decision logs and feature vectors under the same access controls as the audit interface (WS-I.2.5c); replays are themselves logged. Replay never reconstructs raw `user_id` from the privacy bucket.

---

### WS-I.2.5c Audit query interface
**ID:** WS-I.2.5c
**Ref:** Sections 22.4, 23.3, 30.6

**Description:**
Provide a query interface for searching and inspecting ranking decision logs. The interface supports search by:

- **Time range:** decisions made within a date/time window.
- **User privacy bucket:** decisions for a specific anonymized cohort.
- **Item ID:** all decisions that included a specific item as a candidate or selected item.
- **Invariant name and version:** decisions that used a specific invariant version.
- **Constraint name:** decisions where a specific constraint was applied.
- **Experiment ID:** decisions influenced by a specific experiment.

Results include the full decision log entry and support pagination. The interface is access-controlled -- only authorized roles (ranking engineers, safety moderators, auditors) can query decision logs.

**Acceptance criteria:**
- The query interface supports all six search dimensions.
- Results include the full `RankingDecisionLog` entry.
- Results are paginated for large result sets.
- Access is restricted to authorized roles.
- Queries complete within acceptable latency for dashboard use (target: under 5 seconds for a 1000-result query).
- Query audit: every query to the decision log is itself logged (who queried, what criteria, when).

**Testing:**
- Unit test: each search dimension returns correct results from fixture data.
- Unit test: an unauthorized role is denied access.
- Integration test: query by `item_id` returns all decisions that included that item.
- Performance test: a query over a 30-day window with 100k decision logs completes within the latency target.
- Audit test: querying decision logs produces a meta-audit log entry.

**Dependencies:** WS-I.2.5a (decision log store), WS-D.1.6 (auth middleware/roles), WS-O.1 (access-control test coverage).

**Observability:** Emit `ranking.decision.queried` (the meta-audit event) with `{ actor, criteria, result_count, timestamp }`. A dashboard tracks who is querying decision logs and how often, supporting insider-risk monitoring.

**Security/privacy:** Role-restricted; every access is itself audited (meta-audit). Results expose `user_privacy_bucket`, never raw identity, preserving the Section 22.4 access-control requirement on ranking decision logs.

---

### WS-I.2.6a Explanation template system
**ID:** WS-I.2.6a
**Ref:** Sections 13.5, 13.6

**Description:**
Build a structured template system for generating user-facing distribution explanations. Each template corresponds to a signal type or ranking event and produces a specific, human-readable sentence. Templates are parameterized and composable.

Template categories:
- **Positive signals:** rising attention, evidence additions, source verification, bridge activity, constructive participation.
- **Contextual signals:** SCOI interpretation divergence, lens differences, community context.
- **Constraint signals:** MFCI distribution slowing, MERI redundancy dampening, PHI diversification.
- **Safety signals:** content under review, integrity investigation, policy restriction.

Each template has: `template_id`, `signal_type`, `template_string` with parameter placeholders, a parameter schema, a `priority` (for selecting the most relevant explanation when multiple apply), and localization keys for i18n. Templates structurally cannot emit the Section 13.6 prohibited phrasings ("because of the algorithm," "trending," "popular").

**Acceptance criteria:**
- Templates exist for all four categories (positive, contextual, constraint, safety).
- Each template has a unique ID, signal type, parameterized string, and priority.
- Templates are localization-ready with i18n keys.
- Template parameters are validated against the parameter schema.
- Templates never produce vague explanations like "because of the algorithm" or "trending."

**Testing:**
- Unit test: each template renders correctly with valid parameters.
- Unit test: a template with invalid parameters is rejected.
- Unit test: template selection by priority produces the most relevant explanation.
- Snapshot test: all templates are captured to detect unreviewed changes.
- Localization test: templates render in at least two languages.

**Dependencies:** WS-A.1 (transparency dictionary / approved explanation vocabulary), WS-B (i18n infrastructure), WS-I.3.1i (prohibited-language list shared with neutrality test 9).

**Observability:** Emit `explanation.template.rendered` aggregates by `template_id` so the distribution of explanation types served is auditable. Track any template render failures.

**Security/privacy:** Templates are reviewed to avoid revealing manipulation-defense thresholds (the constraint/safety categories are deliberately non-specific). The prohibited-language denylist is shared with WS-I.3.1i so UI copy and templates cannot drift.

---

### WS-I.2.6b User-facing explanation generation
**ID:** WS-I.2.6b
**Ref:** Sections 5.4, 13.5, 13.6

**Description:**
Generate specific, human-readable distribution reasons for every feed item. The explanation service selects the most relevant templates based on the item's ranking signal profile and renders them with concrete parameters drawn from the same `score_components` recorded in the decision log.

Examples of acceptable explanations:
- "Rising because readers in three rooms opened the source and added independent evidence."
- "Shown with context because communities are interpreting the quote differently."
- "Lower in your feed because it repeats a claim you have already seen from the same source lineage."
- "Shown from outside your usual topics to preserve source diversity."

Examples of prohibited explanations:
- "Because of the algorithm."
- "Trending."
- "Popular."
- "Recommended for you."

Each explanation links to the item's signal ledger entry (Section 23.2 `/v1/signal-ledger`) for users who want deeper inspection. The rendered `distribution_reason` populates the `FeedItem` payload (Section 23.3).

**Acceptance criteria:**
- Every feed item in the response includes a `distribution_reason` string.
- Explanations reference specific, verifiable signals (room count, evidence count, source type).
- No explanation contains prohibited vague language.
- Explanations link to the signal ledger for detailed inspection.
- Explanations are generated within the feed response latency budget.
- Explanations are consistent with the decision log -- the explanation matches the actual ranking signals.

**Testing:**
- Unit test: explanation generation for each signal type produces a specific, parameterized string.
- Unit test: a feed item with multiple active signals produces the highest-priority explanation.
- Negative test: an attempt to generate a vague explanation is blocked by the template system.
- Integration test: every item in a feed response has a non-empty `distribution_reason`.
- Consistency test: the explanation matches the `score_components` in the decision log.

**Dependencies:** WS-I.2.6a (templates), WS-I.2.5a (decision log score_components), WS-I.2.3e (scored items), WS-D.2/signal-ledger (deep-inspection link).

**Observability:** Emit `explanation.generated` with `{ request_id, item_id, template_id }` and the explanation generation latency. A consistency monitor periodically diffs rendered explanations against decision-log score_components and alerts on mismatch.

**Security/privacy:** Explanations expose only the requesting user's own signal context via the signal ledger; they never reveal other users' attention or identity. They never expose financial framing (guarded by WS-I.3.1i).

---

### WS-I.2.6c Distribution-slowing explanations
**ID:** WS-I.2.6c
**Ref:** Sections 8.6, 13.5

**Description:**
Generate specific explanations for items whose distribution is slowed or restricted due to safety/integrity constraints. These explanations must be honest about the constraint without revealing manipulation defenses.

Templates:
- "Distribution is slowed because synchronized activity is under review." (MFCI elevated/high)
- "This thread is temporarily under integrity review." (MFCI severe)
- "Reporting impact is delayed because report timing is unusual." (coordinated-reporting detection)
- "This topic is receiving unusual synchronized activity. Distribution is slowed while reviewed." (tropical cascade)
- "Your recent feed has become narrow around this topic. See broader context?" (PHI holonomy)

Explanations for slowed distribution are shown to all users viewing the item, not just the author. Users do not see raw statistical values or accusatory language.

**Acceptance criteria:**
- Each constraint type (MFCI, PHI, coordinated reporting) has at least one slowing explanation template.
- Explanations are factual and non-accusatory.
- Explanations do not reveal specific detection thresholds or methods.
- Explanations are shown to all users viewing the affected item.
- Slowing explanations are logged in the decision log alongside the constraint.

**Testing:**
- Unit test: each constraint type produces the correct slowing explanation.
- Unit test: explanations do not contain raw statistical values or threshold numbers.
- Integration test: a feed item with MFCI elevated shows the slowing explanation to all viewers.
- Review test: all slowing explanation templates are reviewed for non-accusatory language.

**Dependencies:** WS-I.2.6a (templates), WS-I.2.3c (constraint flags), WS-H.3 (MFCI states), WS-H.6 (PHI), WS-J (coordinated-reporting detection).

**Observability:** Emit `explanation.slowing.shown` with the constraint type (not the raw statistic). A dashboard correlates slowing-explanation volume with active MFCI/PHI incidents.

**Security/privacy:** These templates are deliberately non-specific to avoid disclosing detection thresholds or methods (Section 28 open question on what transparency exposes manipulation defenses). They are non-accusatory to protect users who may be falsely implicated in coordination.

---

## WS-I.4 Ranking kill switch and safe fallback

### WS-I.4.1a Kill-switch control and feature flag
**ID:** WS-I.4.1a
**Ref:** Sections 13, 30.8, 30.9

**Description:**
Implement the ranking kill switch as a runtime feature flag that immediately reverts the feed to a safe fallback without requiring a deployment. The kill switch supports graduated scopes: global (all surfaces), per-surface (front page only), and per-profile (disable a specific ranking profile). When engaged, the ranker stops applying PWAtt scoring and constraint optimization and delegates to the safe fallback ranker (WS-I.4.1b). The switch has a named owner, a documented trigger condition, a rollback (re-enable) path, and a review date, per the Section 30.8 release-task card format. Engaging or releasing the switch is an audited action.

**Acceptance criteria:**
- The kill switch is a runtime flag; engaging it requires no deployment.
- Scopes: global, per-surface, and per-profile are supported.
- When engaged, the feed is served by the safe fallback ranker.
- The switch has an owner, trigger condition, rollback path, and review date.
- Engage/release actions are audited with actor, scope, reason, and timestamp.
- The switch state is observable on an operations dashboard.

**Testing:**
- Unit test: engaging the global switch routes feed requests to the fallback.
- Unit test: per-surface engagement affects only the named surface.
- Integration test: engage and release the switch without a deployment; verify feed behavior changes within the propagation budget.
- Audit test: engage/release produces an audit entry with all required fields.

**Dependencies:** WS-0 (feature-flag infrastructure), WS-I.4.1b (fallback ranker), WS-O.2 (incident-response/emergency-flag conventions).

**Observability:** Emit `ranking.killswitch.changed` with `{ actor, scope, state, reason }`. A prominent dashboard tile shows current kill-switch state per surface; engaging the switch raises an operations alert.

**Security/privacy:** The kill switch is restricted to incident responders and ranking owners. It is a reversibility control satisfying the M6 "each feature rolls back independently" gate for ranking.

---

### WS-I.4.1b Safe fallback ranker
**ID:** WS-I.4.1b
**Ref:** Sections 13, 13.6

**Description:**
Implement the safe fallback ranker used when the kill switch is engaged or when the primary ranker is unavailable. The fallback produces a feed using only chronological or editorial ordering plus the non-overridable safety filter (WS-I.2.2a). It applies no PWAtt scoring, no personalization, and — like the primary ranker — no financial signals whatsoever. The fallback still attaches honest distribution explanations ("Shown in time order while ranking is paused") and still writes a decision log entry marked `fallback: true` so that even fallback feeds are auditable and replayable.

**Acceptance criteria:**
- The fallback ranker produces a chronological or editorial feed.
- The safety filter (WS-I.2.2a) is still applied in fallback mode.
- No PWAtt scoring or personalization is applied in fallback mode.
- No financial signal is read in fallback mode (asserted by the neutrality suite running against fallback too).
- Fallback feeds attach an honest "ranking paused" explanation.
- Fallback feeds still write a decision log entry marked `fallback: true`.

**Testing:**
- Unit test: the fallback produces a time-ordered feed from a candidate set.
- Unit test: safety-filtered items are still excluded in fallback mode.
- Unit test: the fallback writes a decision log with `fallback: true`.
- Integration test: with the kill switch engaged, served feeds match the fallback ordering and carry the paused explanation.
- Neutrality test: WS-I.3.1a passes in fallback mode (wallet linkage has no effect on the fallback feed).

**Dependencies:** WS-I.2.2a (safety filter), WS-I.4.1a (kill switch), WS-I.2.5a (decision log), WS-I.2.6a (paused explanation template).

**Observability:** Emit `ranking.fallback.served` with `{ request_id, surface, reason }`. A dashboard shows the share of traffic served by the fallback so prolonged degradation is visible.

**Security/privacy:** The fallback is the safe default: it cannot be made worse than chronological + safety filtering, and it preserves auditability (decision log) and pay-to-rank neutrality even during an incident.

---

## WS-I.3 Ranking-neutrality test suite

### WS-I.3.1a Test 1 -- Feed replay with/without wallet links produces identical ranking
**ID:** WS-I.3.1a
**Ref:** Sections 13.6, 30.6

**Description:**
Automated test that proves wallet linkage has no effect on organic ranking. The test creates two identical user profiles -- one with a linked wallet, one without -- gives them identical attention and participation history, and verifies that a feed request for each user produces the identical ranking order and scores.

The test runs with real payment events in staging (not just absent payment data) to verify that the presence of wallet infrastructure does not leak into ranking. Per Section 30.6, the suite "runs before and after every crypto release and must pass with real payment events in staging before any real-funds pilot." This test is also run against the fallback ranker (WS-I.4.1b) to ensure neutrality holds during incidents.

**Acceptance criteria:**
- Two test users with identical behavior but different wallet states produce identical feed rankings.
- The test uses real (staging) payment events, not just empty payment data.
- Any ranking difference causes a CI failure with a detailed diff.
- The test covers front-page, room, and topic feeds.
- The test also passes against the safe fallback ranker.

**Testing:**
- CI test: runs on every commit to ranking, feature store, or candidate retrieval code.
- CI test: runs before every crypto release.
- Staging test: runs with real payment events before any real-funds pilot.

**Dependencies:** WS-I.2.3e (scoring), WS-I.1.1d (candidate orchestrator), WS-I.4.1b (fallback), WS-L.2 (staging wallet link), WS-M.3 (staging payment events).

**Observability:** Emit a `neutrality.test1.result` artifact with the diff on failure. The suite's pass/fail is a required CI status check on every PR and a release gate.

**Security/privacy:** This is the headline pay-to-rank control. Using real staging payment events (not absence of data) is essential — it proves wallet infrastructure presence does not leak into ranking.

---

### WS-I.3.1b Test 2 -- Payment amount absent from organic feature schemas
**ID:** WS-I.3.1b
**Ref:** Sections 24.4, 30.6

**Description:**
Automated test that verifies payment amount fields do not exist in any organic ranking feature schema. The test inspects the feature vector schema (WS-I.2.1a), the candidate retrieval queries (WS-I.1.1c), and the scoring engine inputs for any field or column referencing payment amounts. It asserts the Section 24.4 schema-exclusion requirement directly against the live schema artifacts.

**Acceptance criteria:**
- Static analysis of all organic feature schemas finds zero payment-amount fields.
- Static analysis of scoring engine function signatures finds zero payment-related parameters.
- Any addition of a payment-related field to an organic schema causes a CI failure.

**Testing:**
- CI test: schema inspection runs on every commit to feature store or scoring code.
- Static analysis: grep/AST scan for payment-related field names in organic schemas.

**Dependencies:** WS-I.2.1a (feature schema), WS-I.2.1b (denylist patterns), WS-I.1.1c (candidate query inspection).

**Observability:** Emit `neutrality.test2.result`; on failure the offending schema/field is named in the CI log.

**Security/privacy:** Operates on the canonical schema artifact, providing a static guarantee complementary to the runtime guarantee of Test 1.

---

### WS-I.3.1c Test 3 -- Donor identity absent from PWAtt and invariant joins
**ID:** WS-I.3.1c
**Ref:** Sections 24.4, 30.6

**Description:**
Automated test that verifies donor identity is not used in PWAtt computation or invariant feature joins. The test inspects:

- PWAtt scoring function inputs for any donor-related fields.
- Invariant feature join queries for any JOIN to donor/payment/treasury tables.
- The feature store population pipeline for any donor-identity propagation.

**Acceptance criteria:**
- PWAtt computation has zero donor-identity inputs.
- Invariant feature joins reference zero donor/payment/treasury tables.
- The feature store population pipeline propagates zero donor-identity fields.
- Any addition of donor-related joins causes a CI failure.

**Testing:**
- CI test: static analysis of the PWAtt function, join queries, and population pipeline.
- Integration test: PWAtt scores are identical for items whose only difference is donor identity.

**Dependencies:** WS-I.2.3a (PWAtt function), WS-I.2.1d (population pipeline), WS-H.1 (invariant joins).

**Observability:** Emit `neutrality.test3.result`; failures identify the offending join or input.

**Security/privacy:** Guards the invariant-join boundary specifically, where a careless JOIN could otherwise smuggle donor data into features.

---

### WS-I.3.1d Test 4 -- Treasury balance does not change story rank
**ID:** WS-I.3.1d
**Ref:** Sections 13.6, 30.6

**Description:**
Automated test that verifies a room's treasury balance has no effect on the ranking of stories within or from that room. The test creates two identical rooms -- one with a funded treasury, one with no treasury -- submits identical stories, and verifies identical ranking.

The only exception is a manually approved, non-amount public-interest prompt in a dedicated treasury surface, which is separate from the organic feed (Section 30.6).

**Acceptance criteria:**
- Stories from rooms with different treasury balances receive identical ranking in the organic feed.
- Treasury balance is not present in any feature vector used for organic ranking.
- The test covers both room-internal feeds and cross-room front-page feeds.

**Testing:**
- CI test: two rooms with different treasury balances produce identical story rankings.
- Integration test: treasury-funded content appears only in dedicated treasury surfaces, not in organic ranking.

**Dependencies:** WS-I.2.3e (scoring), WS-M.2 (staging treasury balances), WS-G.2 (rooms).

**Observability:** Emit `neutrality.test4.result` with the per-room ranking diff on failure.

**Security/privacy:** Confirms the only sanctioned treasury influence is the explicit, manually approved, non-amount public-interest prompt on a dedicated surface — never the organic feed.

---

### WS-I.3.1e Test 5 -- Governance vote outcomes do not change claim labels without evidence/steward process
**ID:** WS-I.3.1e
**Ref:** Sections 24.4, 30.6

**Description:**
Automated test that verifies governance vote outcomes cannot change factual claim labels. Claim labels (verified, disputed, unverified, etc.) are changed only through evidence submission and steward review, never by governance vote alone.

The test creates a claim with a label, simulates a governance vote that attempts to change the label, and verifies the label is unchanged. The label changes only when evidence is submitted and a steward reviews it.

**Acceptance criteria:**
- Governance vote outcomes do not modify claim labels.
- Claim label changes require evidence submission and steward review.
- An attempt to change a claim label via governance vote produces no effect and is logged.

**Testing:**
- CI test: a governance vote attempting to change a claim label has no effect.
- Integration test: a claim label changes only through the evidence/steward workflow.
- Audit test: attempted governance-driven label changes are logged.

**Dependencies:** WS-F.1 (claims), WS-M.4 (governance voting), WS-J.2 (steward review workflow), WS-G (evidence submission).

**Observability:** Emit `neutrality.test5.result`; the attempted-override is logged as a `claim.label.override.attempted` audit event.

**Security/privacy:** Protects factual labeling from financial/governance capture — votes cannot launder a claim's truth status without evidence and steward process.

---

### WS-I.3.1f Test 6 -- Paid membership does not bypass safety, rate limits, or moderation
**ID:** WS-I.3.1f
**Ref:** Sections 24.4, 30.6

**Description:**
Automated test that verifies paid membership or subscription status does not grant any bypass of safety filters, rate limits, or moderation actions. The test creates two users -- one with paid membership, one without -- and verifies:

- Both are subject to identical rate limits for posting, reporting, and API access.
- Both are subject to identical safety filters in ranking.
- Moderation actions (warn, hide, remove, restrict) apply identically regardless of membership status.

**Acceptance criteria:**
- Rate limit thresholds are identical for paid and unpaid users.
- Safety filter behavior is identical for paid and unpaid users.
- Moderation actions apply identically regardless of membership status.
- No API endpoint checks membership status to modify safety/moderation behavior.

**Testing:**
- CI test: rate limit tests with paid and unpaid users produce identical limits.
- CI test: safety filter tests with paid and unpaid users produce identical results.
- Integration test: a moderation action on a paid user is identical to an action on an unpaid user.
- Static analysis: no safety/moderation code path references membership status.

**Dependencies:** WS-I.2.2a (safety filter), WS-J.2 (moderation actions), WS-0 (rate-limit infrastructure), WS-M (membership status in staging).

**Observability:** Emit `neutrality.test6.result`; the static-analysis component lists any safety/moderation code path that references membership.

**Security/privacy:** Prevents a "pay to evade moderation" channel — financial status must never weaken safety, rate limits, or enforcement.

---

### WS-I.3.1g Test 7 -- ML feature audits fail if wallet/payment/treasury fields added to organic rankers
**ID:** WS-I.3.1g
**Ref:** Sections 24.4, 30.6

**Description:**
Automated test that verifies the ML feature audit pipeline detects and rejects any addition of wallet, payment, or treasury fields to organic ranking models. The test:

1. Adds a wallet-related field to the organic feature schema.
2. Runs the ML feature audit.
3. Verifies the audit fails with a specific error identifying the prohibited field.
4. Removes the field and verifies the audit passes.

This test validates the denylist enforcement (WS-I.2.1b) at the ML pipeline level, not just the schema level. Per Section 30.6, audits must fail if such fields are added "without explicit approval."

**Acceptance criteria:**
- Adding a wallet/payment/treasury field to an organic ranker triggers an audit failure.
- The audit failure message identifies the specific prohibited field.
- The audit passes when no prohibited fields are present.
- The audit runs automatically on any change to ML model features.

**Testing:**
- CI test: intentionally add a prohibited field, verify audit failure.
- CI test: remove the field, verify audit passes.
- Integration test: the audit runs as part of the ML model deployment pipeline.

**Dependencies:** WS-I.2.1b (denylist), WS-K.1.1b (model registry / deployment pipeline hook), WS-0.4 (CI).

**Observability:** Emit `neutrality.test7.result`; integrates with the model-deployment pipeline so a non-compliant model cannot deploy.

**Security/privacy:** Extends the schema denylist guarantee to learned ML rankers, where a feature could otherwise be introduced via training data rather than an explicit schema edit.

---

### WS-I.3.1h Test 8 -- Sponsored/treasury-funded content labeled and excluded from unpaid ranking
**ID:** WS-I.3.1h
**Ref:** Sections 13.6, 30.6

**Description:**
Automated test that verifies sponsored and treasury-funded content is clearly labeled and excluded from the organic (unpaid) ranking pipeline. Sponsored content:

- Carries a visible "Sponsored" or "Treasury-funded" label in the feed.
- Does not enter the organic candidate retrieval pipeline.
- Does not influence the PWAtt scores of organic items.
- Appears only in designated sponsored surfaces.

**Acceptance criteria:**
- Sponsored/treasury-funded content has a visible label in every surface where it appears.
- Sponsored content is excluded from organic candidate retrieval.
- Sponsored content does not appear in organic feed results.
- Organic PWAtt scores are unaffected by the presence of sponsored content.

**Testing:**
- CI test: sponsored content is absent from organic feed results.
- CI test: sponsored content carries the label in all designated surfaces.
- Integration test: adding sponsored content to the system does not change organic feed rankings.

**Dependencies:** WS-I.1.1a (candidate sources excluding sponsored), WS-I.1.1d (orchestrator), WS-M (sponsored/treasury-funded content source), WS-B.2 (sponsored label UI).

**Observability:** Emit `neutrality.test8.result`; a runtime monitor also asserts sponsored items never appear in organic decision logs.

**Security/privacy:** Maintains the bright line between paid surfaces and organic ranking — sponsored content is labeled and quarantined to dedicated surfaces.

---

### WS-I.3.1i Test 9 -- Public explanations state payments are support/governance, not endorsements
**ID:** WS-I.3.1i
**Ref:** Sections 13.6, 30.6

**Description:**
Automated test that verifies public-facing explanations about payment features describe payments as support and governance actions, never as endorsements, votes, or quality signals. The test inspects:

- All explanation templates related to payment/treasury/governance features.
- User-facing copy in payment flows.
- Help/FAQ content about payments.

The test checks for prohibited language: "endorse," "boost," "promote," "recommend," "vote for quality," "shows support means better." The prohibited-language list is the same artifact consumed by the explanation template system (WS-I.2.6a) so copy and templates cannot diverge.

**Acceptance criteria:**
- No public explanation or payment-related copy uses endorsement language.
- Payment explanations describe payments as "support," "governance," "community funding," or equivalent neutral terms.
- Prohibited language patterns are defined and checked automatically.

**Testing:**
- CI test: scan all explanation templates and payment-related UI strings for prohibited language.
- CI test: new explanation templates are checked against the prohibited language list.
- Review test: all payment-related copy is reviewed for neutral framing.

**Dependencies:** WS-I.2.6a (templates + shared prohibited-language list), WS-M (payment-flow copy), WS-A (transparency dictionary).

**Observability:** Emit `neutrality.test9.result`; failures name the offending string and matched prohibited phrase.

**Security/privacy:** Prevents framing payments as a quality/endorsement signal in user-facing copy — closing a social-engineering path toward perceived pay-to-rank.

---

### WS-I.3.1j Test 10 -- Dashboards separate revenue/treasury metrics from product-health metrics
**ID:** WS-I.3.1j
**Ref:** Sections 28.1, 30.6

**Description:**
Automated test that verifies internal dashboards separate revenue and treasury metrics from product-health metrics. The test inspects dashboard configurations and data sources to verify:

- Revenue metrics (payment volume, treasury balances, donor counts) are in dedicated financial dashboards.
- Product-health metrics (PWAtt distribution, feed diversity, safety metrics, invariant health) are in separate dashboards.
- No product-health dashboard includes financial data as a dimension or filter.
- No financial dashboard is used as an input to ranking decisions.

**Acceptance criteria:**
- Revenue/treasury dashboards and product-health dashboards are separate.
- No product-health dashboard queries financial data tables.
- No financial metric appears as a dimension in product-health dashboards.
- Dashboard configurations are version-controlled and auditable.

**Testing:**
- CI test: inspect dashboard data source configurations for cross-contamination.
- Integration test: product-health dashboards render without any financial data dependency.
- Audit test: dashboard configuration changes are logged and reviewable.

**Dependencies:** WS-P.2 (transparency/product-health dashboards), WS-M (financial dashboards), WS-0.4 (config-as-code CI).

**Observability:** Emit `neutrality.test10.result`; dashboard config changes are themselves audited.

**Security/privacy:** Prevents financial metrics from becoming a back-door ranking input via shared dashboards/data sources, and keeps Section 28.1 product-health metrics financially clean.

---

## Task dependency summary

| Task | Title | Depends on | Blocks |
|---|---|---|---|
| WS-I.1.1a | Candidate source definitions | WS-F.1, WS-F.2, WS-G.1, WS-H.4, WS-E.2 | WS-I.1.1b, WS-I.1.1c, WS-I.1.1d |
| WS-I.1.1b | Diversity quotas | WS-I.1.1a, WS-H.2, WS-D.2 | WS-I.1.1d |
| WS-I.1.1c | Financial exclusion (candidate stage) | WS-I.1.1a, WS-0.4, WS-A.1.1 | WS-I.3.1b |
| WS-I.1.1d | Candidate generation orchestrator | WS-I.1.1a, WS-I.1.1b, WS-I.1.1c | WS-I.2.2a, WS-I.3.1a, WS-I.3.1h |
| WS-I.2.1a | Feature vector schema | WS-H.1.1a, WS-H.2-H.7, WS-E.2, WS-F.2 | WS-I.2.1b/c/d, WS-I.3.1b/c |
| WS-I.2.1b | Schema-level denylist | WS-I.2.1a, WS-A.1.1, WS-0.4 | WS-I.2.1d, WS-I.3.1b/g |
| WS-I.2.1c | Feature versioning | WS-I.2.1a, WS-H.1.1b, WS-H.1.2b | WS-I.2.1d, WS-I.2.5b |
| WS-I.2.1d | Feature store population pipeline | WS-I.2.1a/b/c, WS-H.1, WS-E.2 | WS-I.2.2a, WS-I.2.3e |
| WS-I.2.2a | Safety filter stage | WS-J.2, WS-N.1, WS-D.1.7, WS-D.2, WS-I.2.1d | WS-I.2.3c/e, WS-I.4.1b, WS-I.3.1f |
| WS-I.2.3a | PWAtt score computation | WS-I.2.1a, WS-I.2.3f, WS-E.2 | WS-I.2.3e, WS-I.3.1c |
| WS-I.2.3b | Penalty application | WS-H.3, WS-H.6, WS-H.7, WS-H.2, WS-J | WS-I.2.3e |
| WS-I.2.3c | Risk constraint enforcement | WS-H.3/H.6/H.5/H.2/H.4, WS-I.2.2a, WS-I.2.3f | WS-I.2.3e |
| WS-I.2.3d | Baseline computation | WS-F.2, WS-F.1.4, WS-D.2, WS-I.2.3f | WS-I.2.3e |
| WS-I.2.3e | Scoring orchestrator | WS-I.2.3a/b/c/d/f, WS-I.2.2a | WS-I.2.4a, WS-I.2.5a/b, WS-I.3.1a/d |
| WS-I.2.3f | Ranking profile config + loader | WS-A.1, WS-N.1, WS-D.1.7 | WS-I.2.3a-e, WS-I.2.4 |
| WS-I.2.4a | Matroid-based dedup | WS-H.2, WS-I.2.3e, WS-I.2.3f | WS-I.2.4b |
| WS-I.2.4b | Source and topic balancing | WS-I.2.4a, WS-K.1.3a, WS-G.2, WS-I.2.3f | WS-I.2.4c |
| WS-I.2.4c | SCOI context gating | WS-H.4, WS-G.2, WS-I.2.4b, WS-I.2.3f | WS-I.2.5a |
| WS-I.2.5a | Decision log schema | WS-I.2.3e, WS-I.2.1c, WS-I.2.3f, WS-I.2.6, WS-P, WS-D.2 | WS-I.2.5b/c, WS-I.4.1b |
| WS-I.2.5b | Replay capability | WS-I.2.5a, WS-I.2.1c, WS-I.2.3e, WS-I.2.3f | M2/M3 reproducibility gates |
| WS-I.2.5c | Audit query interface | WS-I.2.5a, WS-D.1.6, WS-O.1 | Transparency/audit ops |
| WS-I.2.6a | Explanation template system | WS-A.1, WS-B (i18n), WS-I.3.1i | WS-I.2.6b/c |
| WS-I.2.6b | User-facing explanation generation | WS-I.2.6a, WS-I.2.5a, WS-I.2.3e, WS-D.2 | Feed response |
| WS-I.2.6c | Distribution-slowing explanations | WS-I.2.6a, WS-I.2.3c, WS-H.3, WS-H.6, WS-J | Feed response |
| WS-I.4.1a | Kill-switch control + flag | WS-0, WS-I.4.1b, WS-O.2 | Incident reversibility (M6) |
| WS-I.4.1b | Safe fallback ranker | WS-I.2.2a, WS-I.4.1a, WS-I.2.5a, WS-I.2.6a | WS-I.3.1a (fallback) |
| WS-I.3.1a | Test 1 — wallet-link neutrality | WS-I.2.3e, WS-I.1.1d, WS-I.4.1b, WS-L.2, WS-M.3 | M3/M5 gates |
| WS-I.3.1b | Test 2 — payment amount absent | WS-I.2.1a, WS-I.2.1b, WS-I.1.1c | M3 gate |
| WS-I.3.1c | Test 3 — donor identity absent | WS-I.2.3a, WS-I.2.1d, WS-H.1 | M3 gate |
| WS-I.3.1d | Test 4 — treasury balance neutral | WS-I.2.3e, WS-M.2, WS-G.2 | M3/M5 gates |
| WS-I.3.1e | Test 5 — votes don't relabel claims | WS-F.1, WS-M.4, WS-J.2, WS-G | M3 gate |
| WS-I.3.1f | Test 6 — paid membership no bypass | WS-I.2.2a, WS-J.2, WS-0, WS-M | M3 gate |
| WS-I.3.1g | Test 7 — ML feature audit | WS-I.2.1b, WS-K.1.1b, WS-0.4 | M3 gate |
| WS-I.3.1h | Test 8 — sponsored excluded | WS-I.1.1a, WS-I.1.1d, WS-M, WS-B.2 | M3 gate |
| WS-I.3.1i | Test 9 — payments not endorsements | WS-I.2.6a, WS-M, WS-A | M3 gate |
| WS-I.3.1j | Test 10 — dashboard separation | WS-P.2, WS-M, WS-0.4 | M3 gate |

---

## Workstream definition of done

WS-I is complete when ALL of the following conditions hold:

1. **Pipeline stages implemented end to end:** The eight Section 13.3 stages (candidate generation, invariant feature join via the feature store, safety filter, multi-objective scoring, diversification, decision logging, explanation generation, feed response) are implemented as discrete, schema-validated, independently testable components with explicit stage boundaries.

2. **Feature store denylist:** The ranking feature store schema-level denylist rejects wallet balances, payment history, donor status, token holdings, and all other financial fields at write time, with case-insensitive nested-field matching. Strict-mode schema closure provides defense in depth. Attempts to add denied fields fail at migration/write time and in CI.

3. **Scoring engine:** The scoring engine assembles PWAtt scores, invariant outputs, and safety constraints into a composite ranking score with normalized, configurable weights (positive weights sum to 100% within their guardrail ranges; penalties are separate nonnegative coefficients), produced by a deterministic constrained-optimization orchestrator driven by versioned ranking profiles.

4. **Safety and risk constraints are non-overridable:** The safety filter and hard risk-constraint enforcement run before scoring; the optimizer operates only within the feasible set and cannot override content removals, severe coordination freezes, minor-safety limits, personalization-off settings, or privacy deletion/retention states (Section 24.4).

5. **MERI diversification:** Feed diversification uses MERI independence scores to prevent duplicate and near-duplicate content from clustering in the feed, complemented by source/topic/lens balancing and SCOI context gating.

6. **Neutrality tests in CI:** All 10 ranking-neutrality tests pass in CI on every PR, before and after every crypto release, and with real payment events in staging before any real-funds pilot. Tests verify that wallet activity, payment status, donor tier, token holdings, and other financial signals have zero influence on ranking — including against the safe fallback ranker.

7. **Reproducible, replayable ranking:** Every feed request writes exactly one `RankingDecisionLog` (with `user_privacy_bucket`, never raw `user_id`), retained 180-365 days under access controls. Any decision is deterministically replayable at its recorded invariant and profile versions, and a scheduled replay-regression job detects ranking changes after deploys.

8. **Per-item explanations:** Every ranked item has a specific, human-readable explanation of why it was ranked at its position, referencing the signals and invariants that contributed to the score and consistent with the decision log. No explanation uses prohibited vague or endorsement language; explanations link to the user's signal ledger.

9. **Auditability:** A role-restricted, meta-audited query interface supports searching decision logs by time, privacy bucket, item, invariant version, constraint, and experiment.

10. **Kill switch:** The ranking kill switch is operational at global/per-surface/per-profile scope and can immediately revert the feed to a safe fallback (chronological or editorial, with the safety filter still applied and decision logging preserved) without requiring a deployment. Engage/release is audited and observable.

11. **Observability:** Every stage emits structured telemetry (candidate assembly, feature freshness, safety-filter exclusions, score distributions, constraint applications, diversification, explanations, fallback share, kill-switch state, and neutrality-suite results), feeding operational dashboards and alerts.
