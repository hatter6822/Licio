# WS-I. Ranking and Distribution

**Milestone:** M2-M3 | **Priority:** 2-3 | **Dependencies:** WS-E.2, WS-H, WS-F | **Wave:** 5-6 | **Estimated duration:** 4-5 weeks

## Overview

The ranking pipeline assembles PWAtt scores, invariant outputs, and safety constraints into a feed. It NEVER uses likes, upvotes, follower counts, wallet activity, payments, or donor status. A schema-level denylist prevents financial data from entering ranking features. 10 automated neutrality tests run in CI before every crypto release.

---

## WS-I.1 Candidate generation

### WS-I.1.1a Candidate source definitions
**ID:** WS-I.1.1a
**Ref:** Section 13.2

Define the complete set of candidate sources for feed generation. Each source type has a retrieval strategy, a relevance heuristic, and a freshness window. The sources are:

- **Subscribed rooms** -- stories and threads from rooms the user has joined, weighted by recency and user activity in the room.
- **Local/regional news** -- location-scoped stories based on user-configured location preferences (never inferred from precise device location without consent).
- **Global candidates** -- front-page-eligible stories that meet a minimum PWAtt threshold across rooms.
- **Emerging discussions** -- threads with high constructive participation velocity (evidence additions, corrections, synthesis) that have not yet reached broad distribution.
- **Independent source additions** -- new evidence cards or primary sources added to existing stories, surfaced when the original story was previously seen.
- **Cross-community bridges** -- content being discussed across multiple rooms where SCOI indicates interpretation divergence, surfaced with context.
- **Expert explanations** -- high-quality summaries and explanations from domain-specific rooms or steward-curated threads.
- **Chronological catch-up** -- recent items the user has not seen, ordered by time, for users returning after absence.

Each source type produces a candidate set with metadata: source_type, room_id (if applicable), freshness_timestamp, retrieval_score. No candidate source uses follower count, wallet balance, payment history, or donor status as a retrieval signal.

**Acceptance criteria:**
- All eight candidate source types are implemented and produce candidates.
- Each candidate carries source_type metadata.
- Candidate retrieval queries contain zero references to wallet, payment, follower-count, or donor tables.
- Chronological catch-up respects user's last-seen timestamp per room.
- Global candidates use PWAtt threshold, not popularity or engagement count.
- Cross-community bridge candidates include SCOI context metadata.

**Testing:**
- Unit tests for each source retrieval function with fixture data.
- Integration test that all eight source types contribute to a combined candidate set.
- Negative test: inject wallet/payment fields into candidate query parameters and verify retrieval rejects them or produces identical results.
- Performance test: candidate retrieval completes within latency budget for 10k candidate pool.

---

### WS-I.1.1b Diversity quotas
**ID:** WS-I.1.1b
**Ref:** Section 13.2

Enforce minimum quotas for fresh, independent, and local sources per feed request to prevent personalization collapse. Each feed response must include:

- A minimum percentage of items from sources the user has not previously seen (fresh sources).
- A minimum percentage of items from independent publishers (not syndicated copies of the same article, verified via MERI).
- A minimum percentage of items from local/regional sources when the user has a configured location.

Quotas are configurable per surface (front page, room feed, topic feed) and are enforced after candidate retrieval but before ranking, so the ranker operates on a sufficiently diverse candidate pool. Quota shortfalls are logged for monitoring. When insufficient candidates exist to meet a quota (e.g., a new user with no location set), the system degrades gracefully and logs the shortfall.

**Acceptance criteria:**
- Fresh-source quota is configurable and enforced (default minimum 15% of candidates).
- Independent-source quota is configurable and enforced (default minimum 20% of candidates).
- Local-source quota is configurable and enforced when location is set (default minimum 10% of candidates).
- Quota shortfalls are logged with the feed request_id and the shortfall amount.
- Quotas are applied per surface type.
- Graceful degradation when candidate pool is too small to meet quotas.

**Testing:**
- Unit test: given a candidate pool with known source distribution, verify quotas are enforced.
- Unit test: verify graceful degradation when candidate pool is smaller than quota requirements.
- Integration test: feed request logs show quota compliance or shortfall entries.
- Regression test: personalization-heavy user still receives fresh and independent sources.

---

### WS-I.1.1c Financial data exclusion verification
**ID:** WS-I.1.1c
**Ref:** Sections 13.2, 13.6, 30.6

Automated test that candidate retrieval has zero dependency on wallet, payment, follower-count, or donor data. This test runs in CI and validates that the candidate retrieval pipeline cannot access or be influenced by financial data.

The test inspects:
- SQL/query definitions used by candidate retrieval for any JOIN or reference to wallet, payment, treasury, donor, follower-count, or token tables.
- Function signatures and imports in the candidate retrieval module for any dependency on financial data modules.
- Runtime behavior: two identical users with different wallet/payment states produce identical candidate sets.

**Acceptance criteria:**
- CI test passes on every commit that touches candidate retrieval code.
- Static analysis of candidate retrieval queries finds zero references to financial tables.
- Dependency analysis of candidate retrieval module finds zero imports from wallet/payment/treasury modules.
- Runtime test with identical users (one with wallet, one without) produces identical candidate sets.

**Testing:**
- Static analysis test scanning query definitions for denied table names.
- Module dependency graph test verifying no path from candidate retrieval to financial modules.
- Integration test: create two test users with identical behavior but different wallet states; verify identical candidate sets.
- CI gate: test must pass before merge for any file in the candidate retrieval path.

---

## WS-I.2 Ranking pipeline

### WS-I.2.1a Feature vector schema
**ID:** WS-I.2.1a
**Ref:** Sections 5.4, 13.3, 30.6

Define the per-item feature vector schema used by the ranking pipeline. The schema includes all fields necessary for PWAtt scoring, invariant constraint enforcement, and diversification. Fields:

- **PWAtt components:** ActiveAttention, ConstructiveParticipation, ExposureIndependence, SourceAndEvidenceCompleteness, ContextCoherenceGain (each as a normalized float).
- **Invariant signals:** MERI_rank (integer), MFCI_score (float + risk_state enum), SCOI_level (enum: low/medium/high/very_high), PHI_risk (float), GWEI_cohort_disparity (float).
- **Penalty terms:** CoordinationPenalty (from MFCI), HolonomyRisk (from PHI), HarmfulTensionRisk (from Hodge), RedundancyPenalty (from MERI).
- **Baseline components:** freshness_decay (float, time-based), source_reliability (float, from source history), topic_relevance (float, user interest match).
- **Supporting invariants:** Hodge_harmonic_tension (float), TropicalCascade_rank (float), BraidAgenda_entropy (float), ReebLandscape_basin_id (string), CID_defect (float), PathSignature_wellbeing (float).
- **Metadata:** item_id, item_type, room_id, topic_ids, source_id, created_at, feature_version, invariant_versions (map of invariant_name to version string).

The schema is defined as a zod schema co-located with the TypeScript type and validated at write time.

**Acceptance criteria:**
- Feature vector schema is defined with all listed fields and their types.
- zod schema validates feature vectors at write time.
- TypeScript type is generated from or co-located with the zod schema.
- Schema includes invariant_versions map for audit traceability.
- All field names are documented with their source (which service or invariant produces them).
- Schema contains zero fields related to wallet, payment, treasury, donor, or follower count.

**Testing:**
- Unit test: valid feature vectors pass schema validation.
- Unit test: feature vectors with missing required fields are rejected.
- Unit test: feature vectors containing denied fields (wallet, payment, etc.) are rejected.
- Schema snapshot test to detect unreviewed field additions.

---

### WS-I.2.1b Schema-level denylist
**ID:** WS-I.2.1b
**Ref:** Sections 13.6, 30.6

Implement a schema-level denylist that rejects any attempt to write wallet, token, payment, treasury, follower-count, or donor fields into the feature store. The denylist operates at the validation layer -- any feature vector containing a denied field name or a field matching a denied pattern produces a validation error and is not written.

The denied field patterns include: `wallet*`, `token*`, `payment*`, `treasury*`, `donor*`, `follower*`, `balance*`, `stake*`, `vote_weight*`, `membership_tier*`, `subscription_amount*`. The denylist is maintained as a versioned configuration, and any modification to the denylist requires a code review with explicit approval from the ranking team.

**Acceptance criteria:**
- Feature store write operations validate against the denylist before persisting.
- Any feature vector containing a denied field is rejected with a descriptive validation error.
- The denylist is defined as a versioned configuration file, not inline code.
- Denylist modifications trigger a CI notification and require explicit review.
- Validation error includes the denied field name and the denylist version.
- Rejected writes are logged with request context for audit.

**Testing:**
- Unit test: attempt to write a feature vector with each denied pattern; verify rejection.
- Unit test: valid feature vectors without denied fields are accepted.
- Integration test: end-to-end write attempt with a denied field from the feature population pipeline is rejected.
- CI gate: any change to the denylist configuration file triggers the full neutrality test suite.

---

### WS-I.2.1c Feature versioning
**ID:** WS-I.2.1c
**Ref:** Section 30.6

Track which invariant versions produced each feature in the feature store. Every feature vector records the exact version of each invariant service that contributed to its fields. This enables:

- Auditing which invariant version was active when a ranking decision was made.
- Replaying rankings with the same invariant versions.
- Detecting when an invariant upgrade changes ranking behavior.

The versioning system stores: invariant_name, version_string, computation_timestamp, and config_hash (hash of the invariant's configuration at computation time). Feature vectors carry an invariant_versions map that is immutable after write.

**Acceptance criteria:**
- Every feature vector includes an invariant_versions map with entries for each contributing invariant.
- Version entries include invariant_name, version_string, computation_timestamp, and config_hash.
- The invariant_versions map is immutable after the feature vector is written.
- A query API returns the invariant versions for any feature vector by item_id and timestamp.
- Version changes are logged when an invariant service is upgraded.

**Testing:**
- Unit test: feature vectors without invariant_versions are rejected at write time.
- Integration test: upgrade an invariant version, verify new feature vectors carry the updated version.
- Audit query test: retrieve invariant versions for a specific ranking decision and verify they match the feature vector.
- Replay test: given a decision log entry, retrieve the feature vector with matching invariant versions.

---

### WS-I.2.1d Feature store population pipeline
**ID:** WS-I.2.1d
**Ref:** Sections 13.3, 21.4

Implement the batch and real-time update paths for populating the feature store. The pipeline receives invariant outputs and assembles them into complete feature vectors.

- **Real-time path:** as invariant services compute new values (MFCI state change, SCOI level update, new PWAtt score), the feature store is updated incrementally. Updates are idempotent and carry a monotonic version number to prevent stale overwrites.
- **Batch path:** periodic recomputation of all feature vectors from source invariant data. Used for backfills after invariant upgrades, cold-start bootstrapping, and consistency reconciliation. Batch runs produce a new feature version and do not overwrite real-time updates that are more recent.

The pipeline validates every feature vector against the schema (WS-I.2.1a) and denylist (WS-I.2.1b) before writing.

**Acceptance criteria:**
- Real-time updates propagate invariant changes to the feature store within the latency budget (target: under 5 seconds for MFCI state changes).
- Batch recomputation completes within the scheduled window and produces consistent feature vectors.
- Stale real-time updates are rejected via monotonic version check.
- Batch does not overwrite real-time updates that are more recent.
- All writes pass schema validation and denylist checks.
- Pipeline failures are logged, alerted, and do not corrupt existing feature data.

**Testing:**
- Unit test: real-time update with a newer version succeeds; with a stale version is rejected.
- Integration test: invariant service publishes a new MFCI score; verify feature store is updated within latency budget.
- Batch test: run a batch recomputation and verify all feature vectors are valid and versioned.
- Failure test: simulate a pipeline error and verify existing feature data is not corrupted.
- Denylist test: batch pipeline attempting to write denied fields is rejected.

---

### WS-I.2.3a PWAtt score computation
**ID:** WS-I.2.3a
**Ref:** Sections 5.4, 5.5

Implement the PWAtt score computation as defined in the spec. The scoring function computes:

    PWAtt = B + wA*ActiveAttention + wP*ConstructiveParticipation + wE*ExposureIndependence
            + wS*SourceAndEvidenceCompleteness + wC*ContextCoherenceGain
            - pM*CoordinationPenalty - pH*HolonomyRisk - pT*HarmfulTensionRisk - pR*RedundancyPenalty

The five positive weights (wA, wP, wE, wS, wC) are normalized to sum to 100% per ranking profile. Weight ranges are enforced: wA 20-30%, wP 25-40%, wE 10-20%, wS 5-15%, wC 5-15%. Weights vary by surface, topic sensitivity, freshness, age group, jurisdiction, and risk state. Each ranking profile is a named configuration specifying weights within the allowed ranges.

**Acceptance criteria:**
- PWAtt function accepts a feature vector and a ranking profile, returns a score.
- Positive weights sum to exactly 100% for every ranking profile.
- Each weight is within its specified range (wA 20-30%, wP 25-40%, wE 10-20%, wS 5-15%, wC 5-15%).
- A ranking profile with weights outside the allowed ranges is rejected at load time.
- Penalties are separate nonnegative coefficients, not part of the weight normalization.
- Baseline B is on the same scale as the normalized positive score.
- Breaking-news profile emphasizes timeliness; evergreen profile emphasizes evidence and synthesis.

**Testing:**
- Unit test: compute PWAtt with known inputs and verify output matches expected value.
- Unit test: ranking profile with weights summing to != 100% is rejected.
- Unit test: ranking profile with a weight outside its range (e.g., wA = 50%) is rejected.
- Property test: for any valid ranking profile, positive weights sum to 100%.
- Comparison test: breaking-news profile produces higher scores for fresh, source-verified content; evergreen profile produces higher scores for evidence-rich content.

---

### WS-I.2.3b Penalty application
**ID:** WS-I.2.3b
**Ref:** Sections 5.4, 5.5

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
- pT requires both high harmonic tension AND hostility/safety classifier signal -- tension alone produces zero penalty.
- pR increases with the number of redundant copies in the same source lineage.
- High combined penalties can produce a negative total PWAtt score.

**Testing:**
- Unit test: each penalty computes the correct value from fixture invariant data.
- Unit test: pT with high tension but zero hostility produces zero penalty.
- Unit test: pT with high tension AND high hostility produces a positive penalty.
- Unit test: high combined penalties drive the PWAtt score below zero.
- Unit test: pH uses stricter thresholds for content tagged with sensitive topics.
- Integration test: an item with severe MFCI is ranked below items with normal MFCI, all else equal.

---

### WS-I.2.3c Risk constraint enforcement
**ID:** WS-I.2.3c
**Ref:** Sections 13.1, 13.4

Enforce hard risk constraints that items must satisfy to remain in the feasible candidate set. Items exceeding constraint thresholds are penalized or restricted from distribution. Constraints:

- **MFCI constraint:** items with MFCI above the severe threshold are excluded from cross-community spread and flagged for immediate review.
- **PHI constraint:** recommendation sequences with holonomy risk above threshold trigger diversification or mode switch.
- **GWEI constraint:** cohort disparity above threshold blocks the ranking configuration from deployment (experiment release gate).
- **MERI constraint:** redundancy bounded -- no more than n near-identical items may appear in a single feed.
- **SCOI constraint:** high-obstruction content requires a context card before distribution.
- **Safety-policy constraint:** content under active moderation, legally restricted, or age-inappropriate for the requesting user is excluded.

Constraint enforcement produces a feasible set from the candidate set. Items removed by constraints are logged with the constraint that excluded them.

**Acceptance criteria:**
- Each constraint has a configurable threshold.
- Items exceeding MFCI severe threshold are excluded from cross-community distribution.
- Items exceeding PHI threshold trigger feed diversification for the affected user.
- GWEI disparity above threshold blocks the ranking profile from production deployment.
- Feed contains at most n items from the same MERI duplicate group.
- High-SCOI items are distributed only with an attached context card.
- Safety-filtered items never appear in the feed.
- Every constraint exclusion is logged with item_id, constraint_name, threshold, actual_value.

**Testing:**
- Unit test: items with MFCI above threshold are excluded from the feasible set.
- Unit test: safety-filtered items are always excluded regardless of score.
- Unit test: MERI constraint limits duplicate group representation.
- Integration test: a feed request with high-SCOI items includes context cards.
- Integration test: constraint exclusion log entries are queryable by constraint type.
- Edge case test: an item that violates multiple constraints is logged with all violated constraints.

---

### WS-I.2.3d Baseline computation
**ID:** WS-I.2.3d
**Ref:** Sections 5.4, 5.5

Compute the baseline B_i,t for each item. The baseline provides a time-sensitive starting score based on:

- **Freshness decay:** items receive a higher baseline when new, decaying over time. The decay curve is configurable per content type (breaking news decays faster than evergreen analysis).
- **Source reliability:** derived from the source's history within Licio -- correction frequency, evidence-type distribution, community context notes, and citation by later summaries. Source reliability is NEVER derived from popularity, follower count, or external social metrics.
- **Topic relevance:** match between the item's topics and the user's configured interests. User interests are derived from their attention and participation history (never from wallet activity or payment history).

The baseline is on the same scale as the normalized positive PWAtt score so that fresh content with no participation yet has a nonzero score.

**Acceptance criteria:**
- Freshness decay produces a higher baseline for newer items.
- Decay curves are configurable per content type (at least breaking-news and evergreen profiles).
- Source reliability is computed from Licio-internal history (corrections, evidence, citations).
- Source reliability has zero dependency on external popularity, follower counts, or social metrics.
- Topic relevance matches item topics to user interests.
- Topic relevance has zero dependency on wallet, payment, or donor data.
- Baseline is on the same scale as the normalized positive PWAtt components.

**Testing:**
- Unit test: two items identical except for age produce different baselines (newer is higher).
- Unit test: a source with high correction accuracy and citation frequency has higher reliability.
- Unit test: source reliability computation has zero references to follower count or external metrics.
- Unit test: topic relevance for a user with configured interests ranks relevant items higher.
- Integration test: a brand-new item with no participation has a nonzero baseline score.

---

### WS-I.2.4a Matroid-based dedup
**ID:** WS-I.2.4a
**Ref:** Sections 7, 13.4

Implement matroid-rank-based deduplication using MERI to prevent near-identical items from dominating the feed. The diversification pass groups items by their MERI duplicate cluster and limits representation: at most n items from the same cluster may appear in a single feed response.

Within a cluster, items are selected by their PWAtt score after penalties. The remaining items in the cluster are available for "more on this story" expansion but do not occupy primary feed positions. The dedup boundary is configurable (default n=2 per cluster in a 30-item feed page).

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
- Integration test: "more on this story" expansion returns remaining cluster items.
- Edge case test: a cluster with exactly n items shows all n.

---

### WS-I.2.4b Source and topic balancing
**ID:** WS-I.2.4b
**Ref:** Section 13.4

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

---

### WS-I.2.4c SCOI context gating
**ID:** WS-I.2.4c
**Ref:** Sections 10.4, 10.6, 13.4

Implement context gating for high-obstruction content. When SCOI indicates that an item has high context obstruction (interpretations diverge significantly across communities), the item receives a context card before broad distribution.

Context gating levels:
- **Low SCOI:** normal distribution, no context card.
- **Medium SCOI:** context card is included with the feed item showing where interpretations differ.
- **High SCOI:** cross-community distribution is reduced until context improves; context card is required.
- **Very high SCOI:** distribution is paused for bridge/expert context or moderator review.

Context cards include: lens map showing interpretation differences, bridge attempt links, and a composer prompt "People in another room are reading this differently."

**Acceptance criteria:**
- Items with medium SCOI include a context card in the feed response.
- Items with high SCOI have reduced cross-community distribution.
- Items with very high SCOI are paused from distribution pending review.
- Context cards include lens map data and bridge attempt references.
- Context gating decisions are logged in the decision log.
- Context gating thresholds are configurable.

**Testing:**
- Unit test: item with low SCOI has no context card.
- Unit test: item with medium SCOI includes a context card.
- Unit test: item with high SCOI has reduced distribution scope.
- Integration test: context card includes lens map data from the SCOI service.
- Integration test: very-high-SCOI item does not appear in cross-community feeds.

---

### WS-I.2.5a Decision log schema
**ID:** WS-I.2.5a
**Ref:** Sections 13.3, 23.3

Define the RankingDecisionLog schema for per-request ranking audit. Every feed request produces a decision log entry containing:

- **request_id:** unique identifier for the feed request.
- **user_privacy_bucket:** anonymized user cohort (never raw user_id in the log).
- **candidate_ids:** list of all item IDs in the candidate pool after retrieval.
- **selected_ids:** ordered list of item IDs in the final feed response.
- **score_components:** per-item breakdown of PWAtt components, penalties, and baseline for selected items.
- **invariant_versions:** map of invariant_name to version_string for each invariant used.
- **constraints_applied:** list of constraints that affected the result (exclusions, diversification, context gating).
- **explanation_ids:** per-item explanation identifiers linking to the explanation service.
- **experiment_ids:** list of active experiment IDs that influenced the ranking (if any).
- **timestamp:** ISO 8601 timestamp of the decision.

The schema is defined as a zod schema. Logs are retained for 180-365 days with access controls per Section 22.4.

**Acceptance criteria:**
- RankingDecisionLog schema is defined with all listed fields.
- Every feed request produces exactly one decision log entry.
- user_privacy_bucket is used instead of raw user_id.
- score_components include the full PWAtt breakdown per selected item.
- invariant_versions map covers all invariants used in the decision.
- constraints_applied lists every constraint that excluded or modified an item.
- Logs are access-controlled and retained per retention policy.

**Testing:**
- Unit test: decision log passes schema validation with all required fields.
- Unit test: decision log with missing fields is rejected.
- Integration test: a feed request produces a decision log entry with correct candidate and selected IDs.
- Audit test: decision log entries are retrievable by request_id.
- Privacy test: decision log contains user_privacy_bucket, not raw user_id.

---

### WS-I.2.5b Replay capability
**ID:** WS-I.2.5b
**Ref:** Sections 13.3, 30.6

Given a decision log entry, reproduce the exact same ranking. Replay reads the decision log, retrieves the feature vectors at the recorded invariant versions, applies the same ranking profile and constraints, and verifies that the output matches the logged selected_ids and ordering.

Replay is used for:
- Auditing past ranking decisions.
- Debugging ranking anomalies.
- Validating that ranking code changes do not alter past decisions (regression detection).
- Transparency investigations.

The replay function accepts a request_id, retrieves the decision log entry and corresponding feature vectors, executes the ranking pipeline, and returns a pass/fail comparison with a diff of any discrepancies.

**Acceptance criteria:**
- Replay function accepts a request_id and produces a ranking result.
- Replayed ranking matches the original logged selected_ids and ordering.
- Discrepancies are reported as a structured diff (item_id, expected_position, actual_position, score_diff).
- Replay uses the invariant versions recorded in the decision log, not current versions.
- Replay works for any decision log entry within the retention period.

**Testing:**
- Unit test: replay a known decision log entry and verify exact match.
- Unit test: replay with a modified ranking profile produces a diff.
- Integration test: after a ranking code change, replay a set of historical decisions and report any regressions.
- Edge case test: replay of a decision log entry near the retention boundary still works.

---

### WS-I.2.5c Audit query interface
**ID:** WS-I.2.5c
**Ref:** Sections 23.3, 30.6

Provide a query interface for searching and inspecting ranking decision logs. The interface supports search by:

- **Time range:** decisions made within a date/time window.
- **User privacy bucket:** decisions for a specific anonymized cohort.
- **Item ID:** all decisions that included a specific item as a candidate or selected item.
- **Invariant name and version:** decisions that used a specific invariant version.
- **Constraint name:** decisions where a specific constraint was applied.
- **Experiment ID:** decisions influenced by a specific experiment.

Results include the full decision log entry and support pagination. The interface is access-controlled -- only authorized roles (ranking engineers, safety moderators, auditors) can query decision logs.

**Acceptance criteria:**
- Query interface supports all six search dimensions.
- Results include the full RankingDecisionLog entry.
- Results are paginated for large result sets.
- Access is restricted to authorized roles.
- Queries complete within acceptable latency for dashboard use (target: under 5 seconds for a 1000-result query).
- Query audit: every query to the decision log is itself logged (who queried, what criteria, when).

**Testing:**
- Unit test: each search dimension returns correct results from fixture data.
- Unit test: unauthorized role is denied access.
- Integration test: query by item_id returns all decisions that included that item.
- Performance test: query over a 30-day window with 100k decision logs completes within latency target.
- Audit test: querying decision logs produces a meta-audit log entry.

---

### WS-I.2.6a Explanation template system
**ID:** WS-I.2.6a
**Ref:** Section 13.5

Build a structured template system for generating user-facing distribution explanations. Each template corresponds to a signal type or ranking event and produces a specific, human-readable sentence. Templates are parameterized and composable.

Template categories:
- **Positive signals:** rising attention, evidence additions, source verification, bridge activity, constructive participation.
- **Contextual signals:** SCOI interpretation divergence, lens differences, community context.
- **Constraint signals:** MFCI distribution slowing, MERI redundancy dampening, PHI diversification.
- **Safety signals:** content under review, integrity investigation, policy restriction.

Each template has: template_id, signal_type, template_string with parameter placeholders, parameter schema, priority (for selecting the most relevant explanation when multiple apply), and localization keys for i18n.

**Acceptance criteria:**
- Templates exist for all four categories (positive, contextual, constraint, safety).
- Each template has a unique ID, signal type, parameterized string, and priority.
- Templates are localization-ready with i18n keys.
- Template parameters are validated against the parameter schema.
- Templates never produce vague explanations like "because of the algorithm" or "trending."

**Testing:**
- Unit test: each template renders correctly with valid parameters.
- Unit test: template with invalid parameters is rejected.
- Unit test: template selection by priority produces the most relevant explanation.
- Snapshot test: all templates are captured to detect unreviewed changes.
- Localization test: templates render in at least two languages.

---

### WS-I.2.6b User-facing explanation generation
**ID:** WS-I.2.6b
**Ref:** Sections 13.5, 13.6

Generate specific, human-readable distribution reasons for every feed item. The explanation service selects the most relevant templates based on the item's ranking signal profile and renders them with concrete parameters.

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

Each explanation links to the item's signal ledger entry for users who want deeper inspection.

**Acceptance criteria:**
- Every feed item in the response includes a distribution_reason string.
- Explanations reference specific, verifiable signals (room count, evidence count, source type).
- No explanation contains prohibited vague language.
- Explanations link to the signal ledger for detailed inspection.
- Explanations are generated within the feed response latency budget.
- Explanations are consistent with the decision log -- the explanation matches the actual ranking signals.

**Testing:**
- Unit test: explanation generation for each signal type produces a specific, parameterized string.
- Unit test: a feed item with multiple active signals produces the highest-priority explanation.
- Negative test: attempt to generate a vague explanation is blocked by the template system.
- Integration test: every item in a feed response has a non-empty distribution_reason.
- Consistency test: explanation matches the score_components in the decision log.

---

### WS-I.2.6c Distribution-slowing explanations
**ID:** WS-I.2.6c
**Ref:** Sections 8.6, 13.5

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

---

## WS-I.3 Ranking-neutrality test suite

### WS-I.3.1a Test 1 -- Feed replay with/without wallet links produces identical ranking
**ID:** WS-I.3.1a
**Ref:** Section 30.6

Automated test that proves wallet linkage has no effect on organic ranking. The test creates two identical user profiles -- one with a linked wallet, one without -- gives them identical attention and participation history, and verifies that a feed request for each user produces the identical ranking order and scores.

The test runs with real payment events in staging (not just absent payment data) to verify that the presence of wallet infrastructure does not leak into ranking.

**Acceptance criteria:**
- Two test users with identical behavior but different wallet states produce identical feed rankings.
- The test uses real (staging) payment events, not just empty payment data.
- Any ranking difference causes a CI failure with a detailed diff.
- The test covers front-page, room, and topic feeds.

**Testing:**
- CI test: runs on every commit to ranking, feature store, or candidate retrieval code.
- CI test: runs before every crypto release.
- Staging test: runs with real payment events before any real-funds pilot.

---

### WS-I.3.1b Test 2 -- Payment amount absent from organic feature schemas
**ID:** WS-I.3.1b
**Ref:** Section 30.6

Automated test that verifies payment amount fields do not exist in any organic ranking feature schema. The test inspects the feature vector schema (WS-I.2.1a), the candidate retrieval queries (WS-I.1.1c), and the scoring engine inputs for any field or column referencing payment amounts.

**Acceptance criteria:**
- Static analysis of all organic feature schemas finds zero payment-amount fields.
- Static analysis of scoring engine function signatures finds zero payment-related parameters.
- Any addition of a payment-related field to an organic schema causes a CI failure.

**Testing:**
- CI test: schema inspection runs on every commit to feature store or scoring code.
- Static analysis: grep/AST scan for payment-related field names in organic schemas.

---

### WS-I.3.1c Test 3 -- Donor identity absent from PWAtt and invariant joins
**ID:** WS-I.3.1c
**Ref:** Section 30.6

Automated test that verifies donor identity is not used in PWAtt computation or invariant feature joins. The test inspects:

- PWAtt scoring function inputs for any donor-related fields.
- Invariant feature join queries for any JOIN to donor/payment/treasury tables.
- Feature store population pipeline for any donor-identity propagation.

**Acceptance criteria:**
- PWAtt computation has zero donor-identity inputs.
- Invariant feature joins reference zero donor/payment/treasury tables.
- Feature store population pipeline propagates zero donor-identity fields.
- Any addition of donor-related joins causes a CI failure.

**Testing:**
- CI test: static analysis of PWAtt function, join queries, and population pipeline.
- Integration test: PWAtt scores are identical for items whose only difference is donor identity.

---

### WS-I.3.1d Test 4 -- Treasury balance does not change story rank
**ID:** WS-I.3.1d
**Ref:** Section 30.6

Automated test that verifies a room's treasury balance has no effect on the ranking of stories within or from that room. The test creates two identical rooms -- one with a funded treasury, one with no treasury -- submits identical stories, and verifies identical ranking.

The only exception is a manually approved, non-amount public-interest prompt in a dedicated treasury surface, which is separate from the organic feed.

**Acceptance criteria:**
- Stories from rooms with different treasury balances receive identical ranking in the organic feed.
- Treasury balance is not present in any feature vector used for organic ranking.
- The test covers both room-internal feeds and cross-room front-page feeds.

**Testing:**
- CI test: two rooms with different treasury balances produce identical story rankings.
- Integration test: treasury-funded content appears only in dedicated treasury surfaces, not in organic ranking.

---

### WS-I.3.1e Test 5 -- Governance vote outcomes do not change claim labels without evidence/steward process
**ID:** WS-I.3.1e
**Ref:** Section 30.6

Automated test that verifies governance vote outcomes cannot change factual claim labels. Claim labels (verified, disputed, unverified, etc.) are changed only through evidence submission and steward review, never by governance vote alone.

The test creates a claim with a label, simulates a governance vote that attempts to change the label, and verifies the label is unchanged. The label changes only when evidence is submitted and a steward reviews it.

**Acceptance criteria:**
- Governance vote outcomes do not modify claim labels.
- Claim label changes require evidence submission and steward review.
- An attempt to change a claim label via governance vote produces no effect and is logged.

**Testing:**
- CI test: governance vote attempting to change a claim label has no effect.
- Integration test: claim label changes only through the evidence/steward workflow.
- Audit test: attempted governance-driven label changes are logged.

---

### WS-I.3.1f Test 6 -- Paid membership does not bypass safety, rate limits, or moderation
**ID:** WS-I.3.1f
**Ref:** Section 30.6

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
- Integration test: moderation action on a paid user is identical to action on an unpaid user.
- Static analysis: no safety/moderation code path references membership status.

---

### WS-I.3.1g Test 7 -- ML feature audits fail if wallet/payment/treasury fields added to organic rankers
**ID:** WS-I.3.1g
**Ref:** Section 30.6

Automated test that verifies the ML feature audit pipeline detects and rejects any addition of wallet, payment, or treasury fields to organic ranking models. The test:

1. Adds a wallet-related field to the organic feature schema.
2. Runs the ML feature audit.
3. Verifies the audit fails with a specific error identifying the prohibited field.
4. Removes the field and verifies the audit passes.

This test validates the denylist enforcement (WS-I.2.1b) at the ML pipeline level, not just the schema level.

**Acceptance criteria:**
- Adding a wallet/payment/treasury field to an organic ranker triggers an audit failure.
- The audit failure message identifies the specific prohibited field.
- The audit passes when no prohibited fields are present.
- The audit runs automatically on any change to ML model features.

**Testing:**
- CI test: intentionally add a prohibited field, verify audit failure.
- CI test: remove the field, verify audit passes.
- Integration test: audit runs as part of the ML model deployment pipeline.

---

### WS-I.3.1h Test 8 -- Sponsored/treasury-funded content labeled and excluded from unpaid ranking
**ID:** WS-I.3.1h
**Ref:** Section 30.6

Automated test that verifies sponsored and treasury-funded content is clearly labeled and excluded from the organic (unpaid) ranking pipeline. Sponsored content:

- Carries a visible "Sponsored" or "Treasury-funded" label in the feed.
- Does not enter the organic candidate retrieval pipeline.
- Does not influence PWAtt scores of organic items.
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

---

### WS-I.3.1i Test 9 -- Public explanations state payments are support/governance, not endorsements
**ID:** WS-I.3.1i
**Ref:** Section 30.6

Automated test that verifies public-facing explanations about payment features describe payments as support and governance actions, never as endorsements, votes, or quality signals. The test inspects:

- All explanation templates related to payment/treasury/governance features.
- User-facing copy in payment flows.
- Help/FAQ content about payments.

The test checks for prohibited language: "endorse," "boost," "promote," "recommend," "vote for quality," "shows support means better."

**Acceptance criteria:**
- No public explanation or payment-related copy uses endorsement language.
- Payment explanations describe payments as "support," "governance," "community funding," or equivalent neutral terms.
- Prohibited language patterns are defined and checked automatically.

**Testing:**
- CI test: scan all explanation templates and payment-related UI strings for prohibited language.
- CI test: new explanation templates are checked against the prohibited language list.
- Review test: all payment-related copy is reviewed for neutral framing.

---

### WS-I.3.1j Test 10 -- Dashboards separate revenue/treasury metrics from product-health metrics
**ID:** WS-I.3.1j
**Ref:** Section 30.6

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

---

## Workstream definition of done

WS-I is complete when ALL of the following conditions hold:

1. **Feature store denylist:** The ranking feature store schema-level denylist rejects wallet balances, payment history, donor status, token holdings, and all other financial fields. Attempts to add denied fields fail at migration time.

2. **Scoring engine:** The scoring engine assembles PWAtt scores, invariant outputs, and safety constraints into a composite ranking score with normalized, configurable weights.

3. **MERI diversification:** Feed diversification uses MERI independence scores to prevent duplicate and near-duplicate content from clustering in the feed.

4. **Neutrality tests in CI:** All 10 ranking-neutrality tests pass in CI on every PR. Tests verify that wallet activity, payment status, donor tier, token holdings, and other financial signals have zero influence on ranking.

5. **Per-item explanations:** Every ranked item has a specific, human-readable explanation of why it was ranked at its position, referencing the signals and invariants that contributed to the score.

6. **Kill switch:** The ranking kill switch is operational and can immediately revert the feed to a safe fallback (chronological or editorial) without requiring a deployment.
