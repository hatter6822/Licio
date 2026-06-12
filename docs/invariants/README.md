# WS-H: Core Invariant Services — implementation reference

This document describes the implemented WS-H surface: the invariant
computation platform (outputs, cards, fallback wrapper, promotion gate,
tiers, observability), the five core invariants (MERI, MFCI, GWEI, SCOI,
PHI) and six supporting invariants (Hodge, Tropical, Braid, Reeb, CID,
Path-signature), their analyst/steward surfaces, and the client surfaces.
The design specification is SPEC §7–§12, §21.4, §22.1, and §30.4; the task
plan is `docs/planning/09-invariant-services.md`.

Two constraints govern everything here (SPEC §30.4, the M2 gate):

1. **Shadow before enforcement.** Every WS-H output is persisted with
   `shadow_mode: true` and carries ZERO enforcement authority. The single
   path to any effect is the WS-H.1.2e promotion gate: an append-only
   `invariant_promotions` record validated against a checklist (minimum
   shadow days, drift-report reference, coverage/confidence at or above the
   card bounds, named owner). Promotions advance one step at a time
   (`shadow → soft_constraint → hard_constraint`); demotion — the kill
   switch — is always legal and takes effect on the next read, no redeploy.
   `effectsEnabled(invariantType)` is the one predicate every
   effect-application site consults, and the WS-E ranking boundary
   (`selectRankingInputs`) independently rejects shadow rows.
2. **Confidence, coverage, reason codes, fallback on every output.** The
   `invariant_outputs` table carries the full WS-H.1.1c envelope; reason
   codes validate against the versioned registry in `@licio/invariants`;
   `fallback_used` derives from the codes; score vectors validate against
   per-type zod schemas BEFORE insert (an invalid vector never lands).

## Architecture

| Layer | Location | Contents |
|---|---|---|
| Pure mathematics | `packages/invariants/src/{math,meri,mfci,gwei,scoi,phi,hodge,tropical,braid,reeb,cid,pathsig}` | Deterministic, property-tested invariant math (no I/O, no clock, seeded randomness only) |
| Schemas | `packages/invariants/src/schemas/` | Reason-code registry, per-type score-vector zod schemas (strict, snapshot-pinned), the invariant-card schema |
| Platform contracts | `packages/invariants/src/platform/` | `InvariantService` interface, promotion checklist logic, envelope builders, synthetic datasets, the regression harness + pinned baselines |
| Services | `apps/api/src/invariants/` | Stores (+ Drizzle adapters), fail-closed config, the eleven service implementations, data assembly, the fallback runner, the promotion service, the lease-guarded scheduler, router consumers |
| Routes | `apps/api/src/routes/invariants-admin.ts`, `invariants-public.ts` | Steward/analyst surface; public SCOI/MERI reads |
| Tables | `packages/db/src/schema/{events,invariants}.ts` | `invariant_outputs` (envelope + CHECKs), `invariant_promotions`, `invariant_calibrations`, `invariant_run_metadata`, `mfci_cases`, `mfci_margins` (MFCI-4 conditioning records), `mfci_risk_states` (per-target continuity), `scoi_context_actions` (WS-H.4.3d), `bridge_attempts` (WS-H.4.2d) |
| Client | `apps/web/src/components/story/*`, `components/composer/ComposerAffordances/ContextWarning.tsx`, `components/wellbeing/NarrowLoopPrompt`, `signals/topic-loops.ts` | Exposure labels, the independent-sources drawer, interpretation differences, the composer context warning, PHI v0 prompts and controls |

## The numeric kernels (`packages/invariants/src/math/`)

The invariants package has no numeric dependency; the kernels are
first-party with explicit tolerances and tests:

- **Cyclic Jacobi** symmetric eigendecomposition (unconditional convergence,
  deterministic sweep order) — eigenpair residuals are property-tested.
- **LU determinant** with partial pivoting (PHI's `det(H) = ±1` branch).
- **Modified Gram–Schmidt** orthonormalization (random orthogonal
  conjugations for the PHI gauge verifier).
- **Small SVD** via Jacobi on `MᵀM` and the **Kabsch / special-orthogonal
  Procrustes** rotation (det-corrected, degeneracy-flagged) — the PHI pair
  transports.
- **Seeded dense random projection** (JL-style, variance-1/rows entries) —
  embedding dimension reduction that preserves pairwise geometry in
  expectation, replacing first-k truncation.
- **Gelfand spectral radius** by renormalized repeated squaring — the exact
  telescoping identity `2⁻ᵐ log‖A^{2^m}‖ = Σ_{k<m} 2⁻ᵏ log n_k + 2⁻ᵐ log n_m`
  makes the truncation error explicit (Braid entropy).
- **Conjugate gradient** for consistent PSD systems, matrix-free (Hodge
  projections).
- **mulberry32 + FNV-1a seeding** — every stochastic procedure is a pure
  function of (inputs, seed); production seeds derive from
  (target, window, version) so re-runs are idempotent.

## The eleven invariants

### MERI — Matroid Exposure Rank (SPEC §7)

Exposures partition into redundancy classes (exact-URL > near-duplicate >
source-lineage > evidence-lineage > singleton, bounds 1/1/2/2/1), giving a
genuine **partition matroid**: rank is the closed form
`r(S) = Σ_c min(|S∩c|, b_c)` — monotone, submodular (property-tested), and
greedy selection is EXACT (greedy size = brute-force optimum, tested).
The §7.5 gain pseudo-code is implemented in order (duplicate URL → 0;
same claim + lineage → ε; new evidence basis → high; new non-misleading
lens → medium; else marginal rank gain), with the six §7.4 independence
dimensions as scored [0, 1] functions. Contradictory grouping inputs (one
URL group spanning two near-duplicate groups) select the similarity-graph
greedy **fallback**, flagged `MATROID_FALLBACK` with halved confidence and
the 1−1/e / 1/2 guarantees documented in the card.

Data assembly: near-duplicate groups union MinHash/LSH signature collisions
at the configured Jaccard threshold; lineage groups union confirmed
syndication edges and shared outermost publisher ownership; evidence groups
come from claim/evidence `independence_group_id`. The WS-E
`hooks.redundancy` seam is closed from the latest stored marginal gains
(synchronous cached read, background refresh).

### MFCI — Markov-Fiber Coordination (SPEC §8)

The observed table spans `user_group × topic × time_bucket × action_type ×
target` with the **privacy-preserving group axis = account-age bucket**
(never an identity). All 1-way margins are the sufficient statistics of the
complete-independence log-linear null, so the conditional reference
distribution on the fiber is exactly `π(X) ∝ ∏ 1/x_c!` (the generalized
hypergeometric — the factorizing `∏ p_c^{x_c}` term is constant on the
fiber). The **Markov basis** is the degree-2 coordinate-subset swap family
(complete independence is decomposable), verified connected by brute-force
fiber enumeration in tests. The Metropolis–Hastings sampler proposes
uniformly from the fixed (cell, cell, subset) space (symmetric; lazy
self-loops on degenerate draws) with acceptance
`min(1, x_u·x_v / ((x_{w1}+1)(x_{w2}+1)))`; every retained state provably
shares the margins with nonnegative integers, and the chain's stationary
law is verified DISTRIBUTIONALLY: visit frequencies on small enumerable
fibers pass a χ² test against the exact generalized hypergeometric (2-way
and 3-axis fibers, deterministic seeds). `p̂` uses the §8.2 add-one
estimator; `MFCI = −log p̂` is always finite. The three statistics
(synchrony, target concentration, phrase repetition) are quadratic
concentration functionals of 2-way flattenings — exactly what 1-way margins
do not fix.

Attribution is **per target** (`fiberTestMulti`): one shared fiber per
window carries every target, the conditional null staying global (the
system's group sizes, topic popularity, temporal pattern, action mix,
per-target volumes), while each target's statistic is the
target-restricted quadratic mass `T_t = Σ_pair count(pair, t)²` — its own
margin fixes `Σ_pair count(pair, t)` but not the split, so `T_t` varies on
the fiber and `Σ_t T_t` equals the global statistic (tested). A burst
target scores extreme relative to its OWN fixed volume; a quiet neighbor
in the same window scores ~0 instead of inheriting the global signal.
`fixed_margins_ref` is one content-addressed reference per window, shared
by every output it conditioned.

The sub-minute path (MFCI-3) uses volume-conditioned cheap statistics
against versioned null calibrations (`invariant_calibrations`); stale
calibrations flag `NULL_CALIBRATION_STALE` and halve confidence; the
synchrony statistic counts **cross-actor** clustering only. Anomalies open
identifier-free cases in `mfci_cases` (analyst + appeal rationales,
MFCI-4 margins reference); analyst **clearing lifts the safety freeze**
(WS-H.3.3d) through the same audited WS-E path.

Risk states have **durable per-target continuity** (`mfci_risk_states`):
the cheap path and the batch tier both move states through the one
`nextRiskState` transition function — upward follows the score
immediately (no convergence evidence required), downward is HELD unless a
CONVERGED exact fiber test scored the target at the null
(`fiber_cleared`) or an analyst cleared the case (`analyst_override`,
applied by the resolve endpoint) — a freeze never silently melts, and an
unconverged sampler can never melt one. The conditioning itself is
persisted (`mfci_margins`): every output's `fixed_margins_ref` is a
content-addressed reference that dereferences via
`GET /v1/invariants/admin/mfci/margins/:ref` to the exact axes, 1-way
margins, and table total the decision conditioned on (MFCI-4).

### GWEI — Gromov–Wasserstein Experience Isometry (SPEC §9)

Cohorts (locale, tenure — derived only from user-provided metadata) get
metric-measure spaces from owned attention aggregates joined to stories;
`d` is a validated pseudometric (weighted semantic/source/evidence/community
relations), `μ` the normalized exposure share. The solver is
entropic-regularized GW (Peyré–Cuturi–Solomon): log-domain Sinkhorn (no
kernel underflow), coupling **rounding** onto Π(a, b) (Altschuler–Weed–
Rigollet) so the reported objective is EXACT through the marginal
decomposition and a true **upper bound** on GW₂². Stability runs across
seeds × regularization report `[ci_low, ci_high]`. The seven §9.4
experience metrics are exposure-weighted aggregates (diversities as
effective numbers); **k-anonymity suppression** withholds below-threshold
cohorts with `SUPPRESSED_K_ANONYMITY` before any surface; the release-gate
decision function (WS-H.5.2c) blocks protected-cohort degradation absent a
documented sign-off; the transparency export publishes parity statements
only (`parity_within_threshold` / `degradation_under_review` /
`withheld_small_cohort`) — never cohort metrics.

### SCOI — Sheaf Context Obstruction (SPEC §10)

Lenses are vertices of the overlap graph; interpretations are unit-ball
vectors (the v1 capture: unit-normalized mean embeddings of recent
lens-tagged contribution bodies); restriction maps are the configured
identity projections into the shared comparison space (per-pair learned
maps are the v2 path — documented in the card). The score is the
normalized Dirichlet energy `‖d₀s‖² / Σ_e (σ_i+σ_j)²` ∈ [0, 1] (the
normalizer is the per-overlap maximal-disagreement bound, attained in the
identity configuration; 0 ⇔ the readings glue, s ∈ ker d₀; the Laplacian
is PSD by construction, property-tested). Context states map by threshold;
**weaponized requires a safety signal** — disagreement alone never produces
it. SCOI v2 (`h1.ts`) computes the structural obstruction: `dim H¹ =
dim C¹ − rank d₀` from the restriction maps alone, plus the harmonic
representative norm of an observed pairwise-disagreement cochain (the part
no choice of readings can explain) — emitted on every batch output
(`dim_h1`, `structural_obstruction`, reason-coded
`STRUCTURAL_OBSTRUCTION`).

**Context surfaces** (`scoi-actions.ts`): room stewards get per-room
reports (WS-H.4.1c; scope is the room's OWN steward roster, 404-over-403)
with context state, per-lens interpretation summaries, recommended actions
(invite-bridge/annotate for split/obstructed, safety review for
weaponized), the §10.5 "Bridge attempts" record, and recent context
actions. Moderator context actions (WS-H.4.3d / SCOI-4: merge, annotate,
separate) require a RATIFIED WS-A reason code, are audited
(`scoi_context_action`), and record the measured SCOI before/after.
Annotation is mathematically honest: ONE shared `local_context`
contribution per active lens pulls every interpretation vector toward the
same point, so the Dirichlet energy genuinely decreases — measured by
re-computation, never asserted (the acceptance test pins the decrease on a
synthetic split case). Merge/separate are audited records whose physical
tree mechanics belong to WS-G/WS-J tooling. Bridge routing (WS-H.4.2d /
SCOI-2): candidates are multi-lens participants; an open request carries
the SCOI baseline, and the durable `invariant-scoi-bridge` consumer
credits a contribution (single-shot) when re-computation measures a real
decrease — credit lands in the DESCRIPTIVE reputation summary
(`bridge_ability`), never a wallet, never a ranking input. Notification
dispatch is a later seam; routing produces records only, so spam is
impossible by construction.

### PHI — Preference Holonomy (SPEC §11)

Transports are **pair-specific** (`phi/transports.ts`) — this is what makes
holonomy non-vacuous. Any per-topic frame family `A_xy = F_y F_xᵀ`
telescopes to the identity around EVERY closed loop (`F_k F_{k−1}ᵀ ⋯ F_1
F_0ᵀ = I`: flat by construction — the flat-connection theorem, proven
executable in `phi-transports.test.ts`). Instead, each topic context
carries a **behavioral structure** `T_x` — the √λ-weighted leading
principal directions of its recent content embeddings in a shared seeded
projection space — and each leg's transport is the **Kabsch
(special-orthogonal Procrustes) rotation of the pair's cross-Gram**
`T_yᵀT_x`. The polar factor of a product does not factor through the
individual structures, so loops over ≥ 3 distinct topics pick up genuine
connection curvature; identical structures and out-and-back walks stay
exactly trivial (the connection is symmetric: `A_yx = A_xyᵀ`). Revisit
walks are backtrack-reduced before holonomy (`holonomyCycleFromWalk`):
star-shaped paths bound no area and score PHI 0 honestly with
`cycle_content: false` — never dressed up as a coverage gap. Structures
whose spectrum is unresolved and pairs whose cross-Gram is rank-deficient
yield NO transport (`INSUFFICIENT_COVERAGE`), never an invented one.

Holonomy is the ordered product;
`PHI = ‖log H‖_F = √(2Σθ_k²)` with the rotation angles extracted
**gauge-invariantly** from the spectrum of the symmetric part
`(H + Hᵀ)/2` (conjugation-invariant by construction — the per-topic gauge
`T_x → T_x Q_xᵀ` conjugates H and leaves every reported field unchanged,
including `alignment_conditioning` = σ_min of the loop's worst cross-Gram).
Near rotation-by-π and for orientation-reversing holonomy the robust
`‖H − I‖_F` fallback is used with `MATRIX_LOG_FALLBACK`. Two enforcement
layers protect gauge invariance: the random-conjugation verifier (CI +
promotion evidence) and the output-boundary scan that throws on any
frame-dependent field.

**Privacy by construction:** the session sequence holds an opaque digest
key, topic-cluster ids, timestamps, and the §22.1 aggregate's OWN coarse
buckets (action kind from the source/context booleans, dwell-bucket
midpoint as engagement) — never a story id, never content, never another
user's identity, and no information class beyond what the aggregate
itself already discloses — TTL'd with the session and capped at 200
transitions. The coarse action kinds make the path-signature
`constructive` class REACHABLE (source-seeking sessions classify as such)
while the client tracker (`apps/web/src/signals/topic-loops.ts`,
sessionStorage) still stores topic + time only. v0 narrow-loop/compulsive
detection is the same pure math on both the client and the server batch
tier. Sensitive-topic strictness is applied server-side from WS-F
sensitivity labels (a second detection pass at the reduced repeat
threshold, honored when the flagged cluster is sensitive); minor
strictness stays client-side where age is known — the opaque session key
carries no identity to resolve an age band against. Config that would
weaken either (factor > 1) is rejected at write time.

### Supporting invariants (SPEC §12)

- **Hodge** — conversation flows decompose `flow = gradient + curl +
  harmonic` (CG on the consistent normal equations; exact range
  orthogonality from `B₂B₁ = 0`). `HarmfulTensionRisk = harmonicFraction ×
  hostility` is identically zero without a hostility signal (the WS-J seam
  defaults to 0) — structural disagreement alone never penalizes.
- **Tropical** — min-plus earliest arrival is exact (repeated tropical
  squaring); synchronized cascades = near-identical arrivals from ≥ 3
  distinct sources across a topic's content families; the documented
  rank-style feature is the arrival-profile rank (distinct timing columns
  after per-column min subtraction). A DETECTED cascade feeds MFCI: the
  scheduler routes the topic's recent stories through the same
  cheap-statistic intake the WS-E integrity events use (the intake
  re-checks each target and only opens a case when the statistics confirm
  — fail-toward-caution, never an auto-action).
- **Braid** — hourly topic-activity rankings trace strands; adjacent swaps
  (selection-sort decomposition, displacement over/under rule) form the
  word; entropy is the classical homological lower bound
  `log ρ(reduced Burau at t = −1)` in exact integer arithmetic (the
  figure-eight braid σ₁σ₂⁻¹ pins `log φ²`; the braid relation is verified
  on the representation). Manufactured churn and visibility-boundary
  gaming are flagged for stewards.
- **Reeb** — the engagement landscape over the topic-similarity graph
  decomposes into join + split trees (exact for the discretized
  filtration); fragile saddles (few connecting edges) route bridge prompts.
- **CID** — `CID(x, u) = E_g|R(g.x, g.u) − R(x, u)|` over verified
  permutation groups on protected attributes; the v0 freshness ranking is
  certified attribute-blind (CID = 0); the release-gate decision blocks
  above-threshold defects (fail closed on a missing audit).
- **Path-signature** — depth-3 truncated signatures via Chen's identity
  (exact for piecewise-linear session paths; collinear-midpoint invariance
  and order sensitivity are tested); session-health classification
  (constructive/casual/narrowing/compulsive/rage) reads event kinds, topic
  ordinals, and timing only.

## Platform mechanics

- **Fallback wrapper (WS-H.1.2c).** Every computation runs under
  `runGuarded`: timeout + try/catch → a degraded envelope
  (`TIMEOUT`/`COMPUTE_ERROR`, confidence 0, empty vector) + a gap record
  (structured log + `invariants.gap.<type>` metric + an
  `invariant_run_metadata` row). Ranking proceeds with failed invariants'
  features OMITTED — never defaulted — proven with one, two, and all eleven
  failing.
- **Tiers and back-pressure (WS-H.1.2f).** Services declare their tiers;
  batch-only invariants answer real-time calls with an honest degraded
  output. The hourly batch tier runs under the `invariants_hourly` Postgres
  lease through a bounded-concurrency mapper (`invariants.batchConcurrency`)
  so batch work cannot starve real-time computation.
- **Observability (WS-H.1.2g).** A uniform `HealthRecorder` per invariant
  (latency percentiles, error count, mean coverage, fallback rate, output
  count, last success) + per-run metadata rows, surfaced on
  `GET /v1/invariants/admin/health`.
- **Regression + drift (WS-H.1.2d/d-2).** Deterministic synthetic datasets
  per invariant (analytic expected outputs where derivable: MERI 5/6,
  SCOI {0, ½, 1}, PHI √2·θ anchors, braid log(2+√3), CID {0, ½}; pinned
  seeded baselines for MFCI/GWEI) run in CI as part of the test suite and
  nightly at 00 UTC on the scheduler, with per-invariant tolerances
  (MERI 0.01, MFCI p̂ 0.05, GWEI within its stability interval, PHI 0.01).
  Updating a baseline is a reviewed code change. UPWARD promotions are
  additionally regression-gated at apply time: a drifting invariant can
  never gain authority, while demotions (the kill switch) are never
  blocked by the gate.
- **Real-time tier (WS-H.1.2f).** `runRealtimeTier` is the budget-enforced
  entry point: the configured `realtimeLatencyBudgetMs` is the runGuarded
  timeout, so a slow computation degrades (TIMEOUT, feature ABSENT) instead
  of stalling the caller; health and run metadata are observed on the same
  per-invariant recorders as batch. WS-I consumes this at the ranking
  boundary.
- **Calibration rebuild (WS-H.3.1a).** Nightly at 00 UTC the scheduler
  rebuilds the MFCI null calibrations from the trailing week's ORGANIC
  hourly windows (same window size and action source the intake scores
  against), versioned `auto:<date>`; a too-thin baseline keeps the
  previous calibration rather than replacing it with noise.
- **Config (fail closed).** All tunables live under `invariants.*` keys in
  the shared runtime-config store; every stored value validates on load
  (invalid → rejected + logged + default kept) and at write time (422).
  Every persisted output additionally carries its invariant's CONFIG
  SNAPSHOT in `version_metadata.config`, so WS-H.1.1b version comparisons
  can tell algorithm drift from configuration drift.
- **Run visibility.** WS-H batch/real-time executions are observable
  through `invariant_run_metadata` + the health surface;
  `invariant.run.completed` remains the WS-E PWAtt scoring pipeline's
  per-item/window contract (emitting it from WS-H too would double-fire
  the WS-F lifecycle triggers under different event ids).

## Surfaces

Steward/analyst (`/v1/invariants/admin/*`, steward + per-session MFA):
health, reason-code-filterable outputs, WS-H.1.1b version comparison
(time-window bounded), the observational MFCI dashboard (no enforcement
controls) + case resolution, GWEI dashboards + the transparency export,
promotion apply/history, validated config writes, on-demand regression.

Public reads (`/v1/stories/:id/interpretations`,
`/v1/stories/:id/independent-sources`): visibility-gated (404-over-403),
served from STORED shadow outputs only — a page load never triggers
computation.

Client: `ExposureLabel` (four §7.6 labels), `IndependentSourcesDrawer`,
`WhereInterpretationsDiffer` (+ the needs-context framing), the composer
`ContextWarning` (dismissible; the user can always proceed), the
`NarrowLoopPrompt` (non-blocking; "see broader context" switches to the
source-diverse feed mode), and the PHI-4 wellbeing controls ("Reset topic
history" clears the device-local sequence only; "Reduce personalization"
switches the feed mode) — plus the per-topic repeats preference stored in
personalization settings (`topic_repeat_preference`, consumed by ranking
once WS-I lands).

## Testing

- `packages/invariants`: 330+ unit/property tests — matroid
  monotonicity/submodularity and greedy-vs-brute-force exactness, fiber
  connectivity by enumeration, sampler margin/nonnegativity invariants,
  Jacobi eigenpair residuals, Sinkhorn marginals + rounding exactness,
  Helmholtz orthogonality, Chen-identity exactness, gauge invariance under
  random conjugation, the regression suite against pinned baselines (an
  intentional drift is flagged with its magnitude).
- `apps/api`: platform tests (wrapper, promotion, config, scheduler,
  shadow/ranking boundary), service tests on seeded WS-D/E/F/G data
  (including the real MinHash near-duplicate path and the full SCOI lens
  pipeline), admin/public route tests, and **gated** Drizzle integration
  tests (DATABASE_URL) that run the real migration chain — including a
  live-Postgres proof of the 0009 `time_window` text→jsonb USING
  conversion. CI's service containers run the gated suites.
- `apps/web`: component tests with axe audits + the topic-loop tracker's
  privacy/cap/reset/corruption suites.

## Residuals (tracked elsewhere)

- **WS-I** consumes promoted invariants at the ranking boundary (MERI
  dampening, MFCI risk-state effects, SCOI context gates, PHI dampening
  with the deliberate-choice override, the per-topic repeats threshold);
  until then every effect is computed-and-logged only.
- **WS-J** takes ownership of the analyst queue UX and supplies the
  hostility signal behind the Hodge seam (defaults to 0) and the appeals
  flow that surfaces `mfci_cases.appeal_summary` and the
  `scoi_context_actions` records (every moderator context action is
  already reason-coded and audited for it). Physical thread merge/split
  tree mechanics ride WS-G/WS-J moderation tooling; until then merge/
  separate are audited records surfaced on the steward report.
- **WS-K** owns learned restriction maps (SCOI v2 estimation), the
  framing/misleading classifiers MERI's semantic dimension awaits, and
  governed summary generation.
- **Notification dispatch** for bridge invitations awaits a platform
  dispatch path (`notification.sent` has no in-repo producer); bridge
  routing produces records for steward visibility only.
- **WS-P** wires the GWEI release gate and the CID model-release gate into
  the experiment framework, and owns the transparency-report pipeline the
  export feeds.
