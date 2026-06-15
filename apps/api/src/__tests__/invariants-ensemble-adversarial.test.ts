// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The ENSEMBLE adversarial suite (the named `check:adversarial` gate). The
// per-invariant purpose suite proves each invariant fulfils its own purpose in
// ISOLATION; this suite proves the ENSEMBLE property the open-source threat
// model rests on: evading one invariant trips another, because the invariants
// measure orthogonal — and contradictory — facets of the same attack. Each
// scenario maps to an entry in `docs/invariants/ADVERSARIAL-THREATS.md`.
//
// The cross-invariant correlation is a property of the MATHEMATICS, so these
// scenarios mostly drive the pure `@licio/invariants` functions directly
// (deterministic, no clock/IO); a few drive the equally-pure api-layer
// detectors that complete a defense (e.g. the account-age-weighted burst
// detector). The platform WIRING that feeds them is covered by
// `invariants-platform`/`invariants-services`/`demo-seed-showcase`. Each later
// hardening PR adds the scenario its defense makes pass.

import {
  type AttributePermutation,
  buildMetricMeasureSpace,
  buildSparseTable,
  buildTimingMatrix,
  computeMeri,
  contextStateForScore,
  counterfactualInvarianceDefect,
  detectNarrowLoop,
  detectSynchronizedCascade,
  detectThresholdHugging,
  entropicGw,
  evaluateReleaseGate,
  fiberTest,
  fiberTestMulti,
  type GweiItemFeatures,
  generateGroup,
  holonomy,
  type Matrix,
  type MeriCandidateInput,
  phiScore,
  type SheafStructure,
  scoiEnergy,
} from '@licio/invariants';
import { describe, expect, it } from 'vitest';
import { detectCoordinatedBurst } from '../pwatt/anti-signals.js';

const MERI_FULL_INPUTS = {
  canonicalUrl: true,
  claimExtraction: true,
  sourceLineage: true,
  evidence: true,
  embedding: true,
} as const;
function meriCand(id: string, extra: Partial<MeriCandidateInput> = {}): MeriCandidateInput {
  return { id, urlGroupId: `url-${id}`, inputsAvailable: { ...MERI_FULL_INPUTS }, ...extra };
}

const MFCI_AXES = [
  { name: 'user_group', labels: ['g1', 'g2', 'g3'] },
  { name: 'topic', labels: ['t1', 't2'] },
  { name: 'time_bucket', labels: ['b1', 'b2', 'b3'] },
  { name: 'action_type', labels: ['report', 'reply'] },
  { name: 'target', labels: ['x', 'y'] },
];
const mfciTable = (rows: string[][]) =>
  buildSparseTable(
    MFCI_AXES,
    rows.map((labels) => ({ labels })),
  );
const SAMPLER = { samples: 600, burnIn: 600, thinning: 2, seed: 7 } as const;

function gweiItem(id: string, semantic: number[], sourceKey: string): GweiItemFeatures {
  return { itemId: id, semantic, sourceKey, evidenceKeys: [], communityKeys: ['c'], weight: 1 };
}

// ---------------------------------------------------------------------------
// 1. Sybil brigade — the attacker faces a dilemma: CONCENTRATE the actions
//    (one account-cluster, one time bucket) and MFCI's target-concentration
//    flags it; or SPREAD across accounts to look diffuse to MFCI, but then the
//    synchronized TIMING needed for impact trips Tropical. Desync + spread
//    forfeits the coordinated impact entirely. (Catalog §1.)
// ---------------------------------------------------------------------------
describe('ensemble: a Sybil brigade cannot evade both MFCI and Tropical', () => {
  it('a CONCENTRATED brigade (one cell) is flagged by MFCI target-concentration', () => {
    // 14 actions on x from one account-group in one time bucket — a coordinated
    // cluster; y is ordinary background.
    const concentrated = mfciTable([
      ...Array.from({ length: 18 }, () => ['g1', 't1', 'b1', 'reply', 'x']),
      ['g2', 't2', 'b2', 'reply', 'y'],
      ['g3', 't1', 'b3', 'reply', 'y'],
      ['g2', 't2', 'b1', 'reply', 'y'],
    ]);
    expect(fiberTest(concentrated, 'target_concentration', SAMPLER).pHat).toBeLessThan(0.1);
  });

  it('SPREADING across accounts dodges MFCI, but the synchronized timing trips Tropical', () => {
    // The attacker diffuses the 14 x-actions across 3 account-groups × 3 time
    // buckets so x looks un-concentrated to MFCI (high p̂, evades) ...
    const spread = mfciTable([
      ...Array.from({ length: 14 }, (_, i) => [
        `g${(i % 3) + 1}`,
        't1',
        `b${(i % 3) + 1}`,
        'report',
        'x',
      ]),
      ['g2', 't2', 'b2', 'reply', 'y'],
      ['g3', 't1', 'b3', 'reply', 'y'],
      ['g1', 't2', 'b1', 'reply', 'y'],
    ]);
    const x = fiberTestMulti(spread, 'target_concentration', ['x', 'y'], SAMPLER).perTarget.find(
      (t) => t.targetLabel === 'x',
    );
    expect(x?.pHat ?? 0).toBeGreaterThan(0.3); // evades MFCI

    // ... but to have impact the diffuse accounts must still arrive in lockstep,
    // which Tropical's arrival-time geometry catches.
    const synchronized = buildTimingMatrix(
      ['a1', 'a2', 'a3', 'a4'].flatMap((seedId) =>
        ['n1', 'n2', 'n3'].map((nodeId) => ({ seedId, nodeId, arrivalMs: 1000 })),
      ),
    );
    expect(detectSynchronizedCascade(synchronized).detected).toBe(true);
  });

  it('raises the cost: a FRESH-account brigade is flagged at a volume an AGED one is not', () => {
    // WS-O.4.5 account-age weighting: the same borderline burst volume (11, no
    // history → threshold 4×3 = 12) is NOT a burst for an established community
    // but IS for a throwaway-account brigade (trust 0.5 → threshold 6).
    const burst = { eventCount: 11, distinctActors: 6, trailingEventCounts: [] as number[] };
    expect(detectCoordinatedBurst({ ...burst, trustFactor: 1 }).detected).toBe(false);
    expect(detectCoordinatedBurst({ ...burst, trustFactor: 0.5 }).detected).toBe(true);
  });

  it('an organic, evenly spread, desynchronized community is flagged by NEITHER', () => {
    const organic = mfciTable([
      ['g1', 't1', 'b1', 'report', 'x'],
      ['g2', 't2', 'b2', 'reply', 'y'],
      ['g3', 't1', 'b3', 'report', 'y'],
      ['g1', 't2', 'b2', 'reply', 'x'],
      ['g2', 't1', 'b1', 'report', 'y'],
      ['g3', 't2', 'b3', 'reply', 'x'],
      ['g1', 't1', 'b2', 'report', 'y'],
      ['g2', 't2', 'b1', 'reply', 'x'],
    ]);
    expect(fiberTest(organic, 'target_concentration', SAMPLER).pHat).toBeGreaterThan(0.3);
    const diffuse = buildTimingMatrix(
      ['a1', 'a2', 'a3'].flatMap((seedId, s) =>
        ['n1', 'n2', 'n3'].map((nodeId, n) => ({
          seedId,
          nodeId,
          arrivalMs: 1000 + s * 900_000 + n * 350_000 + s * n * 120_000,
        })),
      ),
    );
    expect(detectSynchronizedCascade(diffuse).detected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Paraphrase / near-duplicate flood — distinct URLs evade exact-URL dedup,
//    the shared claim/lineage classes still bound MERI exposure. (Catalog §2.)
// ---------------------------------------------------------------------------
describe('ensemble: a paraphrase flood with distinct URLs stays exposure-bounded', () => {
  it('8 distinct-URL reposts of one claim count as ≤ 2 independent exposures', () => {
    const flood = computeMeri(
      Array.from({ length: 8 }, (_, i) =>
        // Distinct exact URLs (urlGroupId differs) — the attacker beats exact-URL
        // dedup — but a shared claim AND source lineage bound independence.
        meriCand(`p${i}`, { sourceLineageGroupId: 'one-owner', claimGroupId: 'one-claim' }),
      ),
    );
    expect(flood.selectedIds.length).toBeLessThanOrEqual(2);
    expect(flood.meri).toBeLessThanOrEqual(0.3);
  });

  it('genuinely independent coverage of the same topic is NOT suppressed', () => {
    const independent = computeMeri(Array.from({ length: 8 }, (_, i) => meriCand(`u${i}`)));
    expect(independent.meri).toBe(1);
    expect(independent.selectedIds.length).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// 3. Context-collapse exploitation — manufactured cross-lens divergence raises
//    SCOI but NEVER weaponizes without a safety signal; coordinated authorship
//    of the divergence trips MFCI instead. (Catalog §5.)
// ---------------------------------------------------------------------------
describe('ensemble: manufactured divergence cannot be weaponized via SCOI alone', () => {
  const I2: Matrix = [
    [1, 0],
    [0, 1],
  ];
  it('opposed lenses raise SCOI obstruction but stay non-weaponized with no safety signal', () => {
    const collapsed: SheafStructure = {
      lenses: [
        { lensId: 'home1', interpretation: [1, 0] },
        { lensId: 'home2', interpretation: [1, 0] },
        { lensId: 'opposed', interpretation: [-1, 0] },
      ],
      overlaps: [
        { lensA: 'home1', lensB: 'home2', rhoA: I2, rhoB: I2 },
        { lensA: 'home2', lensB: 'opposed', rhoA: I2, rhoB: I2 },
      ],
    };
    const energy = scoiEnergy(collapsed);
    expect(energy.scoi).toBeGreaterThan(0);
    // Divergence alone is descriptive — never weaponized without a safety signal.
    expect(contextStateForScore(energy.scoi, false)).not.toBe('weaponized');
    // The same energy WITH a safety signal is what can escalate.
    expect(contextStateForScore(energy.scoi, true)).toBe('weaponized');
  });

  it('coordinated authorship of the "divergence" is independently caught by MFCI', () => {
    // The sock-puppets manufacturing the divergence concentrate their actions —
    // MFCI flags the coordination even though SCOI refuses to weaponize.
    const coordinated = mfciTable([
      ...Array.from({ length: 13 }, () => ['g1', 't1', 'b1', 'reply', 'x']),
      ['g2', 't2', 'b2', 'reply', 'y'],
      ['g3', 't1', 'b3', 'reply', 'y'],
      ['g2', 't2', 'b1', 'reply', 'y'],
    ]);
    expect(fiberTest(coordinated, 'target_concentration', SAMPLER).pHat).toBeLessThan(0.1);
  });
});

// ---------------------------------------------------------------------------
// 3b. Threshold-hugging — knowing the PUBLIC threshold, the attacker tunes many
//     targets to sit a hair below the cliff to stay individually under-flagged;
//     the distributional meta-signal sees the cluster and routes them to the
//     exact MFCI fiber test (the scheduler wiring is proven in
//     invariants-threshold-hugging.test.ts). (Catalog §3.)
// ---------------------------------------------------------------------------
describe('ensemble: knowing the threshold is a liability (distributional hugging)', () => {
  const CFG = { band: 0.06, minPopulation: 12, excessThreshold: 2.5 };
  it('a population massed just under a known threshold is flagged; a diffuse one is not', () => {
    const threshold = 0.4; // e.g. the SCOI needs-context cliff
    // A diffuse population spread across the whole range is NOT flagged.
    const diffuse = Array.from({ length: 34 }, (_, i) => (i / 34) * threshold);
    expect(detectThresholdHugging(diffuse, threshold, CFG).detected).toBe(false);

    // The attacker keeps a diffuse background BELOW the band, then tunes 16
    // targets to sit in [0.34, 0.4) to dodge the per-item flag — the cluster
    // itself is the tell.
    const background = Array.from({ length: 18 }, (_, i) => (i / 18) * (threshold - CFG.band));
    const hugging = [
      ...background,
      ...Array.from({ length: 16 }, () => threshold - CFG.band * 0.4),
    ];
    expect(detectThresholdHugging(hugging, threshold, CFG).detected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Bias / fairness evasion — a ranker that advantages a protected attribute
//    is caught by CID (attribute-agnostic) and by GWEI (experience disparity).
//    (Catalog §7.)
// ---------------------------------------------------------------------------
describe('ensemble: attribute bias is caught by both CID and GWEI', () => {
  it('a locale-biased ranker has CID > 0 where the blind one is exactly 0', () => {
    const localeSwap: AttributePermutation = {
      id: 'locale:swap',
      attribute: 'locale',
      mapping: { en: 'es', es: 'en' },
    };
    const group = generateGroup([localeSwap]);
    const blind = counterfactualInvarianceDefect(
      () => 0.6,
      { topic: 'news' },
      { locale: 'en' },
      group,
    );
    expect(blind.cid).toBe(0);
    const biased = counterfactualInvarianceDefect(
      (_ctx, user) => (user['locale'] === 'en' ? 1 : 0),
      { topic: 'news' },
      { locale: 'en' },
      group,
    );
    expect(biased.cid).toBeGreaterThan(0);
  });

  it('the resulting experience disparity is independently caught by GWEI + the release gate', () => {
    const healthy = buildMetricMeasureSpace([
      gweiItem('a', [1, 0], 's1'),
      gweiItem('b', [0, 1], 's2'),
      gweiItem('c', [1, 1], 's3'),
      gweiItem('d', [-1, -1], 's4'),
    ]);
    // The disadvantaged cohort gets a collapsed experience (one source, no spread).
    const degraded = buildMetricMeasureSpace([
      gweiItem('p', [1, 0], 's1'),
      gweiItem('q', [1, 0], 's1'),
      gweiItem('r', [1, 0], 's1'),
      gweiItem('s', [1, 0], 's1'),
    ]);
    const gap = entropicGw(healthy, degraded, { epsilon: 0.02, outerIterations: 30 }).distance;
    expect(gap).toBeGreaterThan(0.1);
    const decision = evaluateReleaseGate([
      { cohortKey: 'protected', distance: gap, threshold: 0.05, protectedCohort: true },
    ]);
    expect(decision.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Path-steering — keeping the latent-frame holonomy near zero (benign
//    rotations) does not hide a compulsive re-entry loop from the narrow-loop
//    detector. (Catalog §6.)
// ---------------------------------------------------------------------------
describe('ensemble: low holonomy does not hide a compulsive re-entry loop', () => {
  function rotXY(theta: number): Matrix {
    return [
      [Math.cos(theta), -Math.sin(theta), 0],
      [Math.sin(theta), Math.cos(theta), 0],
      [0, 0, 1],
    ];
  }
  it('a self-cancelling holonomy loop (PHI ≈ 0) whose topic path re-enters is still flagged', () => {
    // The attacker keeps the preference frame's net rotation ≈ 0 (commuting legs).
    const benign = holonomy([rotXY(0.4), rotXY(0.5), rotXY(-0.9)]);
    expect(phiScore(benign).phi).toBeCloseTo(0, 6);
    // But the session re-enters one cluster repeatedly — the rabbit-hole signature.
    const t = (cluster: string, atMs: number) => ({ topicClusterId: cluster, atMs });
    const reentry = [
      t('nutrition', 0),
      t('panic', 30_000),
      t('nutrition', 60_000),
      t('cure', 90_000),
      t('nutrition', 120_000),
    ];
    const detection = detectNarrowLoop(reentry, 200_000);
    expect(detection.detected).toBe(true);
    expect(detection.topicClusterId).toBe('nutrition');
  });
});

// ---------------------------------------------------------------------------
// 6. Ensemble evasion — the facets are contradictory: tuning content to be
//    non-redundant (evade MERI) forfeits nothing for the coordination MFCI
//    sees, so no single evasion zeroes the ensemble. (Catalog §9.)
// ---------------------------------------------------------------------------
describe('ensemble: no single evasion zeroes the ensemble', () => {
  it('non-redundant content (evades MERI) still leaves the coordinated timing MFCI sees', () => {
    // The attacker authors 8 genuinely distinct items (MERI gives full exposure —
    // they "beat" MERI) ...
    const distinct = computeMeri(Array.from({ length: 8 }, (_, i) => meriCand(`d${i}`)));
    expect(distinct.meri).toBe(1);
    // ... but pushing them in a coordinated burst on one target is exactly what
    // MFCI's target concentration is built to catch.
    const burst = mfciTable([
      ...Array.from({ length: 14 }, () => ['g1', 't1', 'b1', 'reply', 'x']),
      ['g2', 't2', 'b2', 'reply', 'y'],
      ['g3', 't1', 'b3', 'reply', 'y'],
      ['g2', 't2', 'b1', 'reply', 'y'],
      ['g3', 't1', 'b2', 'reply', 'y'],
    ]);
    expect(fiberTest(burst, 'target_concentration', SAMPLER).pHat).toBeLessThan(0.1);
  });
});
