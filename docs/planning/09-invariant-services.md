# WS-H: Core Invariant Services

**Milestone:** M2 | **Priority:** 2 | **Dependencies:** WS-E, WS-F, WS-G | **Wave:** 5 | **Estimated duration:** 6-8 weeks

---

## Overview

All 11 invariants run in shadow before affecting ranking. Each output carries confidence, coverage, reason codes, and fallback behavior (Sections 21.4, 30.4). The five core invariants -- MERI, MFCI, GWEI, SCOI, PHI -- provide the primary mathematical guardrails for ranking, fairness, context integrity, coordination detection, and path-dependent steering. Six supporting invariants -- Hodge, Tropical, Braid, Reeb, CID, and Path-signature -- add complementary signals without overcomplicating the user experience. Every invariant ships as a confidence-bearing service with the same discipline: versioned outputs, invariant cards, graceful fallback, and regression testing on synthetic datasets.

### Cross-cutting invariant contracts

Every task in this workstream upholds the following non-negotiable contracts. They are restated here so each task can reference them rather than repeat them, and they are enforced by the platform tasks in WS-H.1.

- **Shadow before enforcement.** No invariant influences ranking, moderation, or wellbeing intervention until it has run in shadow, accumulated drift-free regression history, and passed the explicit promotion gate (WS-H.1.2e). In shadow mode an invariant computes and logs only; it carries zero enforcement authority.
- **Confidence, coverage, reason codes, fallback on every output.** Each `InvariantOutput` carries a `confidence` in `[0, 1]`, a `coverage` in `[0, 1]`, a machine-readable `reason_codes` array, and a `fallback_used` indicator. An invariant that cannot meet its minimum coverage emits a low-confidence output with an explanatory reason code rather than a misleading score.
- **Graceful fallback, never silent failure.** A failed or low-coverage invariant degrades gracefully: ranking proceeds without its contribution (features omitted, never defaulted to a biasing value), the gap is logged, and a monitoring event is emitted.
- **Privacy by construction.** PHI, path-signature, and any session-derived invariant operate on topic-cluster IDs, event types, and timing only -- never raw content or other users' identities. GWEI and MFCI operate on aggregates and conditioned margins, never individual user histories exposed to analysts beyond role-gated, audited access.
- **Gauge / approximation honesty.** Any invariant using an approximation (MERI similarity-graph fallback, GWEI entropic regularization, MFCI MCMC sampling, PHI matrix-log fallback, SCOI normalization) records the approximation, its guarantee, and its confidence interval in the invariant card and per-output metadata.

### Versioned staging across all core invariants (Section 30.4)

| Invariant | v0 (shadow) | v1 (analyst-gated effect) | v2 (full method) |
|---|---|---|---|
| MERI | URL/text-similarity dedup | Multi-dimensional independence | Matroid rank with learned constraints + explainable labels |
| MFCI | Shadow anomaly reports with fixed margins | Analyst-reviewed dampening for high-confidence coordination | Markov-basis/SMC sampling of conditional fiber + adversarial-adaptation tests |
| GWEI | Descriptive cohort dashboards | Entropic-regularized GW with seed-stability | Release-gating + mitigation recommendations |
| SCOI | Lens-summary disagreement labels + steward reports | Sheaf-Laplacian Dirichlet-energy obstruction + bridge/context routing | Cohomological obstruction classes (`H1`, harmonic representative) |
| PHI | Narrow-loop/compulsive-session detection | Orthogonal transport estimation + high-risk-loop dampening | Gauge-invariant holonomy diagnostics |

---

## WS-H.1 Invariant computation platform

### WS-H.1.1a InvariantOutput table
**ID:** WS-H.1.1a
**Ref:** Section 22.1

**Description:**
Define `InvariantOutput` in Drizzle: `invariant_output_id` (UUID PK), `invariant_type` (enum: MERI, MFCI, GWEI, SCOI, PHI, hodge_tension, tropical_cascade, braid_dynamics, reeb_landscape, counterfactual_defect, path_signature_wellbeing), `target_type` (enum: story, thread, feed, room, cohort, session), `target_id` (UUID), `time_window` (JSONB with `start` and `end` ISO timestamps), `version` (string, semver), `score_vector` (JSONB -- structure varies per invariant type, validated by per-type zod schemas), `explanation_summary` (text), `confidence` (numeric 0-1), `coverage` (numeric 0-1), `created_at` (timestamp with timezone).

**Acceptance criteria:**
- Table created with all fields, correct types, and NOT NULL constraints on `invariant_type`, `target_type`, `target_id`, `version`, `score_vector`, `confidence`, `coverage`.
- `invariant_type` enum contains all 11 invariant types.
- `target_type` enum contains all 6 target types (story, thread, feed, room, cohort, session).
- `score_vector` JSONB validated per invariant type at the application layer (not DB constraint).
- `confidence` and `coverage` columns have CHECK constraints enforcing `[0, 1]` range.
- Indexes on `(invariant_type, target_type, target_id)`, `(target_id, invariant_type)`, `(created_at)`, and `(invariant_type, version)`.
- Composite index on `(invariant_type, target_type, created_at DESC)` for time-range queries.

**Testing:**
- Unit: schema validation accepts valid invariant output rows for each of the 11 types.
- Unit: CHECK constraints reject confidence/coverage outside `[0, 1]`.
- Unit: enum columns reject values not in the defined enum.
- Integration: insert and query by each index path.
- Migration: up and down migrations are idempotent.

**Dependencies:** WS-A (schema tooling), WS-E (event pipeline for invariant run events).

---

### WS-H.1.1b InvariantOutput versioning
**ID:** WS-H.1.1b
**Ref:** Section 30.4

**Description:**
Version column on `InvariantOutput` enables A/B comparison of invariant algorithm versions. Add a `version_metadata` JSONB column storing algorithm parameters, model hashes, and configuration snapshots. Create a `version_comparison` view or query utility that joins two versions of the same invariant on the same target for side-by-side score comparison.

**Acceptance criteria:**
- `version` column follows semver format, enforced by application-layer validation.
- `version_metadata` JSONB stores algorithm configuration for reproducibility.
- A query utility or view retrieves paired outputs for two versions of the same invariant on the same target set.
- Version comparison supports filtering by time window and target type.
- Old versions are retained (not overwritten) when a new version is computed.

**Testing:**
- Unit: version format validation accepts valid semver, rejects invalid.
- Integration: insert two versions of MERI for the same story; comparison query returns both.
- Integration: filtering by time window returns only outputs within range.

**Dependencies:** WS-H.1.1a.

---

### WS-H.1.1c Reason-code and coverage schema
**ID:** WS-H.1.1c
**Ref:** Sections 30.4, 21.4

**Description:**
Add first-class modeling of reason codes and coverage to `InvariantOutput`, satisfying the SPEC requirement that every output carries "confidence, coverage, reason codes, and fallback behavior." Define a `reason_codes` JSONB array column and a shared `ReasonCode` enum/registry (e.g., `INSUFFICIENT_COVERAGE`, `APPROXIMATION_FALLBACK`, `NULL_CALIBRATION_STALE`, `MATROID_FALLBACK`, `MATRIX_LOG_FALLBACK`, `SAMPLER_NONCONVERGENCE`, `SAFETY_GATE_REQUIRED`). Define a shared coverage convention: coverage is the fraction of required inputs that were available and fresh for the target (per-invariant numerator/denominator documented in each invariant card). The `fallback_used` boolean and a `degraded` boolean are derivable from reason codes.

**Acceptance criteria:**
- `reason_codes` column added as JSONB array; values validated against a versioned `ReasonCode` registry.
- A shared TypeScript type `InvariantOutputEnvelope` exposes `{ score_vector, confidence, coverage, reason_codes, fallback_used, version }`.
- Coverage convention documented: each invariant declares what counts toward coverage in its card (WS-H.1.2b).
- Every emitted output includes at least an empty `reason_codes` array; degraded outputs include the specific code(s).
- Reason codes are queryable for operational dashboards (index or generated column as needed).

**Testing:**
- Unit: reason-code validation rejects codes not in the registry.
- Unit: degraded output includes the correct reason code(s) and `fallback_used = true`.
- Unit: coverage in `[0, 1]`; output with no available inputs reports coverage 0 with `INSUFFICIENT_COVERAGE`.
- Integration: dashboard query filters outputs by reason code.

**Dependencies:** WS-H.1.1a.

---

### WS-H.1.1d Per-invariant score_vector schemas
**ID:** WS-H.1.1d
**Ref:** Sections 22.1, 30.4

**Description:**
Define the per-invariant-type zod schemas validating the `score_vector` JSONB, so each invariant's output shape is explicit, testable, and versioned. The schemas live in `packages/invariants/src/schemas/scoreVectors.ts`. Representative shapes:

```ts
// MERI
interface MeriScoreVector { meri: number; marginal_gains: Record<string, number>;
  approximation: boolean; per_class_bounds: Record<string, number>; group_ids: string[]; }
// MFCI
interface MfciScoreVector { mfci: number; p_hat: number; statistic: 'synchrony'|'target_concentration'|'phrase_repetition';
  sample_count: number; fixed_margins_ref: string; risk_state: 'normal'|'elevated'|'high'|'severe'; }
// GWEI
interface GweiScoreVector { gw2: number; ci_low: number; ci_high: number; seed_count: number;
  regularization: number; cohort_a: string; cohort_b: string; metric_breakdown: Record<string, number>; }
// SCOI
interface ScoiScoreVector { scoi: number; normalizer: number; overlap_count: number; lens_count: number;
  context_state: 'coherent'|'ambiguous'|'split'|'obstructed'|'weaponized'; per_overlap_energy: Record<string, number>; }
// PHI
interface PhiScoreVector { phi: number; rotation_angles: number[]; loop_path: string[];
  fallback_log: boolean; sensitive: boolean; }
```

**Acceptance criteria:**
- A zod schema exists per invariant type; the union discriminates on `invariant_type`.
- Each schema mirrors the mathematical output (e.g., MFCI carries `p_hat` and `mfci = -log p_hat`; PHI carries `rotation_angles`).
- Application-layer validation in WS-H.1.1a calls the matching schema before insert.
- Schemas are exported for use by invariant implementations and the regression harness.
- Schema changes are versioned and snapshot-tested.

**Testing:**
- Unit: each schema accepts a valid score_vector and rejects malformed ones.
- Unit: discriminated union routes by `invariant_type`.
- Snapshot: score_vector schemas are snapshot-tested to flag unreviewed shape changes.

**Dependencies:** WS-H.1.1a, WS-H.1.1c.

---

### WS-H.1.2a InvariantService interface
**ID:** WS-H.1.2a
**Ref:** Section 21.4

**Description:**
Define the `InvariantService` interface in `packages/invariants/`. Every invariant implementation must conform to this interface. Methods: `computeBatch(targets: Target[], window: TimeWindow): Promise<InvariantOutput[]>` -- batch computation for audits and backfills; `computeRealtime(target: Target): Promise<InvariantOutput>` -- near-real-time approximation for ranking integration; `getCard(): InvariantCard` -- returns the invariant's model/invariant card; `getHealthMetrics(): HealthMetrics` -- returns computation health (latency, error rate, coverage, last successful run).

**Acceptance criteria:**
- Interface exported from `packages/invariants/src/types.ts`.
- All 11 invariant implementations conform to the interface (enforced by TypeScript).
- `computeBatch` supports parallel execution across targets.
- `computeRealtime` returns within a configurable latency budget (logged when exceeded).
- `getCard` returns a complete `InvariantCard` (see WS-H.1.2b).
- `getHealthMetrics` reports latency percentiles, error count, coverage ratio, and last success timestamp.

**Testing:**
- Unit: a mock implementation satisfies the interface at compile time.
- Unit: type errors when a method is missing or has wrong signature.
- Integration: a concrete invariant passes the interface conformance check.

**Dependencies:** WS-H.1.1a.

---

### WS-H.1.2b Invariant card schema
**ID:** WS-H.1.2b
**Ref:** Sections 21.4, 30.4

**Description:**
Define the `InvariantCard` schema (zod + TypeScript type) documenting each invariant's operational profile. Fields: `invariant_type` (enum), `owner` (team or individual responsible), `version` (semver), `input_schema` (JSON Schema reference describing expected inputs), `output_schema` (JSON Schema reference describing score_vector structure), `confidence_bounds` (object with `min`, `typical`, `max` numeric values), `coverage_bounds` (object with `min_acceptable`, `typical`), `coverage_definition` (text: what counts toward coverage), `known_failure_modes` (array of `{ mode: string, impact: string, mitigation: string }`), `fallback_behavior` (description of what happens when computation fails), `approximation_notes` (description of any mathematical approximation, e.g., greedy vs exact, entropic regularization), `shadow_status` (enum: shadow, soft_constraint, hard_constraint), `dependencies` (array of upstream service names).

**Acceptance criteria:**
- Card schema defined as zod schema in `packages/invariants/src/schemas/card.ts`.
- Every invariant implementation returns a valid card from `getCard()`.
- Cards include all required fields; no field is empty or placeholder.
- `known_failure_modes` is non-empty for every invariant (every invariant has at least one).
- `approximation_notes` is non-empty for invariants using approximations (MERI general fallback, GWEI entropic regularization, MFCI MCMC sampling, PHI matrix log fallback).
- `coverage_definition` is non-empty and matches the convention in WS-H.1.1c.
- `shadow_status` defaults to `shadow` and is only advanced by the promotion gate (WS-H.1.2e).
- Cards are version-controlled and updated when the algorithm changes.

**Testing:**
- Unit: zod schema parses valid cards, rejects cards with missing fields.
- Unit: each invariant's `getCard()` output passes zod validation.
- Unit: `shadow_status` cannot be set to a constraint mode without a corresponding promotion record.
- Snapshot: card contents are snapshot-tested to detect unreviewed changes.

**Dependencies:** WS-H.1.2a.

---

### WS-H.1.2c Fallback execution wrapper
**ID:** WS-H.1.2c
**Ref:** Sections 21.4, 30.4

**Description:**
Execution wrapper that invokes each invariant with a timeout and try/catch. If an invariant computation fails (timeout, error, insufficient data), the wrapper returns a degraded envelope and ensures ranking proceeds without that invariant's contribution -- features omitted, never defaulted to zero or any value that could bias ranking. The wrapper attaches the correct reason code (`INSUFFICIENT_COVERAGE`, `APPROXIMATION_FALLBACK`, etc.) and emits a gap event. This task covers only the wrapper and gap-event emission; dashboards and alerting are WS-H.1.2c-2.

**Acceptance criteria:**
- Ranking pipeline wraps each invariant call with try/catch and a configurable timeout.
- On failure: ranking continues with remaining invariants; the failed invariant's features are omitted (not defaulted).
- Gap event emitted with `invariant_type`, `target_id`, `failure_reason`, `timestamp`, `fallback_used`, and `reason_codes`.
- Fallback behavior matches what is documented in the invariant card.
- No invariant failure blocks ranking entirely (verified by integration test with all invariants failing).

**Testing:**
- Unit: simulated invariant failure does not crash the ranking pipeline.
- Unit: gap event is emitted with correct fields on failure.
- Unit: timeout triggers fallback path and a `TIMEOUT` reason code.
- Integration: ranking produces valid output when one, two, or all invariants fail.

**Dependencies:** WS-H.1.2a, WS-H.1.1c.

---

### WS-H.1.2c-2 Gap monitoring and alerting
**ID:** WS-H.1.2c-2
**Ref:** Sections 21.4, 30.4

**Description:**
Consume gap events from the fallback wrapper into a monitoring dashboard and alerting pipeline. The dashboard shows per-invariant failure rate, coverage, and fallback rate over time; alerting triggers when any invariant's failure rate or fallback rate exceeds a configurable threshold. This is the operational complement to WS-H.1.2c.

**Acceptance criteria:**
- Gap events feed a monitoring dashboard showing per-invariant failure rate, coverage, and fallback rate.
- Alerting triggers when any invariant's failure rate exceeds a configurable threshold.
- Dashboard distinguishes hard failures (errors/timeouts) from soft degradations (low coverage).
- Alert routing is configurable per invariant owner (from the invariant card `owner`).

**Testing:**
- Integration: monitoring dashboard receives and aggregates gap events.
- Integration: alert fires when synthetic failure rate exceeds threshold.
- Integration: dashboard separates hard failures from low-coverage degradations.

**Dependencies:** WS-H.1.2c.

---

### WS-H.1.2d Synthetic dataset generator
**ID:** WS-H.1.2d
**Ref:** Section 21.4

**Description:**
Deterministic synthetic dataset generator for invariant services. Given a seed, the generator produces reproducible inputs for each invariant (candidate exposures for MERI, contingency tables for MFCI, cohort spaces for GWEI, lens interpretations for SCOI, topic paths for PHI, and supporting-invariant inputs). Each dataset has known or analytically derivable expected outputs used as regression baselines.

**Acceptance criteria:**
- Synthetic dataset generator produces deterministic data given a seed.
- Each of the 11 invariants has at least one synthetic dataset with known expected outputs.
- Datasets include edge cases (empty input, single item, maximally redundant, maximally diverse) per invariant.
- Generator output is serializable and version-controlled alongside algorithm code.

**Testing:**
- Unit: deterministic seed produces identical synthetic data across runs.
- Unit: each invariant's dataset produces the documented expected output under the reference implementation.
- Unit: edge-case datasets are present for every invariant.

**Dependencies:** WS-H.1.1d.

---

### WS-H.1.2d-2 Regression harness and drift detection
**ID:** WS-H.1.2d-2
**Ref:** Section 21.4

**Description:**
Regression test harness that runs each invariant against its synthetic datasets, compares outputs against baseline snapshots, and flags deviations beyond per-invariant tolerance. Drift detection runs in CI on every PR touching `packages/invariants/` and as a scheduled nightly job against production algorithm versions.

**Acceptance criteria:**
- Harness runs all invariants against their datasets, compares outputs to baselines, and reports pass/fail with deviation magnitude.
- Drift detection uses configurable tolerance per invariant (e.g., MERI score within 0.01, MFCI p-value within 0.05, GWEI distance within its reported CI, PHI within 0.01).
- Harness runs in CI on every PR that touches `packages/invariants/`.
- Scheduled nightly run against production algorithm versions detects gradual drift and emits a report.
- Baseline snapshots are version-controlled; updating a baseline requires explicit review.

**Testing:**
- Unit: harness detects intentional drift (modify algorithm, verify harness flags it).
- Unit: harness passes when outputs are within tolerance.
- CI: harness runs and reports results in PR checks.
- Scheduled: nightly job runs and reports drift over time.

**Dependencies:** WS-H.1.2d.

---

### WS-H.1.2e Shadow-to-enforcement promotion gate
**ID:** WS-H.1.2e
**Ref:** Sections 30.4, 21.4

**Description:**
Implement the mechanism that enforces "shadow before enforcement." An invariant's `shadow_status` (shadow -> soft_constraint -> hard_constraint) can only advance via a recorded promotion that satisfies a checklist: minimum shadow duration, drift-free regression history, coverage and confidence above documented bounds, and a named owner sign-off. The ranking integration reads `shadow_status` and applies an invariant's effect only when status is a constraint mode. This is the single control point guaranteeing no invariant grants enforcement authority while in shadow.

**Acceptance criteria:**
- A `PromotionRecord` captures invariant_type, from-status, to-status, evidence (shadow duration, drift report ref, coverage/confidence stats), owner, and timestamp.
- `shadow_status` cannot advance without a valid `PromotionRecord`.
- Ranking and moderation integrations apply an invariant's effect only when `shadow_status` is `soft_constraint` or `hard_constraint`.
- Promotion is reversible: demotion back to shadow is supported and logged (a kill-switch path).
- M2 milestone gate "No hidden sanctions" is satisfied: in shadow, invariants report reason codes and fallback but never sanction.

**Testing:**
- Unit: status cannot advance without a promotion record.
- Unit: an invariant in shadow contributes no enforcement effect even if its output is extreme.
- Integration: promotion enables effect; demotion disables it.
- Integration: demotion (kill switch) takes effect without redeploy.

**Dependencies:** WS-H.1.2b, WS-H.1.2c.

---

### WS-H.1.2f Compute-tier scheduling and orchestration
**ID:** WS-H.1.2f
**Ref:** Section 21.4

**Description:**
Wire invariants into the tiered computation platform: a real-time tier (cheap approximations for ranking, e.g., MFCI cheap stats, PHI loop detection, MERI marginal gain), a near-real-time tier (sampled approximations), and a batch tier (audits, backfills, full fiber tests, GW computation). Define scheduling, concurrency limits, and back-pressure so batch jobs do not starve real-time computation. Persist run metadata (tier, duration, target count) for observability.

**Acceptance criteria:**
- Each invariant declares which methods run in which tier; the scheduler routes accordingly.
- Real-time tier enforces per-call latency budgets; near-real-time and batch tiers run on a schedule or queue.
- Concurrency limits and back-pressure prevent batch jobs from degrading real-time latency.
- Run metadata (tier, target count, duration, success) persisted and exposed to `getHealthMetrics`.
- Scheduling configuration is version-controlled and auditable.

**Testing:**
- Unit: scheduler routes a method to the correct tier.
- Integration: batch backlog does not push real-time latency past budget (load test).
- Integration: run metadata recorded for each tier.

**Dependencies:** WS-H.1.2a, WS-E (event pipeline).

---

### WS-H.1.2g Invariant observability metrics
**ID:** WS-H.1.2g
**Ref:** Section 21.4

**Description:**
Standardized observability for every invariant: emit metrics for confidence distribution, coverage distribution, compute time (per tier), output volume, fallback rate, and drift (deviation from rolling baseline). These feed a per-invariant health dashboard and the regression nightly report. Observability is uniform across all 11 invariants so an on-call engineer can reason about any invariant the same way.

**Acceptance criteria:**
- Each invariant emits: confidence histogram, coverage histogram, compute-time percentiles per tier, output count, fallback rate, and drift gauge.
- A per-invariant health dashboard renders these metrics with time ranges.
- Drift gauge compares current output distribution to a rolling baseline and surfaces anomalies.
- Metrics are tagged by `invariant_type` and `version` for A/B comparison.
- Dashboards are access-controlled to invariant owners and on-call.

**Testing:**
- Unit: metric emission produces expected series for a synthetic run.
- Integration: dashboard renders metrics for at least one real invariant.
- Integration: drift gauge moves when output distribution shifts.

**Dependencies:** WS-H.1.2a, WS-H.1.2d-2.

---

## WS-H.2 MERI -- Matroid Exposure Rank Invariant

> **Mathematical model (Section 7.2).** For a candidate set `E` and subset `S`, nonredundancy is a matroid `M = (E, I)` whose rank `r(S) = max{ |T| : T subset of S, T in I }` returns the largest nonredundant subset. The invariant is the normalized rank `MERI(S) = r(S) / |S|`, with `0 < MERI(S) <= 1`. Matroid rank is monotone and submodular, so the greedy procedure is exact and the marginal gain `r(S union {x}) - r(S)` is a diminishing-returns ranking feature. Where production must fall back to a general similarity-graph view, MERI is a greedy *approximation* of rank, recorded as such.

### WS-H.2.1a URL/text deduplication
**ID:** WS-H.2.1a
**Ref:** Section 7.5 (steps 1-3), 30.4

**Description:**
Exact URL duplicate detection after canonicalization (from WS-F URL canonicalization). For exact duplicates, marginal exposure gain is 0 -- duplicates do not inflate feed rank. Post-canonicalization URL matching uses normalized scheme, host, path, sorted query parameters, and fragment removal.

**Acceptance criteria:**
- Exact URL duplicates (post-canonicalization) receive marginal exposure gain of 0.
- MERI-1 satisfied: near-identical syndicated articles do not each increase feed rank.
- Canonicalization handles common variations: trailing slashes, www prefix, http/https, query parameter ordering, tracking parameters (utm_*), fragment identifiers.
- Duplicate groups are persisted and queryable for topic-page display.

**Testing:**
- Unit: URL pairs that are duplicates after canonicalization grouped correctly.
- Unit: URL pairs that differ in substantive path are not grouped.
- Integration: submitting a duplicate URL produces marginal gain of 0 in MERI output.

**Dependencies:** WS-H.1.2a, WS-F.1 (URL canonicalization).

---

### WS-H.2.1b Near-duplicate grouping
**ID:** WS-H.2.1b
**Ref:** Section 7.5 (steps 2-3), 30.4

**Description:**
Text similarity via shingling (w-shingling with configurable shingle size) and MinHash for near-duplicate grouping. Near-duplicates (syndicated copies, minor rewrites) receive epsilon marginal exposure gain -- above zero to acknowledge the source exists, but too low to meaningfully increase rank. Group membership is stored and exposed for topic-page lineage display. Embeddings from WS-F.3.2 supply the semantic features used for candidate selection before MinHash.

**Acceptance criteria:**
- Shingling/MinHash pipeline produces similarity scores for candidate pairs.
- Configurable similarity threshold determines near-duplicate grouping (default: Jaccard >= 0.8).
- Near-duplicates receive epsilon gain (configurable, default 0.01).
- Same-claim/same-source-lineage items receive epsilon gain per Section 7.5 pseudo-code.
- Groups are persisted with group IDs for downstream use by topic pages and MERI UI.
- Performance: MinHash computation scales to thousands of candidates per topic.

**Testing:**
- Unit: syndicated copies of the same article (minor editorial changes) are grouped.
- Unit: articles on the same topic with substantially different content are not grouped.
- Integration: near-duplicate group produces epsilon gain in MERI output.
- Performance: grouping 1000 candidates completes within latency budget.

**Dependencies:** WS-H.2.1a, WS-F.3.2 (embeddings).

---

### WS-H.2.2a Independence dimensions
**ID:** WS-H.2.2a
**Ref:** Section 7.4

**Description:**
Implement the six independence dimensions for MERI multi-dimensional independence assessment. Each dimension evaluates whether a candidate exposure adds independent value along that axis.

| Dimension | Independence condition |
|---|---|
| Source lineage | Different publisher ownership, author, wire origin, or primary document. |
| Claim content | Adds a materially distinct claim or question. |
| Evidence base | Uses independent data, witness, document, study, or expert basis. |
| Community origin | Emerges from a distinct community or local context. |
| Semantic framing | Offers a distinct explanatory frame without being misleading. |
| Temporal update | Adds new facts after a meaningful event update. |

**Acceptance criteria:**
- Each dimension implemented as a scored function returning independence signal in `[0, 1]`.
- Source lineage uses publisher ownership data from WS-F source profiles.
- Claim content uses claim extraction from WS-F ingestion pipeline.
- Evidence base uses evidence card and citation data.
- Community origin uses room/lens metadata from WS-G.
- Semantic framing uses embedding similarity with framing-specific features.
- Temporal update uses timestamp comparison against last substantive update.
- Combined independence assessment considers all six dimensions.

**Testing:**
- Unit: each dimension correctly identifies independent vs dependent pairs with labeled test data.
- Unit: combined assessment produces expected independence scores for synthetic scenarios from Section 7.4.
- Integration: independence dimensions feed into partition matroid construction (WS-H.2.2b).

**Dependencies:** WS-H.2.1b, WS-F.1 (source profiles, claim extraction), WS-G.2 (rooms/lenses).

---

### WS-H.2.2b Partition matroid construction
**ID:** WS-H.2.2b
**Ref:** Section 7.5 (steps 3-5), Spec correctness note on matroid model

**Description:**
Construct a partition matroid from the independence dimensions. Partition exposures into classes: near-duplicate class, shared-source-lineage class, shared-primary-evidence class. A subset is independent if it takes at most a bounded number of items from each class (the per-class bound is configurable). The rank equals the number of classes represented, up to the per-class bound. This guarantees that greedy rank computation is exact (matroid property). For the partition matroid the independence oracle is `forall classes c: |S cap c| <= b_c`, and `r(S) = sum_c min(|S cap c|, b_c)`.

**Acceptance criteria:**
- Partition classes constructed from near-duplicate groups (WS-H.2.1b), source lineage groups, and evidence lineage groups.
- Per-class bound is configurable (default: 1 for near-duplicate, 2 for shared-source, 2 for shared-evidence).
- Independence oracle correctly identifies independent subsets under the matroid definition.
- Matroid rank function is monotone and submodular (verified by property tests).
- Partition structure is serializable for debugging and audit.

**Testing:**
- Unit: independence oracle returns correct answers for hand-crafted partition examples.
- Property: rank function satisfies monotonicity and submodularity over random subsets.
- Unit: per-class bounds correctly limit items from each partition class.
- Integration: matroid feeds into greedy rank computation (WS-H.2.2c).

**Dependencies:** WS-H.2.2a.

---

### WS-H.2.2c Greedy rank computation
**ID:** WS-H.2.2c
**Ref:** Section 7.5 (step 6), Spec correctness note

**Description:**
Compute the greedy rank for the candidate set. Because the independence system is a matroid, the greedy algorithm is exact -- it produces the true rank, not an approximation. Marginal rank gain `r(S union {x}) - r(S)` is computed per candidate and used as a ranking feature. The pseudo-code from Section 7.5 is implemented: `duplicate_url` returns 0, `same_claim_same_source_lineage` returns epsilon, `adds_new_evidence_basis` returns high_gain, `adds_new_lens_without_misinformation` returns medium_gain, otherwise returns marginal matroid rank gain.

**Acceptance criteria:**
- Greedy algorithm produces exact rank for partition matroid inputs.
- Marginal rank gain computed per candidate matches the Section 7.5 pseudo-code logic.
- MERI-2 satisfied: a primary document adds more independent exposure value than ten posts quoting one another.
- Marginal gains are recorded in `InvariantOutput.score_vector` (`marginal_gains` map) for downstream ranking.
- Computation completes within latency budget for typical feed sizes (hundreds of candidates).

**Testing:**
- Unit: greedy rank matches hand-computed rank for small matroid examples.
- Unit: primary document vs derivative posts produces expected gain ordering.
- Unit: epsilon gain for same-claim/same-source correctly smaller than high gain for new evidence.
- Performance: 500-candidate feed ranked within 100ms.

**Dependencies:** WS-H.2.2b.

---

### WS-H.2.2d Approximation flagging
**ID:** WS-H.2.2d
**Ref:** Section 7.5 correctness note, Section 21.4

**Description:**
When production must fall back from the matroid model to a general similarity-graph view (because the independence structure does not cleanly partition into a matroid), MERI is reported as a greedy approximation of rank. The approximation flag is recorded in the invariant card and in the per-output metadata. The standard `1 - 1/e` cardinality guarantee and `1/2` matroid-constraint guarantee are documented. The output carries reason code `MATROID_FALLBACK`.

**Acceptance criteria:**
- Outputs from the general similarity-graph fallback include `approximation: true` in `score_vector` and reason code `MATROID_FALLBACK`.
- Invariant card `approximation_notes` documents the fallback and its `1 - 1/e` / `1/2` guarantees.
- Approximation flag is visible in analyst dashboards and ranking decision logs.
- The system prefers the exact matroid path; fallback triggers only when partition construction fails validation.
- MERI-4 satisfied: ranking experiments report MERI distribution before launch (including approximation rate).

**Testing:**
- Unit: matroid construction failure triggers fallback path.
- Unit: fallback output includes approximation flag and reason code.
- Integration: approximation rate is reported in MERI distribution metrics.

**Dependencies:** WS-H.2.2c.

---

### WS-H.2.3a Feed labels
**ID:** WS-H.2.3a
**Ref:** Section 7.6

**Description:**
Feed cards display MERI-derived labels: "New angle," "Independent source," "Duplicate context," or "Same claim, new evidence." Labels are derived from the independence dimensions and marginal gain category. The app never says "this is true because many outlets repeated it" -- repetition is not independence. MERI-5 satisfied: MERI features are explainable in user-facing terms.

**Acceptance criteria:**
- Labels assigned based on marginal gain category: high gain (new evidence) -> "Independent source"; medium gain (new lens) -> "New angle"; epsilon gain (same claim, new source) -> "Same claim, new evidence"; zero gain (duplicate) -> "Duplicate context" (shown only in topic-page lineage, not feed).
- Labels render on feed cards using design system components (WS-B).
- Label text is user-friendly and never implies truth from repetition.
- Labels are accessible (screen reader text, sufficient contrast).

**Testing:**
- Unit: each marginal gain category maps to the correct label.
- Visual: labels render correctly on feed cards.
- Accessibility: labels have aria-label text.
- Content: no label text implies that repetition equals truth.

**Dependencies:** WS-H.2.2c, WS-B.2 (design system).

---

### WS-H.2.3b Independent sources drawer
**ID:** WS-H.2.3b
**Ref:** Section 7.6

**Description:**
Topic pages include an "independent sources" drawer that displays source lineage and evidence lineage for a story. Users can see which sources are independent, which share lineage, and what evidence bases support different claims. MERI-3 satisfied: topic pages expose source lineage and evidence lineage.

**Acceptance criteria:**
- Drawer accessible from topic page via a clearly labeled control.
- Drawer displays sources grouped by independence status (independent, shared-lineage, duplicate).
- Each source shows publisher, evidence type, and independence dimensions that distinguish it.
- Evidence lineage shows which claims are supported by which evidence bases.
- Drawer loads from MERI output data without additional invariant computation.

**Testing:**
- Unit: drawer component renders source groups correctly from mock MERI data.
- Integration: drawer loads MERI data from API and displays current groupings.
- Accessibility: drawer is keyboard-navigable and screen-reader compatible.

**Dependencies:** WS-H.2.2c, WS-B.2.

---

### WS-H.2.3c User preference
**ID:** WS-H.2.3c
**Ref:** Section 7.6

**Description:**
Users can choose "show fewer repeats" or "show all updates" per topic. This preference adjusts the MERI marginal gain threshold used in ranking -- "fewer repeats" raises the threshold (filtering more near-duplicates), "show all" lowers it (showing all updates regardless of redundancy).

**Acceptance criteria:**
- Per-topic preference stored in user settings (from WS-D privacy/personalization settings).
- Default is "balanced" (standard MERI thresholds).
- "Show fewer repeats" raises the marginal gain threshold, reducing near-duplicate visibility.
- "Show all updates" lowers the threshold, showing all updates including near-duplicates.
- Preference persists across sessions and devices.
- Preference is accessible from topic page and feed settings.

**Testing:**
- Unit: preference change adjusts MERI threshold correctly.
- Integration: feed with "fewer repeats" shows fewer near-duplicates than "show all" for the same topic.
- E2E: preference toggle persists and affects subsequent feed loads.

**Dependencies:** WS-H.2.3a, WS-D.1 (user settings).

---

### WS-H.2.4a MERI coverage and confidence
**ID:** WS-H.2.4a
**Ref:** Sections 7.2, 30.4

**Description:**
Define MERI's coverage and confidence semantics. Coverage reflects how many candidates have the inputs needed for independence assessment (canonical URL, claim extraction, source lineage, evidence cards, embeddings). Confidence reflects the reliability of the independence signals (e.g., low when claim extraction is uncertain, when the matroid fallback is used, or when group sizes are small). These envelope fields are populated on every MERI output.

**Acceptance criteria:**
- Coverage = fraction of candidates with all required independence inputs available and fresh.
- Confidence reduced when matroid fallback is used (`MATROID_FALLBACK`), when claim/source data is missing, or when near-duplicate groups are below a size threshold.
- Outputs below `coverage_bounds.min_acceptable` emit `INSUFFICIENT_COVERAGE` and are not used for enforcement.
- Coverage/confidence definitions recorded in the MERI invariant card.

**Testing:**
- Unit: missing claim extraction lowers coverage as documented.
- Unit: matroid fallback lowers confidence and sets the reason code.
- Unit: below-threshold coverage emits `INSUFFICIENT_COVERAGE`.

**Dependencies:** WS-H.2.2d, WS-H.1.1c.

---

## WS-H.3 MFCI -- Markov-Fiber Coordination Invariant

> **Mathematical model (Section 8.2).** Build a contingency table over `user_group x topic x time_bucket x action_type x target`. Fix selected margins (sufficient statistics under a log-linear null). The set of nonnegative integer tables sharing those margins is the **fiber** of the observed table `X`. A Markov basis (Diaconis-Sturmfels) connects every table in the fiber by integer moves that preserve the margins; a Metropolis-Hastings sampler accepts those moves so its stationary distribution is the conditional distribution on the fiber (the generalized hypergeometric induced by the null). Then `MFCI(X) = -log p_hat` with `p_hat = (1 + #{ sampled X' : T(X') >= T(X) }) / (N + 1)` -- the add-one estimator keeps `p_hat > 0` and `MFCI` finite. `T` may measure synchrony, repeated co-action, target concentration, same-phrase repetition, or simultaneous reporting. The sub-minute freeze path (MFCI-3) uses cheap synchrony/target-concentration statistics with precomputed null calibrations; the exact fiber test then confirms or clears.

### WS-H.3.1a Target-concentration score
**ID:** WS-H.3.1a
**Ref:** Section 8.2 latency note, 30.4

**Description:**
Lightweight target-concentration statistic for the sub-minute freeze path. Measures whether actions (reports, replies, shares) are unusually concentrated on a single target relative to a precomputed null distribution. No MCMC -- this is a fast, conservative statistic with precomputed null calibrations. Runs in the real-time tier.

**Acceptance criteria:**
- Target-concentration score computed from action counts per target within a sliding time window.
- Precomputed null calibrations established from historical baseline data.
- Score computation completes within 100ms for real-time use.
- Score is a numeric value with higher values indicating more unusual concentration.
- Null calibrations are versioned and updated on a configurable schedule (default: daily).
- Output includes confidence based on the amount of baseline data available; stale calibrations emit `NULL_CALIBRATION_STALE`.

**Testing:**
- Unit: known concentrated action pattern produces high score.
- Unit: diffuse action pattern produces low score.
- Unit: score computation meets latency target.
- Integration: null calibrations load correctly and version-match.

**Dependencies:** WS-H.1.2a, WS-E (event pipeline).

---

### WS-H.3.1b Synchrony score
**ID:** WS-H.3.1b
**Ref:** Section 8.2 latency note, 30.4

**Description:**
Lightweight synchrony statistic detecting sub-minute timing coordination. Measures whether actions from different users arrive in unusually tight temporal clusters relative to a precomputed null. This complements target-concentration by detecting timing patterns rather than target patterns.

**Acceptance criteria:**
- Synchrony score computed from inter-arrival times of actions within a sliding window.
- Precomputed null calibrations based on historical inter-arrival time distributions.
- Score computation completes within 100ms.
- High synchrony (many actions within seconds) produces high score; organic arrival patterns produce low score.
- Score is robust to timezone and activity-level variations (conditioned on base rate).

**Testing:**
- Unit: simulated bot-like simultaneous actions produce high synchrony score.
- Unit: simulated organic arrival times produce low synchrony score.
- Unit: base-rate conditioning prevents false positives for active communities.

**Dependencies:** WS-H.3.1a.

---

### WS-H.3.1c Shadow reporting dashboard
**ID:** WS-H.3.1c
**Ref:** Section 30.4

**Description:**
Dashboard for analysts showing MFCI v0 shadow anomaly reports. Displays target-concentration and synchrony scores over time, flagged anomalies, and the precomputed null baselines. No enforcement actions in shadow mode -- dashboard is observational only.

**Acceptance criteria:**
- Dashboard shows real-time and historical target-concentration and synchrony scores.
- Anomalies (scores exceeding configurable thresholds) are visually highlighted.
- Null baselines displayed alongside observed scores for context.
- Dashboard includes filters by target type, time range, and anomaly severity.
- Access restricted to integrity analysts (role-based access control).
- No enforcement buttons or actions -- shadow mode is observation only.

**Testing:**
- Integration: dashboard loads and displays mock anomaly data.
- Integration: access control enforced -- non-analyst users cannot access.
- Visual: anomaly highlighting is clear and distinguishable.

**Dependencies:** WS-H.3.1a, WS-H.3.1b.

---

### WS-H.3.2a Contingency table construction
**ID:** WS-H.3.2a
**Ref:** Section 8.2

**Description:**
Construct the full contingency table over dimensions: user_group x topic x time_bucket x action_type x target. Each cell counts the number of actions matching that dimension combination. This is the observed table `X` used in the fiber test.

**Acceptance criteria:**
- Contingency table constructed from event data within a specified time window.
- Dimensions are configurable: user_group (cohort membership), topic (from story/thread classification), time_bucket (configurable granularity), action_type (report, reply, share, view, etc.), target (story_id or thread_id).
- Table is sparse-represented for efficiency (most cells are zero).
- Table construction scales to millions of events within the batch computation budget.
- Output includes the table and its dimension metadata for downstream margin computation.

**Testing:**
- Unit: known event set produces expected contingency table.
- Unit: sparse representation correctly handles high-dimensional tables.
- Performance: table construction from 1M events completes within batch budget.

**Dependencies:** WS-H.1.2a, WS-E (event pipeline).

---

### WS-H.3.2b Fixed-margin computation
**ID:** WS-H.3.2b
**Ref:** Section 8.2

**Description:**
Compute fixed margins from the contingency table: total activity per group, per topic, per time bucket, per action type, and expected baseline target popularity. These margins are the sufficient statistics under the log-linear null model. Margins are preserved by the Markov-basis moves and define the fiber.

**Acceptance criteria:**
- All marginal sums computed correctly from the contingency table.
- Margins include: row sums (per user_group), column sums (per topic, per time_bucket, per action_type), and target-popularity marginals.
- MFCI-1 satisfied: large normal communities are not penalized solely for volume (their base-rate margins are conditioned on).
- MFCI-4 satisfied: every automated coordination action logs fixed margins and the statistic used.
- Margins are persisted alongside contingency tables for audit (`fixed_margins_ref` in score_vector).

**Testing:**
- Unit: margin sums match expected values for hand-crafted tables.
- Unit: margins correctly capture group size, topic popularity, and temporal patterns.
- Integration: margins feed into Markov-basis fiber test (WS-H.3.3a).

**Dependencies:** WS-H.3.2a.

---

### WS-H.3.2c Analyst dashboard with baselines
**ID:** WS-H.3.2c
**Ref:** Section 8.2

**Description:**
Analyst dashboard showing contingency tables, preserved margins, and baseline comparisons. Analysts can inspect which margins are conditioned on and see how the observed table compares to the expected distribution under the null model. Extends the shadow reporting dashboard (WS-H.3.1c) with full contingency-table visibility.

**Acceptance criteria:**
- Dashboard displays contingency table dimensions and cell values.
- Margins shown alongside observed values for each dimension.
- Baseline (expected under null) shown for comparison.
- Cells deviating significantly from baseline are visually highlighted.
- Dashboard supports drill-down by dimension (e.g., view one user_group across all topics).
- Access restricted to integrity analysts.

**Testing:**
- Integration: dashboard loads contingency table and margin data correctly.
- Visual: baseline comparison is clear and interpretable.
- Integration: drill-down navigation works across all dimensions.

**Dependencies:** WS-H.3.2b, WS-H.3.1c.

---

### WS-H.3.3a Markov-basis generation
**ID:** WS-H.3.3a
**Ref:** Section 8.2 (Diaconis-Sturmfels)

**Description:**
Generate a Markov basis for the fiber of the observed contingency table. The Markov basis (Diaconis-Sturmfels theorem) consists of integer moves that preserve all fixed margins and connect every table in the fiber. The basis enables the Metropolis-Hastings sampler to explore the full conditional distribution.

**Acceptance criteria:**
- Markov-basis generator produces a set of integer moves for a given margin structure.
- Every move preserves all fixed margins when applied to any table in the fiber.
- Basis is connected: any two tables sharing the same margins can be reached by a sequence of basis moves.
- Generator handles the production dimension structure (5-way contingency tables).
- Basis is cached and reused for the same margin structure.
- Computation is a batch operation (not required in real-time).

**Testing:**
- Unit: generated moves preserve margins when applied to test tables.
- Unit: basis connectivity verified on small tables (brute-force enumeration of fiber).
- Integration: basis feeds into Metropolis-Hastings sampler (WS-H.3.3b).

**Dependencies:** WS-H.3.2b.

---

### WS-H.3.3b Metropolis-Hastings sampler
**ID:** WS-H.3.3b
**Ref:** Section 8.2

**Description:**
Metropolis-Hastings sampler over the conditional fiber distribution. Proposes moves from the Markov basis, accepts them so that the stationary distribution is the conditional distribution given the fixed margins (under the log-linear null model). The sampler produces `N` samples from the fiber for p-value estimation.

**Acceptance criteria:**
- Sampler uses Markov-basis moves as proposals.
- Acceptance probability computed from the log-linear null model (generalized hypergeometric).
- Stationary distribution is the conditional distribution on the fiber given fixed margins.
- Sampler produces configurable `N` samples (default: 10,000).
- All sampled tables have nonnegative integer entries and share the fixed margins.
- Burn-in period is configurable; thinning is applied to reduce autocorrelation.
- Sampler diagnostics (acceptance rate, effective sample size) are logged; non-convergence emits `SAMPLER_NONCONVERGENCE`.

**Testing:**
- Unit: all sampled tables preserve fixed margins.
- Unit: sampled tables have nonnegative integer entries.
- Unit: acceptance rate is within a reasonable range (neither too high nor too low).
- Statistical: on synthetic data with known distribution, sampler estimates match known statistics.

**Dependencies:** WS-H.3.3a.

---

### WS-H.3.3c P-value computation
**ID:** WS-H.3.3c
**Ref:** Section 8.2

**Description:**
Compute the one-sided conditional p-value and MFCI score. For coordination statistic `T` and `N` sampled tables: `p_hat = (1 + #{sampled X' : T(X') >= T(X)}) / (N + 1)`. `MFCI = -log p_hat`. The add-one estimator ensures `p_hat > 0` always and `MFCI` is finite even when no sampled table is as extreme as the observed table. `T` may measure synchrony, repeated co-action, target concentration, same-phrase repetition, or simultaneous reporting.

**Acceptance criteria:**
- P-value computed using the add-one estimator formula exactly as specified.
- `p_hat` is always positive; `MFCI` is always finite.
- Multiple coordination statistics `T` are supported (synchrony, target-concentration, phrase-repetition).
- MFCI score stored in `InvariantOutput.score_vector` with the statistic used, p-value, and sample count.
- Higher MFCI means stronger evidence of coordination beyond conditioned base rates.
- Confidence reduced and `SAMPLER_NONCONVERGENCE` set when effective sample size is below threshold.

**Testing:**
- Unit: add-one estimator produces correct p-value for known sampled exceedance counts.
- Unit: MFCI is finite for all valid inputs including zero exceedances.
- Unit: MFCI ordering is correct (more extreme observations produce higher scores).
- Integration: full pipeline from contingency table through sampling to MFCI score.

**Dependencies:** WS-H.3.3b.

---

### WS-H.3.3d Cheap-statistics freeze integration
**ID:** WS-H.3.3d
**Ref:** Section 8.2 latency note, 8.5

**Description:**
Integrate the cheap synchrony and target-concentration statistics (WS-H.3.1a, WS-H.3.1b) with the full fiber test (WS-H.3.3c). The cheap statistics drive the sub-minute freeze; the exact fiber test then confirms or clears the freeze and feeds the analyst case. When the fiber test clears a freeze, the freeze is lifted automatically. When the fiber test confirms, the case is escalated per risk-state rules.

**Acceptance criteria:**
- Cheap-statistics freeze triggers the full fiber test as a follow-up batch computation.
- Fiber test result either confirms (escalates) or clears (lifts) the freeze.
- MFCI-3 satisfied: severe synchronization freezes trend acceleration within one minute (via cheap statistics).
- Confirmation/clearing is logged with both the cheap statistic and fiber test results.
- Time from freeze to fiber test result is tracked and reported.

**Testing:**
- Integration: cheap-statistics freeze triggers fiber test computation.
- Integration: fiber test clearing lifts the freeze.
- Integration: fiber test confirmation escalates per risk-state rules.
- Unit: freeze-to-resolution time tracking is accurate.

**Dependencies:** WS-H.3.1a, WS-H.3.1b, WS-H.3.3c.

---

### WS-H.3.3e Adversarial-adaptation tests
**ID:** WS-H.3.3e
**Ref:** Section 30.4 (MFCI v2 gate)

**Description:**
MFCI v2 requires adversarial-adaptation testing: synthetic adversaries that attempt to evade the fiber test by spreading actions across targets, jittering timing to defeat the synchrony statistic, rotating phrasing, or staying just under thresholds. The suite measures detection rate and false-negative rate against an evolving red-team strategy set, and feeds findings back into statistic selection and threshold calibration. This is the gate evidence that MFCI flags coordination conditional on base rates without treating normal activity as abuse.

**Acceptance criteria:**
- A library of adversarial strategies (timing jitter, target spreading, phrase rotation, threshold hugging) generates synthetic coordinated campaigns.
- The suite reports detection rate, false-negative rate, and the statistic that caught each campaign.
- Adversarial cases are versioned; new evasion strategies are added as discovered.
- The suite runs as part of the MFCI v2 promotion evidence (WS-H.1.2e) and nightly thereafter.
- Findings are summarized for the integrity owner with recommended threshold/statistic changes.

**Testing:**
- Unit: each adversarial strategy generates a campaign with the intended evasion property.
- Statistical: detection rate for known-coordinated campaigns exceeds the documented floor.
- Statistical: organic control campaigns are not flagged (false-positive rate below ceiling).
- Regression: adding a new evasion strategy is reflected in the suite report.

**Dependencies:** WS-H.3.3c, WS-H.1.2d.

---

### WS-H.3.4a Risk states
**ID:** WS-H.3.4a
**Ref:** Section 8.5

**Description:**
Implement MFCI risk states with associated ranking and moderator effects.

| State | Ranking effect | Moderator effect |
|---|---|---|
| Normal | No penalty. | None. |
| Elevated | Distribution dampening. | Add to passive monitoring. |
| High | Freeze trend acceleration. | Review queue. |
| Severe | Limit cross-community spread. | Immediate safety/integrity review. |

**Acceptance criteria:**
- Risk state derived from MFCI score thresholds (configurable per target type).
- State transitions logged with MFCI score, statistic used, and margins.
- Each state triggers the correct ranking and moderation effects.
- State is stored per target (`risk_state` in score_vector) and updated as MFCI scores change.
- Downward transitions (e.g., high -> normal) require either fiber test clearing or analyst override.
- While MFCI is in shadow, risk states are computed and logged but produce no ranking/moderation effect (enforced by WS-H.1.2e).

**Testing:**
- Unit: MFCI score thresholds produce correct risk states.
- Unit: each risk state triggers correct ranking effects (when promoted).
- Integration: state transitions logged correctly with full context.
- Integration: downward transition requires clearing or override.

**Dependencies:** WS-H.3.3c.

---

### WS-H.3.4a-2 Risk-state ranking and moderation effects
**ID:** WS-H.3.4a-2
**Ref:** Section 8.5

**Description:**
Implement the concrete ranking and moderation effects attached to each risk state, separated from state derivation so each effect is independently reviewable and reversible: Elevated -> distribution dampening; High -> freeze trend acceleration + review-queue entry; Severe -> limit cross-community spread + immediate review. Each effect is gated by the promotion mechanism and is individually kill-switchable.

**Acceptance criteria:**
- Distribution dampening (Elevated) reduces amplification by a configurable factor.
- Freeze trend acceleration (High) halts velocity-based promotion for the target.
- Cross-community spread limit (Severe) restricts amplification beyond origin communities until reviewed.
- Each effect is independently feature-flagged and reversible.
- Effects apply only when MFCI `shadow_status` is a constraint mode.
- MFCI-2 supported: coordinated reporting has delayed enforcement impact (effects pair with the review queue, WS-H.3.4b).

**Testing:**
- Unit: each effect modifies ranking/distribution as documented when enabled.
- Unit: each effect is a no-op when disabled or while in shadow.
- Integration: severe state limits cross-community spread in a simulated feed.

**Dependencies:** WS-H.3.4a, WS-H.1.2e.

---

### WS-H.3.4b Analyst review queue
**ID:** WS-H.3.4b
**Ref:** Section 8.5

**Description:**
Review queue for integrity analysts showing MFCI cases at high or severe risk states. Each case includes a human-readable summary of the coordination rationale: the coordination statistic used, the conditioned margins, the MFCI score, the observed vs expected distribution, and the affected targets.

**Acceptance criteria:**
- Queue shows all cases at high or severe risk state, ordered by severity and recency.
- Each case includes: coordination statistic, fixed margins, MFCI score, p-value, observed table summary, affected targets.
- Human-readable summary generated from the statistical evidence (not raw numbers alone).
- Analysts can mark cases as confirmed, cleared, or escalated.
- MFCI-2 satisfied: coordinated reporting has delayed enforcement impact until reviewed.
- Queue integrates with the moderation system (WS-J trust and safety).

**Testing:**
- Integration: cases appear in queue when risk state reaches high or severe.
- Integration: analyst actions (confirm, clear, escalate) update risk state and freeze status.
- Visual: case summaries are readable and include all required information.

**Dependencies:** WS-H.3.4a, WS-J (trust and safety queues).

---

### WS-H.3.4c Appeal support
**ID:** WS-H.3.4c
**Ref:** Section 8.7

**Description:**
Users affected by MFCI-driven enforcement can inspect a human-readable summary of the coordination rationale through the appeals process. The summary explains what statistical pattern was detected and what margins were conditioned on, without exposing raw user data or compromising the integrity system.

**Acceptance criteria:**
- MFCI-5 satisfied: appeals can inspect a human-readable summary of coordination rationale.
- Summary includes: what type of coordination was detected (timing, target concentration, phrase repetition), what normal behavior was conditioned on (group size, topic popularity, time patterns), and why the observed behavior was unusual.
- Summary does not expose other users' identities, raw action logs, or details that could help evade detection.
- Appeal flow integrates with the existing appeals system (WS-J).
- Appeal outcome is logged with the MFCI case.

**Testing:**
- Unit: summary generation produces readable text from MFCI case data.
- Unit: summary does not contain user identifiers or raw logs.
- Integration: appeal creates a linked record in the MFCI case and moderation system.

**Dependencies:** WS-H.3.4b, WS-J (appeals system).

---

## WS-H.4 SCOI -- Sheaf Context Obstruction Invariant

> **Mathematical model (Section 10.2).** Communities/lenses are cells of a cellular sheaf over the nerve of their overlaps. Each lens `U_i` carries a stalk and a local interpretation `s_i` (semantic summary, stance, assumed background as a vector); `s = (s_i)` is a 0-cochain. On each overlap, restriction maps give the coboundary `(d0 s)_ij = rho_i(s_i) - rho_j(s_j)`. The score is the **normalized Dirichlet energy** under the sheaf Laplacian `L0 = d0^T d0`: `SCOI = (s^T L0 s) / normalizer = (sum over overlaps ij of || rho_i(s_i) - rho_j(s_j) ||^2) / normalizer`, normalized to `[0, 1]`. `SCOI = 0` iff the local readings glue into a global section (`s in ker d0`). The genuinely cohomological obstruction (nontrivial `H1`) is the target of SCOI v2.

### WS-H.4.1a Lens interpretation capture
**ID:** WS-H.4.1a
**Ref:** Section 10.2, 30.4

**Description:**
Capture community interpretations per lens per story. Each lens `U_i` carries a stalk (a vector space of admissible interpretations) and a local interpretation `s_i` -- a semantic summary, stance distribution, assumed background, or local norm encoded as a vector. Interpretations are derived from community discussions, lens-specific summaries, and steward annotations from WS-G.

**Acceptance criteria:**
- Interpretation vectors computed per lens per story from community discussion data.
- Interpretations encode semantic summary, stance distribution, and assumed context as vectors.
- Interpretation capture runs as a batch process with configurable update frequency.
- Interpretations are versioned and timestamped.
- Coverage metric reflects how many lenses have sufficient discussion data for interpretation capture.

**Testing:**
- Unit: interpretation capture produces valid vectors from mock discussion data.
- Unit: multiple lenses produce distinct interpretation vectors for a story with divergent community readings.
- Integration: interpretations feed into disagreement scoring (WS-H.4.1b).

**Dependencies:** WS-H.1.2a, WS-G.2.2 (lens definitions).

---

### WS-H.4.1b Disagreement scoring and context states
**ID:** WS-H.4.1b
**Ref:** Section 10.4, 30.4

**Description:**
Score disagreement between lens interpretations and assign context states. States represent the degree of context collapse.

| State | Meaning | Product action |
|---|---|---|
| Coherent | Local interpretations mostly agree. | Normal distribution. |
| Ambiguous | Some missing background. | Add context-card prompt. |
| Split | Communities read the item differently. | Show lens map before commenting. |
| Obstructed | Interpretations cannot be reconciled without extra context. | Slow cross-community spread; request bridge/synthesis. |
| Weaponized | Ambiguity is used to inflame conflict. | Review and apply safety constraints. |

**Acceptance criteria:**
- Disagreement score computed from pairwise comparison of lens interpretations.
- Context states assigned based on disagreement score thresholds (configurable).
- State assignment is deterministic for the same set of interpretations.
- "Weaponized" state requires both high disagreement and safety classifier signals (not disagreement alone).
- Steward reports show context state and contributing lens disagreements.

**Testing:**
- Unit: known interpretation vectors produce expected disagreement scores and context states.
- Unit: "weaponized" state requires safety signal in addition to high disagreement.
- Integration: context states feed into SCOI UI (WS-H.4.3a) and ranking integration.

**Dependencies:** WS-H.4.1a.

---

### WS-H.4.1c Steward reports
**ID:** WS-H.4.1c
**Ref:** Section 10.4, 30.4

**Description:**
Generate reports for room stewards showing SCOI context state, interpretation differences across lenses, and recommended actions. Reports help stewards understand where context is collapsing and what bridge contributions could help.

**Acceptance criteria:**
- Reports show context state, disagreement score, and per-lens interpretation summaries.
- Recommended actions based on context state (e.g., "invite bridge comment" for split/obstructed).
- Reports accessible to stewards of rooms involved in the overlap.
- Reports update as interpretations and context state change.
- Access control ensures stewards see only reports relevant to their rooms.

**Testing:**
- Integration: reports generated and accessible for stories with elevated SCOI.
- Integration: access control restricts reports to relevant stewards.
- Visual: reports are readable and include actionable recommendations.

**Dependencies:** WS-H.4.1b, WS-G.2.3 (steward roles).

---

### WS-H.4.2a Restriction maps
**ID:** WS-H.4.2a
**Ref:** Section 10.2

**Description:**
Define restriction maps between overlapping communities. For each overlap `U_i cap U_j`, restriction maps `rho_i` and `rho_j` carry the local interpretations `s_i` and `s_j` into a shared comparison space. The maps encode how interpretations from different communities should be compared -- accounting for different vocabulary, norms, and assumed context. The overlap structure is the nerve of community overlaps, computed from room/lens membership.

**Acceptance criteria:**
- Restriction maps defined for all pairs of overlapping lenses/communities on a given story.
- Maps project local interpretation vectors into a shared comparison space.
- Maps are learned or configured per community-pair overlap (not a single global projection).
- Maps are versioned and auditable.
- Overlap structure (nerve of community overlaps) is computed from room/lens membership data.

**Testing:**
- Unit: restriction maps correctly project interpretation vectors into shared space.
- Unit: identity-like maps produce zero disagreement for identical interpretations.
- Integration: restriction maps feed into coboundary operator (WS-H.4.2b).

**Dependencies:** WS-H.4.1a.

---

### WS-H.4.2b Coboundary operator and sheaf Laplacian
**ID:** WS-H.4.2b
**Ref:** Section 10.2

**Description:**
Implement the coboundary operator `d0` and sheaf Laplacian `L0 = d0^T d0`. On each overlap `U_i cap U_j`, the coboundary is `(d0 s)_ij = rho_i(s_i) - rho_j(s_j)`. The sheaf Laplacian enables computation of the Dirichlet energy measuring context collapse.

**Acceptance criteria:**
- Coboundary operator `d0` correctly computes the disagreement on each overlap.
- Sheaf Laplacian `L0 = d0^T d0` is a positive semi-definite matrix.
- Implementation handles the sparse structure of typical overlap graphs efficiently.
- Computation scales to dozens of overlapping communities per story.
- Operator matrices are stored for reuse across Dirichlet energy queries.

**Testing:**
- Unit: `d0` produces expected disagreement vectors for hand-crafted examples.
- Unit: `L0` is positive semi-definite (eigenvalues >= 0).
- Unit: zero disagreement (coherent interpretations) produces `d0 s = 0` and `s^T L0 s = 0`.
- Performance: computation for 20 overlapping communities completes within batch budget.

**Dependencies:** WS-H.4.2a.

---

### WS-H.4.2c Normalized Dirichlet energy (SCOI score)
**ID:** WS-H.4.2c
**Ref:** Section 10.2

**Description:**
Compute the normalized Dirichlet energy: `SCOI(content) = (s^T L0 s) / normalizer`, normalized to `[0, 1]` by the energy of a maximally-disagreeing configuration on the same overlap graph. `SCOI = 0` means the local interpretations already agree on all overlaps and glue into a global section; higher SCOI means the local readings cannot be reconciled without added context. Equivalently, SCOI is the squared distance of `s` from `H0 = ker d0`.

**Acceptance criteria:**
- SCOI score normalized to `[0, 1]`.
- `SCOI = 0` when all local interpretations agree on overlaps (kernel of `d0`).
- Normalizer computed from the maximally-disagreeing configuration on the same overlap graph.
- Score stored in `InvariantOutput.score_vector` with overlap graph size, lens count, and normalizer value.
- SCOI-5 satisfied: SCOI features are validated against human-labeled context-collapse cases.

**Testing:**
- Unit: coherent interpretations produce SCOI = 0.
- Unit: maximally disagreeing interpretations produce SCOI = 1.
- Unit: intermediate disagreement produces SCOI in (0, 1).
- Validation: scores correlate with human-labeled context-collapse cases.

**Dependencies:** WS-H.4.2b.

---

### WS-H.4.2d Bridge/context routing
**ID:** WS-H.4.2d
**Ref:** Section 10.3, 10.5

**Description:**
When SCOI is elevated, route bridge requests and context invitations to users who participate in multiple overlapping communities. Bridge comments that reduce SCOI (measured by re-computation after the contribution) receive participation credit. SCOI-2 satisfied: bridge comments receive participation credit when obstruction decreases.

**Acceptance criteria:**
- Bridge request routing identifies users active in overlapping communities.
- Bridge contributions trigger SCOI re-computation; decrease in SCOI is measured.
- Participation credit awarded for bridge contributions that reduce SCOI.
- Routing respects user notification preferences and does not spam.
- Bridge requests are logged for audit and steward visibility.

**Testing:**
- Unit: bridge candidate identification correctly finds multi-community users.
- Integration: bridge contribution triggers SCOI re-computation.
- Integration: SCOI decrease results in participation credit.

**Dependencies:** WS-H.4.2c, WS-G.1 (contribution system).

---

### WS-H.4.2e SCOI ranking integration
**ID:** WS-H.4.2e
**Ref:** Section 10.6

**Description:**
Wire SCOI levels into ranking actions per Section 10.6: Low -> normal ranking; Medium -> require context card in feed; High -> reduce cross-community amplification until context improves; Very high -> prioritize bridge requests, expert context, or moderator review. High SCOI never means "bad content" -- it means the content should travel with context. Effects are gated by the promotion mechanism and individually reversible.

**Acceptance criteria:**
- SCOI-to-ranking-action mapping implemented per the four levels in Section 10.6.
- Medium triggers a required context card in feed (pairs with WS-H.4.3a/WS-H.4.3b).
- High reduces cross-community amplification until context improves (re-evaluated on re-computation).
- Very high prioritizes bridge/expert/moderator routing rather than suppression.
- Effects apply only when SCOI `shadow_status` is a constraint mode; each level is individually feature-flagged.
- SCOI-1 supported: cross-community distribution includes context when SCOI is elevated.

**Testing:**
- Unit: each SCOI level maps to the documented ranking action.
- Unit: effects are no-ops while in shadow.
- Integration: high SCOI reduces cross-community amplification in a simulated feed; dropping below threshold restores it.

**Dependencies:** WS-H.4.2c, WS-H.1.2e.

---

### WS-H.4.2f Cohomological obstruction (SCOI v2)
**ID:** WS-H.4.2f
**Ref:** Section 10.2 correctness note, 30.4 (SCOI v2)

**Description:**
SCOI v2 targets the structural, genuinely cohomological obstruction. The Dirichlet-energy score (v1) measures the magnitude of a coboundary for a given set of readings; a structural obstruction arises only when the restriction maps admit no consistent global gluing for any choice of local readings -- i.e., when the first sheaf cohomology `H1` of the overlap diagram is nontrivial. Compute the obstruction class and summarize persistent cross-community interpretation failures by the norm of the harmonic representative (the Hodge-minimal cochain) of the nontrivial class. This is a research-grade, batch-only diagnostic that complements (does not replace) v1.

**Acceptance criteria:**
- Compute `H1` of the overlap diagram from the restriction maps (structural, independent of a specific `s`).
- When `H1` is nontrivial, compute the harmonic representative and report its norm as the structural-obstruction summary.
- Output distinguishes "high energy for these readings" (v1) from "structural obstruction for any readings" (v2) via reason codes.
- v2 runs batch-only and is clearly marked as a diagnostic; it does not by itself drive enforcement until promoted.
- Approximation/limits documented in the invariant card.

**Testing:**
- Unit: overlap diagram with trivial `H1` reports no structural obstruction.
- Unit: hand-constructed diagram with nontrivial `H1` yields a nonzero harmonic-representative norm.
- Unit: v1 and v2 outputs are distinguished by reason code and score_vector fields.

**Dependencies:** WS-H.4.2c.

---

### WS-H.4.3a "Needs Context" label
**ID:** WS-H.4.3a
**Ref:** Section 10.5

**Description:**
Feed-card label "Needs Context" displayed when SCOI is elevated. This label means interpretations differ across communities -- it never means the content is false, bad, or banned. SCOI-1 satisfied: cross-community distribution includes context when SCOI is elevated.

**Acceptance criteria:**
- "Needs Context" label displayed on feed cards when SCOI exceeds configurable threshold.
- Label text and tooltip explicitly communicate that it means "interpretations differ," not "false" or "banned."
- Label uses design system components and passes accessibility checks.
- Threshold is configurable per content type and adjustable by operations.
- Label display is logged for audit.

**Testing:**
- Unit: label appears when SCOI exceeds threshold; absent when below.
- Accessibility: label has appropriate aria attributes and tooltip.
- Content: label text does not imply falsity or prohibition.

**Dependencies:** WS-H.4.1b, WS-B.2 (design system).

---

### WS-H.4.3b "Where interpretations differ" section
**ID:** WS-H.4.3b
**Ref:** Section 10.5

**Description:**
Context-card section showing "Where interpretations differ" for stories with elevated SCOI. Displays the lens interpretations that disagree, in plain language. SCOI-3 satisfied: users can inspect major interpretation differences in plain language.

**Acceptance criteria:**
- Section shows which communities/lenses disagree and a plain-language summary of each interpretation.
- Summaries are generated from interpretation vectors, not raw technical data.
- Section accessible from the "Needs Context" label or context card.
- Section updates as interpretations change.
- No lens interpretation is presented as "correct" or "incorrect."

**Testing:**
- Unit: section renders correctly from mock SCOI data.
- Integration: section shows current interpretation summaries from live SCOI data.
- Content: no framing implies one interpretation is correct.

**Dependencies:** WS-H.4.2c, WS-B.2.

---

### WS-H.4.3c Composer warning
**ID:** WS-H.4.3c
**Ref:** Section 10.5

**Description:**
Composer warning when a user is replying to content with elevated SCOI: "People in another room are reading this differently. Add context before replying." Also, share dialog: "This item is context-sensitive. Include origin context?"

**Acceptance criteria:**
- Warning displayed in composer when SCOI of the target content exceeds threshold.
- Warning text is informative, not accusatory.
- Warning is dismissible (user can proceed without adding context).
- Share dialog includes origin-context prompt for context-sensitive items.
- Warning uses design system components and passes accessibility checks.

**Testing:**
- Unit: warning appears in composer when SCOI exceeds threshold.
- Unit: warning absent when SCOI is below threshold.
- E2E: user can dismiss warning and proceed.
- Accessibility: warning is announced by screen readers.

**Dependencies:** WS-H.4.1b, WS-B.2, WS-G.3 (composer).

---

### WS-H.4.3d Moderator context-state tools
**ID:** WS-H.4.3d
**Ref:** Section 10.5, 10.7 (SCOI-4)

**Description:**
Moderator tools to act on context state: merge threads that are fragments of one conversation, annotate a thread with context, or separate threads whose communities are reading an item incompatibly. These tools satisfy SCOI-4, which was otherwise uncovered. Actions are recorded with reason codes, are appealable per moderation policy, and feed SCOI re-computation (e.g., adding an annotation can reduce obstruction). Tools surface the "Bridge attempts" thread branch from Section 10.5.

**Acceptance criteria:**
- SCOI-4 satisfied: moderators can merge, annotate, or separate threads based on context state.
- Merge/annotate/separate actions are available from the steward report and the thread-health surface.
- Each action records actor, reason code, affected threads, and timestamp (audit + appealable per WS-J).
- "Bridge attempts" branch is shown for split/obstructed threads.
- Annotation/merge triggers SCOI re-computation; resulting change is reflected in context state.
- Actions respect steward scope (only on rooms/threads the moderator governs).

**Testing:**
- Unit: merge/annotate/separate produce the expected thread structure changes.
- Unit: each action writes an audit record with reason code.
- Integration: annotation reduces SCOI on re-computation in a synthetic split case.
- Integration: action permissions enforced by steward scope.

**Dependencies:** WS-H.4.1b, WS-G.1 (thread structure), WS-J (moderation actions/appeals).

---

## WS-H.5 GWEI -- Gromov-Wasserstein Experience Isometry

> **Mathematical model (Section 9.2).** For cohort `A`, build a metric-measure space `(X_A, d_A, mu_A)`: items shown, a pairwise pseudometric over semantic/source/evidence/community relations, and a normalized measure. The order-2 Gromov-Wasserstein distance `GWEI(A,B) = GW_2((X_A,d_A,mu_A),(X_B,d_B,mu_B)) = (inf over pi in Pi(mu_A,mu_B) sum_{i,j,k,l} |d_A(i,k) - d_B(j,l)|^2 pi(i,j) pi(k,l))^{1/2}` compares relational structure without requiring identical items. `GWEI = 0` iff the experiences are measure-preserving isometric. Exact GW is NP-hard, so production uses sampled cohort windows and **entropic-regularized** GW with seed- and regularization-stability reporting and a confidence interval.

### WS-H.5.1a Cohort definitions
**ID:** WS-H.5.1a
**Ref:** Section 9.4, 30.4

**Description:**
Define cohort categories for GWEI comparison: language, region, age band, new vs established users. Cohort membership is derived from user metadata (locale, registration date, age band if known) without inferring sensitive attributes unnecessarily. Cohort definitions are configurable and auditable.

**Acceptance criteria:**
- Cohort categories defined: language (primary locale), region (geographic), age band (if known; never inferred), new vs established (based on registration date threshold).
- Cohort membership computation is deterministic and reproducible.
- Cohort definitions are version-controlled and auditable.
- No sensitive attribute inference beyond what users provide.
- Cohorts are large enough for meaningful comparison (minimum cohort size threshold).

**Testing:**
- Unit: cohort assignment produces expected memberships from mock user data.
- Unit: users with unknown age band are not assigned to age-based cohorts.
- Unit: minimum cohort size threshold enforced.

**Dependencies:** WS-H.1.2a, WS-D.1 (user metadata).

---

### WS-H.5.1b Experience metrics
**ID:** WS-H.5.1b
**Ref:** Section 9.4

**Description:**
Define experience metrics per cohort per Section 9.4: source diversity, topic diversity, evidence access (probability of seeing primary sources/evidence cards), discussion depth, viewpoint geometry (relational spread of lenses and claims), novelty (balance of familiar and unfamiliar-but-relevant material), and safety state (exposure to harassment, misinformation, manipulation, or graphic content).

**Acceptance criteria:**
- Each of the 7 experience metrics computed per cohort over a configurable time window.
- Metrics are numeric and comparable across cohorts.
- Source diversity and topic diversity measured as entropy or effective number.
- Evidence access measured as the fraction of feed items with accessible primary sources.
- Safety state measured as the fraction of feed items with elevated safety signals.
- Metrics are privacy-preserving -- computed from aggregate data, not individual user histories.

**Testing:**
- Unit: each metric produces expected values from mock cohort data.
- Unit: metrics are within expected ranges (e.g., diversity between 0 and max entropy).
- Integration: metrics feed into GWEI dashboards (WS-H.5.1c) and GW computation (WS-H.5.2a).

**Dependencies:** WS-H.5.1a, WS-E (event pipeline for attention data).

---

### WS-H.5.1b-2 Experience-metric privacy and k-anonymity
**ID:** WS-H.5.1b-2
**Ref:** Sections 9.6, 9.7

**Description:**
Enforce privacy thresholds on cohort experience metrics so no metric can be traced to a small group or individual. Metrics are suppressed or coarsened when a cohort (or a cell within a cohort breakdown) falls below a k-anonymity threshold. This is the privacy backbone that lets GWEI dashboards and transparency reports exist without exposing sensitive cohort details.

**Acceptance criteria:**
- Metrics for cohorts/cells below a configurable k-anonymity threshold are suppressed or coarsened (not displayed raw).
- Suppression is recorded with a reason code so downstream consumers know a value is withheld, not zero.
- Small cohorts are protected (Section 30.4 GWEI gate): they are never degraded below threshold without review, and their metrics are not over-exposed.
- Privacy thresholds are version-controlled and auditable.

**Testing:**
- Unit: below-threshold cohort metric is suppressed/coarsened.
- Unit: suppression is distinguishable from a true-zero value.
- Integration: dashboard and transparency export both honor suppression.

**Dependencies:** WS-H.5.1b.

---

### WS-H.5.1c Privacy-protected dashboards
**ID:** WS-H.5.1c
**Ref:** Section 9.6, 9.7

**Description:**
GWEI dashboards showing cohort experience comparisons. Dashboards are privacy-protected and access-controlled -- they show aggregate metrics, not individual user data. GWEI-4 satisfied: GWEI dashboards are privacy-protected and access-controlled.

**Acceptance criteria:**
- Dashboards display experience metrics per cohort with side-by-side comparison.
- No individual user data displayed; all metrics are aggregate and respect k-anonymity suppression (WS-H.5.1b-2).
- Access restricted to authorized roles (ranking team, fairness auditors).
- Dashboards include cohort size and confidence intervals for each metric.
- GWEI-5 supported: aggregate experience-parity summaries can be exported for transparency (see WS-H.5.2d).

**Testing:**
- Integration: dashboards load and display cohort comparison data.
- Integration: access control enforced.
- Privacy: no individual user identifiers appear in dashboard data; suppressed cells render as withheld.

**Dependencies:** WS-H.5.1b, WS-H.5.1b-2.

---

### WS-H.5.2a Metric-measure space construction
**ID:** WS-H.5.2a
**Ref:** Section 9.2

**Description:**
For each cohort, construct a metric-measure space: `X_A` = items shown to cohort A; `d_A` = pairwise distance between items by semantic, source, evidence, and community relation (a nonnegative-weighted sum of per-relation pseudometrics); `mu_A` = normalized probability measure over `X_A` (normalized impression or attention share, sum = 1).

**Acceptance criteria:**
- Item set `X_A` sampled from items shown to cohort within the time window.
- Pairwise distance `d_A` is a pseudometric: nonnegative, symmetric, zero on diagonal.
- Distance combines semantic similarity, source distance, evidence distance, and community relation with configurable weights.
- Probability measure `mu_A` normalizes to 1.
- Space construction scales to sampled cohort windows (thousands of items).

**Testing:**
- Unit: distance function satisfies pseudometric properties.
- Unit: probability measure sums to 1.
- Unit: space construction produces valid inputs for GW computation.
- Performance: construction from sampled cohort (5000 items) completes within batch budget.

**Dependencies:** WS-H.5.1b.

---

### WS-H.5.2b Entropic-regularized GW distance
**ID:** WS-H.5.2b
**Ref:** Section 9.2

**Description:**
Compute the entropic-regularized order-2 Gromov-Wasserstein distance `GW_2` between two cohort metric-measure spaces. Report stability across random seeds and regularization strength. The invariant card records the approximation and its confidence interval.

**Acceptance criteria:**
- `GW_2` computed using entropic regularization for tractability.
- Seed stability reported: distance computed for multiple random initializations, variance reported.
- Regularization sensitivity reported: distance computed for multiple regularization strengths.
- Confidence interval derived from seed and regularization stability (`ci_low`, `ci_high` in score_vector).
- GWEI-2 satisfied: audits compare relational structure, not only item overlap.
- Output stored in `InvariantOutput.score_vector` with distance, confidence interval, seed count, and regularization parameters.

**Testing:**
- Unit: identical metric-measure spaces produce `GW_2 = 0` (within numerical tolerance).
- Unit: highly dissimilar spaces produce large `GW_2`.
- Unit: seed stability variance is below configurable threshold for production inputs.
- Statistical: regularization sensitivity within acceptable bounds.

**Dependencies:** WS-H.5.2a.

---

### WS-H.5.2c Release-gate integration
**ID:** WS-H.5.2c
**Ref:** Section 9.5, 9.7

**Description:**
Integrate GWEI into the algorithm release gate. A new algorithm cannot launch if protected or sensitive cohorts receive structurally degraded experiences beyond threshold. GWEI-1 satisfied: major ranking launches require cohort experience-isometry audits. GWEI-3 satisfied: any cohort degradation above threshold requires mitigation or sign-off.

**Acceptance criteria:**
- Release gate checks GWEI distance between cohorts under old and new algorithms.
- If any protected cohort's experience degrades beyond threshold, launch is blocked.
- Threshold is configurable per cohort type (stricter for minors, language minorities).
- Block can be overridden with documented sign-off from a responsible owner.
- Gate results are logged and included in experiment reports.

**Testing:**
- Integration: simulated algorithm change that degrades a cohort triggers gate block.
- Integration: sign-off override allows launch with documentation.
- Integration: gate passes when no cohort degrades beyond threshold.

**Dependencies:** WS-H.5.2b, WS-P (experiment framework).

---

### WS-H.5.2d Transparency-report export
**ID:** WS-H.5.2d
**Ref:** Section 9.6, 9.7 (GWEI-5)

**Description:**
Generate the anonymized aggregate experience-parity summaries published in transparency reports. The export turns GWEI metrics into a public-safe view: aggregate parity statements, no sensitive cohort details, k-anonymity enforced. This is the concrete deliverable behind GWEI-5, which previously had only a dashboard.

**Acceptance criteria:**
- GWEI-5 satisfied: transparency reports publish aggregate experience-parity summaries.
- Export contains only aggregate, k-anonymized parity statistics (no individual or small-cohort detail).
- Export distinguishes "parity within threshold" from "degradation under review" without exposing manipulation defenses.
- Export is reproducible from logged GWEI outputs (ties to WS-P transparency reporting).
- Export format is reviewed before publication; suppressed values are marked as withheld.

**Testing:**
- Unit: export omits any below-k cohort detail.
- Unit: export reproduces from stored GWEI outputs deterministically.
- Integration: export integrates with the WS-P transparency pipeline.

**Dependencies:** WS-H.5.2b, WS-H.5.1b-2, WS-P (transparency reporting).

---

## WS-H.6 PHI -- Preference Holonomy Invariant

> **Mathematical model (Section 11.2).** Each topic context has a local frame for the user's latent-preference space; moving from `x` to `y` applies an orthogonal transport `A_xy in O(n)` (a metric connection). Around a closed loop `x0 -> x1 -> ... -> xk = x0` the holonomy is the ordered product `H(gamma) = A_{x_{k-1}, x_k} ... A_{x_1, x_2} A_{x_0, x_1}`. The risk score is `PHI(gamma) = || log( H(gamma) ) ||_F`; for `H in SO(n)`, `log(H)` is real skew-symmetric and `|| log(H) ||_F = sqrt(2 sum_k theta_k^2)` in the rotation angles. `PHI = 0` iff `H = I`. Near rotation-by-pi the robust fallback `|| H - I ||_F` is used. PHI must use only conjugation-invariant summaries (gauge invariance) -- never coordinate-specific embedding values. **Privacy:** PHI operates on topic-cluster IDs and timing, never raw content.

### WS-H.6.1a Session topic-sequence tracking
**ID:** WS-H.6.1a
**Ref:** Section 11.2, 30.4

**Description:**
Track the sequence of topics a user visits within a session. The topic sequence forms the path `x0 -> x1 -> ... -> xk` used for holonomy computation. Topic transitions are recorded with timestamps but without raw content (privacy-preserving). Tracking uses topic cluster IDs, not individual story IDs.

**Acceptance criteria:**
- Session topic-sequence recorded as an ordered list of topic cluster IDs with timestamps.
- Sequences persist for the session duration and are available for loop detection.
- No raw content or individual story IDs stored in the sequence (privacy-preserving).
- Sequence length is capped to prevent unbounded growth (configurable max, default: 200 transitions).
- Sequences are available for both real-time loop detection and batch holonomy computation.

**Testing:**
- Unit: topic transitions correctly appended to session sequence.
- Unit: sequence cap enforced (oldest transitions dropped when cap reached).
- Privacy: sequence contains only topic cluster IDs and timestamps, no content.

**Dependencies:** WS-H.1.2a, WS-E (event pipeline).

---

### WS-H.6.1b Narrow-loop and compulsive-session detection
**ID:** WS-H.6.1b
**Ref:** Section 11.3, 30.4

**Description:**
Detect narrow loops (same topic cluster visited repeatedly in short succession) and compulsive sessions (rapid hostile returns -- short exits followed by immediate return to the same content). These are the v0 heuristic precursors to the full holonomy computation, providing immediate wellbeing signals.

**Acceptance criteria:**
- Narrow-loop detection identifies when the same topic cluster appears more than a configurable threshold (default: 3) times within a sliding window.
- Compulsive-session detection identifies rapid exit-and-return patterns.
- PHI-2 satisfied: high-holonomy loops are dampened before they become dominant.
- Detection runs in real-time on the session topic sequence.
- Detection results are logged but do not block the user (soft intervention only).

**Testing:**
- Unit: known narrow-loop sequence triggers detection.
- Unit: diverse topic sequence does not trigger detection.
- Unit: compulsive-session pattern (rapid exit-return) triggers detection.
- Integration: detection results feed into wellbeing prompts (WS-H.6.1c).

**Dependencies:** WS-H.6.1a.

---

### WS-H.6.1c Wellbeing prompts
**ID:** WS-H.6.1c
**Ref:** Sections 11.5, 11.6

**Description:**
When narrow-loop or compulsive-session detection triggers, display a non-blocking wellbeing prompt: "Your recent feed has become narrow around this topic. See broader context?" The prompt is dismissible and uses the same prompt framework shared with path-signature stopping cues. This task covers the prompt surface; feed-mode controls and reset/reduce actions are WS-H.6.1c-2.

> **Post-launch update (v0.7.3):** the interrupting prompt was **replaced** by a graduated, in-browser **topic-frequency dampener** — a topic the reader is circling is shown steadily less often in the front-page feed (down to a non-zero floor, so a pursued topic still surfaces rarely) and recovers as the reader moves on. No modal, nothing sent to the server. See SPEC §11.6 and `apps/web/src/signals/topic-dampening.ts`. The narrow-loop math + the quiet-notification policy below are unchanged.

**Acceptance criteria:**
- Wellbeing prompt displayed when loop/compulsive detection triggers; prompt is non-blocking and dismissible.
- Prompt copy is supportive, not accusatory, and offers a path to broader context.
- Quiet notification policy for high-holonomy topics (no push notifications that reinforce the loop).
- Prompt uses design system components and passes accessibility checks.

**Testing:**
- Unit: prompt appears when detection triggers; absent otherwise.
- E2E: prompt is dismissible and a "see broader context" action exists.
- Accessibility: prompt is announced by screen readers.

**Dependencies:** WS-H.6.1b, WS-B.2 (design system).

---

### WS-H.6.1c-2 Feed-mode controls and personalization reset
**ID:** WS-H.6.1c-2
**Ref:** Sections 11.5, 11.6

**Description:**
User controls reachable from the wellbeing prompt and feed settings: feed-mode switch (Best, Rising, Sources, Debates, New), "reset topic history," and "reduce personalization" (switches the feed to the non-personalized New sort). PHI-4 satisfied: users can reset or reduce personalization without deleting their account.

**Acceptance criteria:**
- Feed-mode switch accessible from prompt and from feed settings; modes: Best, Rising, Sources, Debates, New.
- "Reset topic history" clears the user's topic-sequence state without affecting account or contributions.
- "Reduce personalization" adjusts the personalization weight without full reset.
- PHI-4 satisfied: reset/reduce personalization is available and does not require account deletion.
- Settings persist across sessions and devices.

**Testing:**
- E2E: feed-mode switch changes feed behavior.
- E2E: reset topic history clears sequence state without affecting contributions.
- E2E: reduce personalization changes subsequent feed composition.
- Accessibility: controls pass accessibility checks.

**Dependencies:** WS-H.6.1c, WS-D.1 (user settings).

---

### WS-H.6.2a Local coordinate frames
**ID:** WS-H.6.2a
**Ref:** Section 11.2

**Description:**
Each topic context has a local coordinate system (a frame) for the user's latent-preference space. Frames are learned from user behavior within each topic context and represent the local structure of preference. The frame captures what "interest" means locally -- e.g., interest in nutrition via cooking vs via conspiracy means different local coordinates.

**Acceptance criteria:**
- Local coordinate frame computed per topic context from user behavior data.
- Frames are orthonormal (columns are orthogonal unit vectors) or Gram-Schmidt orthonormalized.
- Frame dimension `n` is configurable (default: latent preference embedding dimension).
- Frames are versioned and re-computed on a configurable schedule.
- Frame computation is a batch operation.

**Testing:**
- Unit: computed frames are orthonormal (within numerical tolerance).
- Unit: different topic contexts produce different frames.
- Integration: frames feed into transport map computation (WS-H.6.2b).

**Dependencies:** WS-H.6.1a.

---

### WS-H.6.2b Orthogonal transport maps and holonomy
**ID:** WS-H.6.2b
**Ref:** Section 11.2

**Description:**
Compute orthogonal transport maps `A_xy in O(n)` between topic context frames. For a closed path `x0 -> x1 -> ... -> xk = x0`, the holonomy is `H(gamma) = A_{x_{k-1}, x_k} ... A_{x_1, x_2} A_{x_0, x_1}`. Transport maps are metric-preserving (orthogonal) so composition around a loop stays in `O(n)` and holonomy is well-defined. Gauge-invariant summaries (conjugation-invariant) are used -- never coordinate-specific embedding values.

**Acceptance criteria:**
- Transport maps `A_xy` are orthogonal matrices (A^T A = I, within numerical tolerance).
- Holonomy `H(gamma)` computed as the ordered product of transport maps around the loop.
- `H(gamma) = I` for flat (path-independent) transport.
- Summaries are gauge-invariant: Frobenius norm of `log(H)`, rotation angles, trace -- never raw matrix entries.
- Transport maps computed from frame pairs using Procrustes-type alignment or learned.

**Testing:**
- Unit: transport maps satisfy orthogonality (A^T A = I).
- Unit: holonomy of a trivial loop (identity path) is I.
- Unit: holonomy of a non-trivial loop produces H != I.
- Unit: gauge-invariant summaries are invariant under conjugation (Q H Q^T produces same summary).

**Dependencies:** WS-H.6.2a.

---

### WS-H.6.2c PHI score computation
**ID:** WS-H.6.2c
**Ref:** Section 11.2

**Description:**
Compute `PHI(gamma) = ||log(H(gamma))||_F`. For `H in SO(n)`, the principal matrix logarithm `log(H)` is a real skew-symmetric matrix whose Frobenius norm equals `sqrt(2 * sum_k theta_k^2)` in the loop's rotation angles `theta_k`. Fallback: when `H` has eigenvalues near the negative real axis (rotation-by-pi edge case), use `||H - I||_F` instead, with reason code `MATRIX_LOG_FALLBACK`.

**Acceptance criteria:**
- PHI computed via matrix logarithm when well-defined (no eigenvalue on negative real axis).
- Fallback `||H - I||_F` used when matrix logarithm is ill-conditioned; `MATRIX_LOG_FALLBACK` reason code set.
- `PHI(gamma) = 0` when `H(gamma) = I` (flat transport).
- PHI score stored in `InvariantOutput.score_vector` with loop path, rotation angles, and fallback flag.
- PHI-1 satisfied: ranking computes path-risk features for recommendation sequences.
- PHI-5 satisfied: experiments report holonomy-risk distribution.

**Testing:**
- Unit: identity holonomy produces PHI = 0.
- Unit: known rotation produces expected PHI value.
- Unit: near-pi rotation triggers fallback and produces finite PHI.
- Unit: PHI ordering correct (larger rotations produce larger PHI).

**Dependencies:** WS-H.6.2b.

---

### WS-H.6.2c-2 Gauge-invariance verification (PHI v2)
**ID:** WS-H.6.2c-2
**Ref:** Section 11.2 correctness note, 30.4 (PHI v2)

**Description:**
PHI v2 is "gauge-invariant holonomy diagnostics." Add an explicit verification layer ensuring every PHI summary used downstream is conjugation-invariant and basepoint/frame independent. The check randomly conjugates `H` by orthogonal `Q` and asserts the summary is unchanged within tolerance; it also asserts no coordinate-specific embedding value ever leaves the invariant boundary. This is the gate evidence that PHI uses gauge-invariant summaries (Section 30.4 PHI gate) and protects against accidental leakage of frame-dependent quantities.

**Acceptance criteria:**
- A verification routine conjugates `H -> Q H Q^T` for random orthogonal `Q` and asserts the PHI summary (Frobenius norm of `log H`, rotation angles, trace) is invariant within tolerance.
- The PHI output boundary is checked to contain only gauge-invariant fields (no raw matrix entries or embedding coordinates).
- The verification runs as part of PHI v2 promotion evidence (WS-H.1.2e) and in CI.
- Any frame-dependent value detected at the boundary fails the build.

**Testing:**
- Unit: conjugation by random `Q` leaves the summary invariant.
- Unit: a deliberately frame-dependent summary fails the gauge check.
- Unit: output-boundary scan rejects raw matrix entries.

**Dependencies:** WS-H.6.2c.

---

### WS-H.6.2d Sensitive-topic stricter thresholds
**ID:** WS-H.6.2d
**Ref:** Section 11.5

**Description:**
Sensitive topics (self-harm, eating disorders, medical misinformation, extremist ideology, harassment) have stricter PHI loop thresholds. Minors receive stricter thresholds and less personalization. PHI-3 satisfied: sensitive topics use stricter thresholds.

**Acceptance criteria:**
- Sensitive topic categories defined and configurable.
- PHI thresholds for wellbeing intervention are lower (stricter) for sensitive topics.
- Minor users receive stricter thresholds than adults.
- Threshold configuration is auditable and version-controlled.
- Topic sensitivity classification uses the same sensitivity labels from WS-F ingestion.

**Testing:**
- Unit: sensitive topic PHI threshold triggers intervention at lower PHI than general topics.
- Unit: minor user thresholds are stricter than adult thresholds.
- Integration: threshold changes propagate correctly to loop detection and wellbeing prompts.

**Dependencies:** WS-H.6.2c, WS-F.1 (sensitivity labels).

---

### WS-H.6.2e High-holonomy loop dampening
**ID:** WS-H.6.2e
**Ref:** Sections 11.5, 30.4 (PHI v1)

**Description:**
Wire PHI into ranking constraints (PHI v1): no sequence should repeatedly route a user through high-risk loops without deliberate user choice; high-holonomy transitions are dampened or diversified. This is the ranking-side effect that pairs with v0 wellbeing prompts. The gate requires dampening manipulative loops without blocking intentional deep research, so deliberate user choice (e.g., explicit "show more on this") overrides dampening, and effects are reversible and logged with reason codes.

**Acceptance criteria:**
- High-holonomy transitions are dampened or diversified in ranking when PHI exceeds threshold.
- Deliberate user choice overrides dampening (intentional deep research is not blocked).
- Effects apply only when PHI `shadow_status` is a constraint mode; individually feature-flagged and reversible.
- Reason codes and reversible-gate records logged per Section 30.4 PHI gate.
- PHI-2 supported at the ranking level (complements v0 detection).

**Testing:**
- Unit: high-holonomy transition is dampened when enabled; no-op while in shadow.
- Unit: explicit user override disables dampening for that choice.
- Integration: repeated high-risk loop is diversified in a simulated sequence; logged with reason code.

**Dependencies:** WS-H.6.2c, WS-H.1.2e, WS-I (ranking).

---

## WS-H.7 Supporting invariants

> The five core invariants suffice for the primary platform. These supporting invariants add value without overcomplicating the user experience; each ships as a confidence-bearing service with the same discipline (Section 21.4): versioned outputs, invariant cards, confidence/coverage/reason-codes, graceful fallback, and shadow-before-enforcement.

### WS-H.7.1a Hodge -- simplicial complex construction
**ID:** WS-H.7.1a
**Ref:** Section 12.1

**Description:**
Represent a conversation as a simplicial complex of users, claims, and replies. Edge flows encode agreement, disagreement, correction, or attention between participants. The complex captures the interaction structure for Hodge decomposition.

**Acceptance criteria:**
- Conversation mapped to a simplicial complex: vertices (users, claims), edges (interactions), and higher simplices (multi-party exchanges).
- Edge flows labeled with interaction type: agreement, disagreement, correction, attention.
- Flow magnitudes derived from interaction strength (contribution type weights from WS-G).
- Complex construction scales to conversations with hundreds of participants.
- Complex is serializable for debugging and audit.

**Testing:**
- Unit: known conversation structure produces expected simplicial complex.
- Unit: edge flows correctly labeled from contribution types.
- Performance: complex construction for 500-participant conversation within budget.

**Dependencies:** WS-H.1.2a, WS-G.1 (thread/contribution data).

---

### WS-H.7.1b Hodge -- Helmholtz decomposition
**ID:** WS-H.7.1b
**Ref:** Section 12.1

**Description:**
Discrete Hodge (Helmholtz) decomposition splitting the edge flow into orthogonal components: `flow = gradient + curl + harmonic`. The gradient part is a globally consistent ranking/ordering; curl is local cyclic inconsistency; harmonic is global, irreducible cyclic conflict. This task covers the decomposition and orthogonality guarantees; labels, routing, and the PWAtt penalty are WS-H.7.1c.

**Acceptance criteria:**
- Decomposition produces gradient, curl, and harmonic components.
- Components are orthogonal (pairwise inner products near zero within numerical tolerance).
- Harmonic component magnitude is reported as the structural-conflict measure.
- Decomposition handles the sparse structure of conversation complexes.
- Output stored in score_vector with the three component magnitudes.

**Testing:**
- Unit: decomposition of a known flow produces expected gradient, curl, harmonic.
- Unit: components are orthogonal.
- Unit: a pure-gradient flow has zero curl and harmonic; a pure cycle has nonzero curl/harmonic.

**Dependencies:** WS-H.7.1a.

---

### WS-H.7.1c Hodge -- labels, routing, and HarmfulTensionRisk
**ID:** WS-H.7.1c
**Ref:** Section 12.1

**Description:**
Use the decomposition to label threads and route moderators: "High disagreement, low hostility" vs "Global unresolved conflict." Moderator routing for high harmonic tension. The `HarmfulTensionRisk` penalty in PWAtt combines harmonic tension with hostility/safety classifiers -- harmonic tension alone never penalizes legitimate sustained disagreement.

**Acceptance criteria:**
- Thread labels assigned from component magnitudes and safety classifier outputs.
- High harmonic + low hostility -> "High disagreement, low hostility" (no penalty).
- High harmonic + high hostility -> "Global unresolved conflict" + moderator routing.
- `HarmfulTensionRisk` requires both high harmonic tension AND hostility/safety signals.
- Legitimate disagreement with low hostility is not penalized (verified explicitly).
- Moderator queue receives threads with high harmonic tension and hostility.

**Testing:**
- Unit: high harmonic + low hostility produces the non-penalizing label.
- Unit: high harmonic + high hostility produces the conflict label and routing.
- Unit: `HarmfulTensionRisk` is zero without hostility signal even at high harmonic tension.
- Integration: moderator queue receives routed threads.

**Dependencies:** WS-H.7.1b, WS-J (moderator queue).

---

### WS-H.7.2a Tropical -- min-plus cascade timing
**ID:** WS-H.7.2a
**Ref:** Section 12.2

**Description:**
Use the min-plus (tropical) semiring to compute earliest-arrival times along spread paths. Earliest arrival is exact in min-plus. Build a timing matrix from cascade spread data where each entry records the earliest time content reached a node via each path.

**Acceptance criteria:**
- Min-plus computation correctly produces earliest-arrival times.
- Timing matrix constructed from cascade spread events.
- Cascade structure summarized by tropical-rank-style features of the timing matrix (feature choice documented in invariant card, since several inequivalent notions of tropical rank exist).
- Computation handles the sparse structure of typical cascade graphs.

**Testing:**
- Unit: known cascade graph produces expected earliest-arrival times.
- Unit: min-plus algebra operations (addition = min, multiplication = plus) are correct.
- Integration: timing matrix feeds into synchronized cascade detection (WS-H.7.2b).

**Dependencies:** WS-H.1.2a, WS-E (cascade event data).

---

### WS-H.7.2b Tropical -- synchronized cascade detection
**ID:** WS-H.7.2b
**Ref:** Section 12.2

**Description:**
Detect coordinated link drops and unnatural trend timing from tropical cascade features. Synchronized cascades have unusually uniform arrival times across independent paths. Complements MFCI with timing geometry. Cascade features feed into MFCI as supplementary evidence.

**Acceptance criteria:**
- Synchronized cascade detection identifies unusually uniform timing across spread paths.
- Detection threshold calibrated against organic cascade baselines.
- Detected cascades flagged with confidence score and timing evidence.
- Features feed into MFCI as complementary timing geometry signals.
- Coordinated link drops detected by simultaneous multi-node arrival.

**Testing:**
- Unit: synthetic synchronized cascade triggers detection.
- Unit: organic cascade with natural timing variance does not trigger.
- Integration: detected cascades produce MFCI-supplementary features.

**Dependencies:** WS-H.7.2a.

---

### WS-H.7.3a Braid -- strand tracking and crossing detection
**ID:** WS-H.7.3a
**Ref:** Section 12.3

**Description:**
Trending topics trace strands over time. As strands swap rank positions, crossings form a braid word. Track topic-rank positions over time windows and record crossing events (rank swaps between adjacent strands).

**Acceptance criteria:**
- Topic rank positions tracked over configurable time windows.
- Crossings (rank swaps) detected and recorded with timestamps.
- Braid word constructed from the sequence of crossings.
- Strand identity maintained across time windows (topics don't lose their strand assignment).
- Tracking scales to dozens of trending topics simultaneously.

**Testing:**
- Unit: known rank-swap sequence produces expected braid word.
- Unit: stable rankings (no swaps) produce trivial braid.
- Performance: tracking 50 strands over 24 hours within budget.

**Dependencies:** WS-H.1.2a, WS-I (ranking position data).

---

### WS-H.7.3b Braid -- entropy and gaming detection
**ID:** WS-H.7.3b
**Ref:** Section 12.3

**Description:**
Compute crossing number and braid (topological) entropy from the braid word. High entropy indicates rapid, turbulent agenda churn. Detect manufactured churn (repeated artificial rank swaps) and threshold-gaming (keeping a topic near a visibility boundary). Flag gaming attempts for steward review.

**Acceptance criteria:**
- Crossing number computed from braid word.
- Braid entropy computed as a measure of agenda turbulence.
- Manufactured churn detected: unusually high crossing rate relative to organic baseline.
- Threshold-gaming detected: topic repeatedly crosses a visibility boundary.
- Flagged patterns include evidence (braid word, crossing rate, entropy) for steward review.

**Testing:**
- Unit: known braid word produces expected crossing number and entropy.
- Unit: organic trending patterns produce normal entropy.
- Unit: synthetic gaming pattern (rapid oscillation) produces high entropy and flag.
- Integration: flags appear in steward dashboard.

**Dependencies:** WS-H.7.3a.

---

### WS-H.7.4a Reeb -- scalar function and level-set construction
**ID:** WS-H.7.4a
**Ref:** Section 12.4

**Description:**
Define a scalar function over content space (e.g., engagement velocity or controversy score) and construct level sets -- connected components of content at each function value. Level sets form the basis for the Reeb graph that tracks how narrative basins evolve.

**Acceptance criteria:**
- Scalar function defined from engagement velocity, controversy, or configurable metric.
- Level sets computed as connected components at each discretized function value.
- Level-set construction handles the continuous-to-discrete approximation.
- Components are tracked with stable identifiers across function values.

**Testing:**
- Unit: known content distribution produces expected level-set components.
- Unit: single peak produces single component at each level.
- Unit: bimodal distribution produces two components that merge.

**Dependencies:** WS-H.1.2a, WS-E (engagement data).

---

### WS-H.7.4b Reeb -- graph computation, bifurcation, and bridge prompts
**ID:** WS-H.7.4b
**Ref:** Section 12.4

**Description:**
Compute the Reeb graph tracking how level-set components merge and split as the scalar function changes. Detect bifurcation points (where one basin splits into two) and saddle points (where two basins share a fragile connection). Route bridge prompts when two attention basins share a fragile saddle. Visualize narrative basins in Civic Map (later milestone).

**Acceptance criteria:**
- Reeb graph correctly tracks component merges (two components becoming one) and splits (one becoming two).
- Bifurcation points detected and labeled.
- Saddle points (fragile connections between basins) detected.
- Bridge prompts routed when basins share a fragile saddle.
- Graph structure stored for downstream visualization (Civic Map, later milestone).

**Testing:**
- Unit: known level-set evolution produces expected Reeb graph.
- Unit: bifurcation point correctly identified in synthetic data.
- Unit: saddle point detection identifies fragile connections.
- Integration: bridge prompts triggered at saddle points.

**Dependencies:** WS-H.7.4a.

---

### WS-H.7.5a CID -- transformation group definition
**ID:** WS-H.7.5a
**Ref:** Section 12.5

**Description:**
Define the transformation group `G` for protected attributes that should not change ranking. Transformations include: identity-attribute swaps (e.g., change user gender, ethnicity in a counterfactual), translation (change language of content), source-attribute swaps (change publisher identity while keeping content). `CID(x,u) = E_g |R(g.x, g.u) - R(x,u)|` measures ranking sensitivity to transformations that should be neutral.

**Acceptance criteria:**
- Transformation group defined for protected attributes: identity, language, source identity.
- Each transformation is invertible and composable (group axioms satisfied).
- Transformations are applied to content and user representations, not raw data.
- Transformation definitions are auditable and version-controlled.
- Group elements are documented in the invariant card.

**Testing:**
- Unit: transformations satisfy group axioms (closure, associativity, identity, inverse).
- Unit: identity transformation produces no change.
- Unit: transformations correctly modify the target attributes without side effects.

**Dependencies:** WS-H.1.2a, WS-D.1 (user attributes).

---

### WS-H.7.5b CID -- computation and bias detection
**ID:** WS-H.7.5b
**Ref:** Section 12.5

**Description:**
Compute `CID(x,u) = E_g |R(g.x, g.u) - R(x,u)|` for each transformation group element. High CID indicates ranking sensitivity to attributes that should be neutral -- potential bias. CID feeds into the model-release gate: models with CID above threshold for protected attributes cannot launch without review.

**Acceptance criteria:**
- CID computed as expected deviation across group elements.
- CID = 0 means ranking is invariant to the transformation (no bias detected).
- High CID for protected-attribute transformations triggers bias flag.
- CID computed for protected-attribute transformations in every ranking model evaluation.
- Model-release gate blocks launches with CID above configurable threshold.
- CID results logged for audit and fairness reporting.

**Testing:**
- Unit: ranking function that ignores protected attributes produces CID near 0.
- Unit: ranking function that uses protected attributes produces high CID.
- Integration: CID above threshold triggers release-gate block.
- Integration: CID results appear in model evaluation reports.

**Dependencies:** WS-H.7.5a, WS-I (ranking function), WS-P (release gate).

---

### WS-H.7.6a Path-signature -- session path and iterated integrals
**ID:** WS-H.7.6a
**Ref:** Section 12.6

**Description:**
Model session events as a path in a multi-dimensional space (dimensions: topic, action type, time, engagement level). Compute the path signature (iterated integrals) that encodes ordered behavior. The signature distinguishes sequences like read -> source -> question (constructive) from scroll -> rage-reply -> repeat (compulsive) without reading private content.

**Acceptance criteria:**
- Session events mapped to a path in multi-dimensional space.
- Path signature (truncated to configurable depth, default: 3) computed via iterated integrals.
- Signature captures order-dependent behavior patterns.
- No private content read -- only event types, topic clusters, and timing.
- Signature computation is efficient for typical session lengths (up to 200 events).

**Testing:**
- Unit: constructive session path produces different signature than compulsive session path.
- Unit: identical event sets in different orders produce different signatures.
- Privacy: signature computation input contains no content text or user-generated data.
- Performance: signature for 200-event session computed within 50ms.

**Dependencies:** WS-H.1.2a, WS-E (session event data).

---

### WS-H.7.6b Path-signature -- unhealthy loop detection and stopping cues
**ID:** WS-H.7.6b
**Ref:** Section 12.6

**Description:**
Use path-signature features to detect unhealthy loops and improve stopping cues. Classify session health from signature features: constructive deep dive, casual browsing, narrowing loop, compulsive return, rage spiral. Unhealthy patterns feed stopping cues (complementing PHI v0 heuristics). Session health classification does not read private content.

**Acceptance criteria:**
- Session health classified into categories: constructive, casual, narrowing, compulsive, rage.
- Classification uses path-signature features, not raw content.
- Unhealthy patterns (narrowing, compulsive, rage) trigger stopping cues.
- Stopping cues are non-blocking prompts (same framework as PHI wellbeing prompts).
- No private content reading -- classification based on behavioral patterns only.
- Classification results logged for model improvement but not shared externally.

**Testing:**
- Unit: synthetic constructive session classified as constructive.
- Unit: synthetic compulsive session classified as compulsive.
- Integration: unhealthy classification triggers stopping cue.
- Privacy: classification pipeline input verified to contain no content text.

**Dependencies:** WS-H.7.6a.

---

## Task dependency summary

| Task | Depends on |
|---|---|
| WS-H.1.1a | WS-A (schema tooling), WS-E (event pipeline for invariant run events) |
| WS-H.1.1b | WS-H.1.1a |
| WS-H.1.1c | WS-H.1.1a |
| WS-H.1.1d | WS-H.1.1a, WS-H.1.1c |
| WS-H.1.2a | WS-H.1.1a |
| WS-H.1.2b | WS-H.1.2a |
| WS-H.1.2c | WS-H.1.2a, WS-H.1.1c |
| WS-H.1.2c-2 | WS-H.1.2c |
| WS-H.1.2d | WS-H.1.1d |
| WS-H.1.2d-2 | WS-H.1.2d |
| WS-H.1.2e | WS-H.1.2b, WS-H.1.2c |
| WS-H.1.2f | WS-H.1.2a, WS-E (event pipeline) |
| WS-H.1.2g | WS-H.1.2a, WS-H.1.2d-2 |
| WS-H.2.1a | WS-H.1.2a, WS-F.1 (URL canonicalization) |
| WS-H.2.1b | WS-H.2.1a, WS-F.3.2 (embeddings) |
| WS-H.2.2a | WS-H.2.1b, WS-F.1 (source profiles, claim extraction), WS-G.2 (rooms/lenses) |
| WS-H.2.2b | WS-H.2.2a |
| WS-H.2.2c | WS-H.2.2b |
| WS-H.2.2d | WS-H.2.2c |
| WS-H.2.3a | WS-H.2.2c, WS-B.2 (design system) |
| WS-H.2.3b | WS-H.2.2c, WS-B.2 |
| WS-H.2.3c | WS-H.2.3a, WS-D.1 (user settings) |
| WS-H.2.4a | WS-H.2.2d, WS-H.1.1c |
| WS-H.3.1a | WS-H.1.2a, WS-E (event pipeline) |
| WS-H.3.1b | WS-H.3.1a |
| WS-H.3.1c | WS-H.3.1a, WS-H.3.1b |
| WS-H.3.2a | WS-H.1.2a, WS-E (event pipeline) |
| WS-H.3.2b | WS-H.3.2a |
| WS-H.3.2c | WS-H.3.2b, WS-H.3.1c |
| WS-H.3.3a | WS-H.3.2b |
| WS-H.3.3b | WS-H.3.3a |
| WS-H.3.3c | WS-H.3.3b |
| WS-H.3.3d | WS-H.3.1a, WS-H.3.1b, WS-H.3.3c |
| WS-H.3.3e | WS-H.3.3c, WS-H.1.2d |
| WS-H.3.4a | WS-H.3.3c |
| WS-H.3.4a-2 | WS-H.3.4a, WS-H.1.2e |
| WS-H.3.4b | WS-H.3.4a, WS-J (trust and safety queues) |
| WS-H.3.4c | WS-H.3.4b, WS-J (appeals system) |
| WS-H.4.1a | WS-H.1.2a, WS-G.2.2 (lens definitions) |
| WS-H.4.1b | WS-H.4.1a |
| WS-H.4.1c | WS-H.4.1b, WS-G.2.3 (steward roles) |
| WS-H.4.2a | WS-H.4.1a |
| WS-H.4.2b | WS-H.4.2a |
| WS-H.4.2c | WS-H.4.2b |
| WS-H.4.2d | WS-H.4.2c, WS-G.1 (contribution system) |
| WS-H.4.2e | WS-H.4.2c, WS-H.1.2e |
| WS-H.4.2f | WS-H.4.2c |
| WS-H.4.3a | WS-H.4.1b, WS-B.2 (design system) |
| WS-H.4.3b | WS-H.4.2c, WS-B.2 |
| WS-H.4.3c | WS-H.4.1b, WS-B.2, WS-G.3 (composer) |
| WS-H.4.3d | WS-H.4.1b, WS-G.1 (thread structure), WS-J (moderation actions/appeals) |
| WS-H.5.1a | WS-H.1.2a, WS-D.1 (user metadata) |
| WS-H.5.1b | WS-H.5.1a, WS-E (event pipeline for attention data) |
| WS-H.5.1b-2 | WS-H.5.1b |
| WS-H.5.1c | WS-H.5.1b, WS-H.5.1b-2 |
| WS-H.5.2a | WS-H.5.1b |
| WS-H.5.2b | WS-H.5.2a |
| WS-H.5.2c | WS-H.5.2b, WS-P (experiment framework) |
| WS-H.5.2d | WS-H.5.2b, WS-H.5.1b-2, WS-P (transparency reporting) |
| WS-H.6.1a | WS-H.1.2a, WS-E (event pipeline) |
| WS-H.6.1b | WS-H.6.1a |
| WS-H.6.1c | WS-H.6.1b, WS-B.2 (design system) |
| WS-H.6.1c-2 | WS-H.6.1c, WS-D.1 (user settings) |
| WS-H.6.2a | WS-H.6.1a |
| WS-H.6.2b | WS-H.6.2a |
| WS-H.6.2c | WS-H.6.2b |
| WS-H.6.2c-2 | WS-H.6.2c |
| WS-H.6.2d | WS-H.6.2c, WS-F.1 (sensitivity labels) |
| WS-H.6.2e | WS-H.6.2c, WS-H.1.2e, WS-I (ranking) |
| WS-H.7.1a | WS-H.1.2a, WS-G.1 (thread/contribution data) |
| WS-H.7.1b | WS-H.7.1a |
| WS-H.7.1c | WS-H.7.1b, WS-J (moderator queue) |
| WS-H.7.2a | WS-H.1.2a, WS-E (cascade event data) |
| WS-H.7.2b | WS-H.7.2a |
| WS-H.7.3a | WS-H.1.2a, WS-I (ranking position data) |
| WS-H.7.3b | WS-H.7.3a |
| WS-H.7.4a | WS-H.1.2a, WS-E (engagement data) |
| WS-H.7.4b | WS-H.7.4a |
| WS-H.7.5a | WS-H.1.2a, WS-D.1 (user attributes) |
| WS-H.7.5b | WS-H.7.5a, WS-I (ranking function), WS-P (release gate) |
| WS-H.7.6a | WS-H.1.2a, WS-E (session event data) |
| WS-H.7.6b | WS-H.7.6a |

---

## Acceptance-criterion coverage map

Every SPEC invariant acceptance criterion maps to at least one task here. This table is the audit trail used at milestone review.

| Criterion | Requirement (abbrev.) | Satisfying task(s) |
|---|---|---|
| MERI-1 | Syndicated near-duplicates do not each raise rank | WS-H.2.1a, WS-H.2.1b |
| MERI-2 | Primary document > ten cross-quoting posts | WS-H.2.2c |
| MERI-3 | Topic pages expose source/evidence lineage | WS-H.2.3b |
| MERI-4 | Experiments report MERI distribution (incl. approximation rate) | WS-H.2.2d |
| MERI-5 | MERI features explainable in user terms | WS-H.2.3a |
| MFCI-1 | Large normal communities not penalized for volume | WS-H.3.2b |
| MFCI-2 | Coordinated reporting delayed until reviewed | WS-H.3.4a-2, WS-H.3.4b |
| MFCI-3 | Severe synchronization freezes within one minute | WS-H.3.1a, WS-H.3.1b, WS-H.3.3d |
| MFCI-4 | Every action logs fixed margins + statistic | WS-H.3.2b |
| MFCI-5 | Appeals inspect human-readable rationale | WS-H.3.4c |
| GWEI-1 | Major launches require isometry audits | WS-H.5.2c |
| GWEI-2 | Compare relational structure, not item overlap | WS-H.5.2b |
| GWEI-3 | Degradation above threshold requires mitigation/sign-off | WS-H.5.2c |
| GWEI-4 | Dashboards privacy-protected, access-controlled | WS-H.5.1c, WS-H.5.1b-2 |
| GWEI-5 | Transparency reports publish aggregate parity | WS-H.5.2d |
| SCOI-1 | Cross-community distribution includes context | WS-H.4.2e, WS-H.4.3a |
| SCOI-2 | Bridge comments credited when obstruction drops | WS-H.4.2d |
| SCOI-3 | Users inspect interpretation differences in plain language | WS-H.4.3b |
| SCOI-4 | Moderators merge/annotate/separate by context state | WS-H.4.3d |
| SCOI-5 | SCOI validated against human-labeled cases | WS-H.4.2c |
| PHI-1 | Ranking computes path-risk features | WS-H.6.2c |
| PHI-2 | High-holonomy loops dampened before dominant | WS-H.6.1b, WS-H.6.2e |
| PHI-3 | Sensitive topics use stricter thresholds | WS-H.6.2d |
| PHI-4 | Users reset/reduce personalization without deleting account | WS-H.6.1c-2 |
| PHI-5 | Experiments report holonomy-risk distribution | WS-H.6.2c |

---

## Workstream definition of done

WS-H is complete when:

1. **All 11 invariants** (MERI, MFCI, GWEI, SCOI, PHI, Hodge, Tropical, Braid, Reeb, CID, Path-signature) are implemented, conform to the `InvariantService` interface, and produce outputs stored in the `InvariantOutput` table with validated per-type `score_vector` schemas.
2. **Every invariant** has a complete, validated invariant card with owner, version, I/O schema, confidence bounds, coverage definition, known failure modes, fallback behavior, and approximation notes.
3. **Every output carries** confidence, coverage, reason codes, and a fallback indicator, per the cross-cutting invariant contracts.
4. **All invariants run in shadow** -- computing and logging outputs without affecting ranking. Promotion to any constraint mode is gated by WS-H.1.2e and the M3 milestone review; no invariant carries enforcement authority while in shadow.
5. **Fallback framework** is operational: any invariant failure results in graceful degradation (ranking continues without it) with gap logging, monitoring, and alerting.
6. **Compute-tier orchestration** routes real-time, near-real-time, and batch methods correctly, with back-pressure protecting real-time latency.
7. **Observability** is uniform across all invariants: confidence, coverage, compute time, fallback rate, and drift are emitted and dashboarded.
8. **Regression harness** runs in CI and nightly, with deterministic synthetic datasets, edge cases, and drift detection for all invariants.
9. **MERI acceptance criteria** MERI-1 through MERI-5 are satisfied: duplicate dampening, primary-document independence, topic-page lineage, distribution reporting (incl. approximation rate), and user-facing explainability.
10. **MFCI acceptance criteria** MFCI-1 through MFCI-5 are satisfied: base-rate conditioning, delayed enforcement, sub-minute freeze, margin logging, and appeal inspection; v2 adversarial-adaptation tests pass.
11. **SCOI acceptance criteria** SCOI-1 through SCOI-5 are satisfied: cross-community context, bridge credit, interpretation inspection, moderator merge/annotate/separate tools, and human-label validation; the v2 cohomological diagnostic is available.
12. **GWEI acceptance criteria** GWEI-1 through GWEI-5 are satisfied: launch audits, relational comparison, degradation mitigation, privacy-protected/k-anonymized dashboards, and transparency-report export.
13. **PHI acceptance criteria** PHI-1 through PHI-5 are satisfied: path-risk features, loop dampening (v0 prompts + v1 ranking), sensitive-topic thresholds, personalization reset, and experiment reporting; v2 gauge-invariance verification passes.
14. **Supporting invariants** produce stable outputs with confidence/coverage and feed downstream services (MFCI, ranking, moderation, wellbeing prompts) as specified; `HarmfulTensionRisk` never penalizes low-hostility disagreement.
15. **All UI elements** (feed labels, drawers, prompts, warnings, composer interstitials, moderator tools) render correctly, pass accessibility checks, and use design system components.
16. **Analyst dashboards** for MFCI, GWEI, and SCOI are operational with appropriate access controls.
17. **Version comparison** enables A/B evaluation of invariant algorithm versions, and the acceptance-criterion coverage map is verified at milestone review.
18. **No invariant output carries enforcement authority in shadow mode** -- outputs are observational until explicitly promoted by the milestone gate, and any promoted effect is independently reversible (kill-switchable).
