// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H.1.2b — the eleven invariant cards.
//
// Every card is validated against `invariantCardSchema` at boot (a malformed
// card fails startup, not a 3am page) and snapshot-tested so an unreviewed
// change fails CI. `shadow_status` here is the DOCUMENTED DEFAULT — the live
// status is resolved from the append-only promotion record (WS-H.1.2e), and
// all eleven ship in shadow.

import { type InvariantCard, InvariantType, invariantCardSchema } from '@licio/invariants';

const OWNER = 'ranking-invariants';

const card = (input: InvariantCard): InvariantCard => invariantCardSchema.parse(input);

export const INVARIANT_CARDS: Readonly<Record<InvariantType, InvariantCard>> = {
  [InvariantType.MERI]: card({
    invariant_type: InvariantType.MERI,
    owner: OWNER,
    version: '1.0.0',
    input_schema: 'docs/invariants/README.md#meri-inputs',
    output_schema: 'meriScoreVectorSchema (@licio/invariants)',
    confidence_bounds: { min: 0.3, typical: 0.85, max: 1 },
    coverage_bounds: { min_acceptable: 0.5, typical: 0.9 },
    coverage_definition:
      'Fraction of candidate exposures with canonical URL, claim extraction, source lineage, evidence grouping, and embedding all available and fresh.',
    known_failure_modes: [
      {
        mode: 'contradictory grouping inputs (one URL group spanning two near-duplicate groups)',
        impact: 'the partition matroid would mis-model rank',
        mitigation: 'similarity-graph greedy fallback, flagged MATROID_FALLBACK, confidence halved',
      },
      {
        mode: 'missing claim/lineage inputs for many candidates',
        impact: 'independence under-detected; rank biased toward singleton classes',
        mitigation:
          'coverage drops; below min_acceptable emits INSUFFICIENT_COVERAGE (never enforced)',
      },
    ],
    fallback_behavior:
      'Greedy independent set in the pairwise-similarity system; output flagged as approximation; ranking omits MERI features rather than defaulting.',
    approximation_notes:
      'The exact path is the partition matroid (greedy = exact rank). The fallback greedy carries the standard 1−1/e cardinality and 1/2 matroid-constraint guarantees.',
    shadow_status: 'shadow',
    dependencies: [
      'WS-F dedup groups',
      'WS-F source profiles/syndication',
      'WS-F claims/evidence',
      'WS-F embeddings',
    ],
  }),
  [InvariantType.MFCI]: card({
    invariant_type: InvariantType.MFCI,
    owner: OWNER,
    version: '1.0.0',
    input_schema: 'docs/invariants/README.md#mfci-inputs',
    output_schema: 'mfciScoreVectorSchema (@licio/invariants)',
    confidence_bounds: { min: 0.2, typical: 0.8, max: 1 },
    coverage_bounds: { min_acceptable: 0.5, typical: 0.95 },
    coverage_definition:
      'Fraction of in-window actions carrying all five table dimensions (actor group, topic, time bucket, action type, target).',
    known_failure_modes: [
      {
        mode: 'sampler non-convergence (low effective sample size)',
        impact: 'p-value estimate unreliable',
        mitigation:
          'SAMPLER_NONCONVERGENCE reason code; confidence reduced; analyst sees diagnostics',
      },
      {
        mode: 'stale null calibrations on the cheap path',
        impact: 'sub-minute scores mis-calibrated',
        mitigation:
          'NULL_CALIBRATION_STALE; confidence halved; exact fiber test confirms or clears',
      },
    ],
    fallback_behavior:
      'On failure no risk-state change occurs (downward transitions need clearing evidence); ranking omits MFCI features.',
    approximation_notes:
      'The conditional p-value is Monte-Carlo estimated over the Markov-basis fiber chain (add-one estimator); ESS and acceptance rate are reported per run.',
    shadow_status: 'shadow',
    dependencies: ['WS-E event pipeline', 'WS-E integrity signals'],
  }),
  [InvariantType.GWEI]: card({
    invariant_type: InvariantType.GWEI,
    owner: OWNER,
    version: '1.0.0',
    input_schema: 'docs/invariants/README.md#gwei-inputs',
    output_schema: 'gweiScoreVectorSchema (@licio/invariants)',
    confidence_bounds: { min: 0.2, typical: 0.7, max: 0.95 },
    coverage_bounds: { min_acceptable: 0.5, typical: 0.85 },
    coverage_definition:
      'Fraction of compared cohorts at or above the minimum cohort size with exposure samples in the window.',
    known_failure_modes: [
      {
        mode: 'cohort below the k-anonymity threshold',
        impact: 'metrics could expose a small group',
        mitigation:
          'SUPPRESSED_K_ANONYMITY: values withheld (distinguishable from zero) before any surface',
      },
      {
        mode: 'entropic solver stuck at a poor local coupling',
        impact: 'distance over-estimated',
        mitigation:
          'multi-seed/multi-ε runs; the reported value is the best upper bound with its stability interval',
      },
    ],
    fallback_behavior:
      'Missing cohort data degrades to INSUFFICIENT_COVERAGE; the release gate treats an absent audit as blocking, never as a pass.',
    approximation_notes:
      'Exact GW is NP-hard; production uses entropic-regularized GW on sampled cohort windows. Every reported distance is a feasible-coupling UPPER bound with a [ci_low, ci_high] seed/regularization stability interval.',
    shadow_status: 'shadow',
    dependencies: [
      'WS-D user metadata (locale, age band, registration)',
      'WS-E attention aggregates',
      'WS-F stories/embeddings',
    ],
  }),
  [InvariantType.SCOI]: card({
    invariant_type: InvariantType.SCOI,
    owner: OWNER,
    version: '1.0.0',
    input_schema: 'docs/invariants/README.md#scoi-inputs',
    output_schema: 'scoiScoreVectorSchema (@licio/invariants)',
    confidence_bounds: { min: 0.2, typical: 0.75, max: 1 },
    coverage_bounds: { min_acceptable: 0.4, typical: 0.8 },
    coverage_definition:
      'Fraction of the story’s lenses with enough recent discussion to carry an interpretation vector.',
    known_failure_modes: [
      {
        mode: 'fewer than two lenses with interpretations',
        impact: 'no overlap to measure; SCOI undefined',
        mitigation: 'INSUFFICIENT_COVERAGE degraded output; no context state asserted',
      },
      {
        mode: 'embedding provider unavailable',
        impact: 'interpretation vectors cannot be built',
        mitigation: 'degraded output; lens capture resumes when the provider returns',
      },
    ],
    fallback_behavior:
      'Ranking proceeds without context gating; the "Needs Context" label is withheld rather than guessed.',
    approximation_notes:
      'v1 restriction maps are configured identity projections into the shared comparison space (per-pair learned maps are the v2 path); the normalizer is the per-overlap maximal-disagreement bound Σ(σ_i+σ_j)², attained for the identity configuration.',
    shadow_status: 'shadow',
    dependencies: ['WS-G lenses/contributions', 'WS-F embeddings'],
  }),
  [InvariantType.PHI]: card({
    invariant_type: InvariantType.PHI,
    owner: OWNER,
    version: '1.0.0',
    input_schema: 'docs/invariants/README.md#phi-inputs',
    output_schema: 'phiScoreVectorSchema (@licio/invariants)',
    confidence_bounds: { min: 0.2, typical: 0.7, max: 0.95 },
    coverage_bounds: { min_acceptable: 0.5, typical: 0.9 },
    coverage_definition:
      'Fraction of the loop path’s topic contexts with a current orthonormal frame (embedding-derived).',
    known_failure_modes: [
      {
        mode: 'holonomy near rotation-by-π or orientation-reversing',
        impact: 'principal matrix log ill-conditioned/undefined',
        mitigation: 'robust ‖H−I‖_F fallback with MATRIX_LOG_FALLBACK (SPEC §11.2 note)',
      },
      {
        mode: 'frame-dependent value reaching the output boundary',
        impact: 'gauge invariance broken; summaries basepoint-dependent',
        mitigation:
          'boundary scan throws (build-failing); conjugation verification runs in CI and as promotion evidence',
      },
    ],
    fallback_behavior:
      'Loop detection (v0) continues without holonomy scores; wellbeing prompts never block; ranking omits PHI features.',
    approximation_notes:
      'Frames are estimated from topic-context embedding structure (Gram–Schmidt orthonormalized); transports are exact orthogonal Procrustes between frames; PHI summaries are spectral (conjugation-invariant) by construction.',
    shadow_status: 'shadow',
    dependencies: [
      'WS-E attention aggregates (session-bucketed)',
      'WS-F topics/sensitivity labels',
      'WS-F embeddings',
    ],
  }),
  [InvariantType.HodgeTension]: card({
    invariant_type: InvariantType.HodgeTension,
    owner: OWNER,
    version: '1.0.0',
    input_schema: 'docs/invariants/README.md#hodge-inputs',
    output_schema: 'hodgeScoreVectorSchema (@licio/invariants)',
    confidence_bounds: { min: 0.3, typical: 0.8, max: 1 },
    coverage_bounds: { min_acceptable: 0.3, typical: 0.8 },
    coverage_definition:
      'Fraction of thread contributions with resolvable participant interaction edges.',
    known_failure_modes: [
      {
        mode: 'hostility classifier unavailable',
        impact: 'HarmfulTensionRisk cannot be computed',
        mitigation:
          'risk pinned to 0 (harmonic tension alone NEVER penalizes); labels still descriptive',
      },
    ],
    fallback_behavior: 'Thread labels withheld; no moderator routing from this invariant.',
    approximation_notes:
      'Helmholtz projections are solved by conjugate gradient on the consistent normal equations (documented tolerance 1e-12 relative); component orthogonality is exact in the operator ranges.',
    shadow_status: 'shadow',
    dependencies: ['WS-G threads/contributions', 'WS-J hostility signal (seam; defaults to 0)'],
  }),
  [InvariantType.TropicalCascade]: card({
    invariant_type: InvariantType.TropicalCascade,
    owner: OWNER,
    version: '1.0.0',
    input_schema: 'docs/invariants/README.md#tropical-inputs',
    output_schema: 'tropicalScoreVectorSchema (@licio/invariants)',
    confidence_bounds: { min: 0.2, typical: 0.6, max: 0.9 },
    coverage_bounds: { min_acceptable: 0.3, typical: 0.7 },
    coverage_definition:
      'Fraction of the topic’s content families reached by at least two distinct sources.',
    known_failure_modes: [
      {
        mode: 'fewer than three independent seeds',
        impact: 'synchrony is not meaningful',
        mitigation: 'detection withheld (confidence 0) below the seed floor',
      },
    ],
    fallback_behavior: 'No detection emitted; MFCI receives no supplementary timing features.',
    approximation_notes:
      'Earliest arrival is EXACT in the min-plus semiring. The documented tropical-rank-style feature is the arrival-profile rank: distinct timing-matrix columns after per-column min subtraction, clustered within the tolerance.',
    shadow_status: 'shadow',
    dependencies: ['WS-F stories/sources/dedup families'],
  }),
  [InvariantType.BraidDynamics]: card({
    invariant_type: InvariantType.BraidDynamics,
    owner: OWNER,
    version: '1.0.0',
    input_schema: 'docs/invariants/README.md#braid-inputs',
    output_schema: 'braidScoreVectorSchema (@licio/invariants)',
    confidence_bounds: { min: 0.3, typical: 0.7, max: 0.95 },
    coverage_bounds: { min_acceptable: 0.5, typical: 0.9 },
    coverage_definition:
      'Fraction of tracked windows with a complete topic-activity ranking snapshot.',
    known_failure_modes: [
      {
        mode: 'topic set churn between snapshots (strands appearing/disappearing)',
        impact: 'strand identity breaks; the braid word is undefined',
        mitigation:
          'tracking restricted to the persistent topic set; coverage reflects the restriction',
      },
    ],
    fallback_behavior: 'No churn/gaming flags emitted for the affected windows.',
    approximation_notes:
      'Entropy is the classical homological LOWER bound log ρ(reduced Burau at t = −1) — exact integer arithmetic; over/under signs follow the documented displacement convention (rank data carries no physical crossing).',
    shadow_status: 'shadow',
    dependencies: ['WS-E aggregation windows (activity ranking until WS-I positions land)'],
  }),
  [InvariantType.ReebLandscape]: card({
    invariant_type: InvariantType.ReebLandscape,
    owner: OWNER,
    version: '1.0.0',
    input_schema: 'docs/invariants/README.md#reeb-inputs',
    output_schema: 'reebScoreVectorSchema (@licio/invariants)',
    confidence_bounds: { min: 0.3, typical: 0.7, max: 0.95 },
    coverage_bounds: { min_acceptable: 0.4, typical: 0.8 },
    coverage_definition:
      'Fraction of in-window stories with an engagement scalar and topic adjacency.',
    known_failure_modes: [
      {
        mode: 'sparse adjacency (isolated stories)',
        impact: 'every story is its own basin; saddles vanish',
        mitigation: 'low coverage reported; bridge prompts not emitted',
      },
    ],
    fallback_behavior: 'No basin structure stored for the window.',
    approximation_notes:
      'The landscape is the join tree + split tree of the discretized scalar (level set components at the sorted distinct values) — exact for the graph filtration; it approximates the continuous Reeb graph by discretization only.',
    shadow_status: 'shadow',
    dependencies: ['WS-E aggregation windows', 'WS-F topics'],
  }),
  [InvariantType.CounterfactualDefect]: card({
    invariant_type: InvariantType.CounterfactualDefect,
    owner: OWNER,
    version: '1.0.0',
    input_schema: 'docs/invariants/README.md#cid-inputs',
    output_schema: 'cidScoreVectorSchema (@licio/invariants)',
    confidence_bounds: { min: 0.5, typical: 0.9, max: 1 },
    coverage_bounds: { min_acceptable: 0.8, typical: 1 },
    coverage_definition:
      'Fraction of the audited representation set evaluated under every group element.',
    known_failure_modes: [
      {
        mode: 'ranking function unavailable or non-finite under a transformation',
        impact: 'defect cannot be certified',
        mitigation:
          'COMPUTE_ERROR degraded output; the release gate treats a missing audit as blocking',
      },
    ],
    fallback_behavior: 'Model-release gate blocks on a missing CID audit (fail closed).',
    approximation_notes:
      'CID is the exact mean over the generated finite transformation group (bounded closure of the configured generators); no sampling is involved at current group sizes.',
    shadow_status: 'shadow',
    dependencies: [
      'WS-I ranking function (v0 freshness ranking until then)',
      'WS-D protected-attribute taxonomy',
    ],
  }),
  [InvariantType.PathSignatureWellbeing]: card({
    invariant_type: InvariantType.PathSignatureWellbeing,
    owner: OWNER,
    version: '1.0.0',
    input_schema: 'docs/invariants/README.md#pathsig-inputs',
    output_schema: 'pathSignatureScoreVectorSchema (@licio/invariants)',
    confidence_bounds: { min: 0.3, typical: 0.75, max: 0.95 },
    coverage_bounds: { min_acceptable: 0.5, typical: 0.9 },
    coverage_definition:
      'Fraction of session events carrying the closed action-kind enum and a topic ordinal.',
    known_failure_modes: [
      {
        mode: 'session shorter than two events',
        impact: 'no path; the signature is trivial',
        mitigation: 'classified casual with low confidence; no stopping cue',
      },
    ],
    fallback_behavior: 'No stopping cue emitted; PHI v0 heuristics continue independently.',
    approximation_notes:
      'Signatures are EXACT for piecewise-linear session paths (Chen’s identity, depth-3 truncation documented); classification thresholds are heuristic and logged for review.',
    shadow_status: 'shadow',
    dependencies: ['WS-E session event data (topic ordinals, action kinds, timing only)'],
  }),
};

/** Boot-time guard: every card parses (called from the service container). */
export function validateAllCards(): void {
  for (const card of Object.values(INVARIANT_CARDS)) {
    invariantCardSchema.parse(card);
  }
}
