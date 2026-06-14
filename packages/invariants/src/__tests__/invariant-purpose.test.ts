// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Invariant PURPOSE suite: each invariant exists to answer a specific platform
// question (SPEC §7–§12). The per-module suites prove the mathematics is
// correct; THIS suite proves each invariant actually fulfils its STATED PURPOSE
// — the headline SPEC scenario and the adversarial cases a skeptic would use to
// argue it does not measure what it claims. A failure here means an invariant is
// mathematically sound but does not do its job.
import { describe, expect, it } from 'vitest';
import {
  type AttributePermutation,
  counterfactualInvarianceDefect,
  generateGroup,
} from '../cid/index.js';
import {
  buildMetricMeasureSpace,
  entropicGw,
  evaluateReleaseGate,
  type GweiItemFeatures,
  type MetricMeasureSpace,
} from '../gwei/index.js';
import type { Matrix } from '../math/linalg.js';
import { computeMeri, type MeriCandidateInput } from '../meri/index.js';
import { type AxisDef, buildSparseTable, fiberTest, fiberTestMulti } from '../mfci/index.js';
import { detectNarrowLoop, holonomy, phiScore } from '../phi/index.js';
import { contextStateForScore, type SheafStructure, scoiEnergy } from '../scoi/index.js';

// ---------------------------------------------------------------------------
// MERI — "nonredundant exposure, not raw count" (SPEC §7.1)
//
// "A user should not see ten versions of the same claim from near-identical
// sources and have that count as ten useful exposures."
// ---------------------------------------------------------------------------

const FULL_INPUTS = {
  canonicalUrl: true,
  claimExtraction: true,
  sourceLineage: true,
  evidence: true,
  embedding: true,
} as const;
function cand(id: string, extra: Partial<MeriCandidateInput> = {}): MeriCandidateInput {
  return { id, urlGroupId: `url-${id}`, inputsAvailable: { ...FULL_INPUTS }, ...extra };
}

describe('MERI fulfils its purpose: redundancy does not inflate exposure (§7.1)', () => {
  it('ten near-identical sources count as roughly ONE independent exposure', () => {
    const nearDuplicates = Array.from({ length: 10 }, (_, i) =>
      cand(`n${i}`, { nearDuplicateGroupId: 'same-claim-flood' }),
    );
    const independent = Array.from({ length: 10 }, (_, i) => cand(`u${i}`));

    const flood = computeMeri(nearDuplicates);
    const diverse = computeMeri(independent);

    // Ten genuinely independent exposures count as ten (MERI = 1).
    expect(diverse.meri).toBe(1);
    expect(diverse.selectedIds.length).toBe(10);
    // Ten near-identical ones collapse to a single useful exposure.
    expect(flood.selectedIds.length).toBe(1);
    expect(flood.meri).toBeCloseTo(0.1, 12);
    // The redundancy is what suppresses it — diverse ≫ redundant.
    expect(diverse.meri).toBeGreaterThan(flood.meri * 5);
  });

  it('redundant copies earn ~zero marginal exposure gain (not a fresh signal each)', () => {
    const flood = computeMeri(
      Array.from({ length: 6 }, (_, i) => cand(`d${i}`, { nearDuplicateGroupId: 'g' })),
    );
    const gains = Object.values(flood.marginalGains);
    const significant = gains.filter((g) => g > 0.4);
    // At most the FIRST exposure of the cluster is a meaningful new signal.
    expect(significant.length).toBeLessThanOrEqual(1);
    // The later copies are duplicate context, not independent sources.
    expect(flood.labels['d5']).toBe('duplicate_context');
  });

  it('adversarial: a paraphrase flood (same claim + lineage, different URLs) stays bounded', () => {
    // Distinct exact URLs, but a shared claim AND a shared source lineage — a
    // classic astroturf pattern. Independence is bounded by the lineage class.
    const flood = computeMeri(
      Array.from({ length: 8 }, (_, i) =>
        cand(`p${i}`, { sourceLineageGroupId: 'one-owner', claimGroupId: 'one-claim' }),
      ),
    );
    // Nowhere near 8 independent exposures despite 8 distinct URLs.
    expect(flood.selectedIds.length).toBeLessThanOrEqual(2);
    expect(flood.meri).toBeLessThanOrEqual(0.3);
  });
});

// ---------------------------------------------------------------------------
// MFCI — "suspicious only after controlling for base rates" (SPEC §8.4)
//
// A large, genuinely active community is NOT flagged merely for being active;
// only activity that is disproportionate GIVEN the margins is coordination.
// ---------------------------------------------------------------------------

const MFCI_AXES: AxisDef[] = [
  { name: 'user_group', labels: ['g1', 'g2'] },
  { name: 'topic', labels: ['t1', 't2'] },
  { name: 'time_bucket', labels: ['b1', 'b2'] },
  { name: 'action_type', labels: ['report', 'reply'] },
  { name: 'target', labels: ['x', 'y'] },
];
const table = (rows: string[][]): ReturnType<typeof buildSparseTable> =>
  buildSparseTable(
    MFCI_AXES,
    rows.map((labels) => ({ labels })),
  );
const SAMPLER = { samples: 500, burnIn: 500, thinning: 2, seed: 42 } as const;

describe('MFCI fulfils its purpose: active ≠ suspicious (§8.4)', () => {
  it('an active community proportional to its base rates is NOT flagged; only disproportionate concentration is', () => {
    // 16 actions spread evenly across the grid — a big, normal active community.
    const organic = table([
      ['g1', 't1', 'b1', 'report', 'x'],
      ['g1', 't2', 'b2', 'reply', 'y'],
      ['g2', 't1', 'b2', 'report', 'y'],
      ['g2', 't2', 'b1', 'reply', 'x'],
      ['g1', 't1', 'b2', 'reply', 'x'],
      ['g2', 't2', 'b2', 'report', 'y'],
      ['g1', 't2', 'b1', 'report', 'x'],
      ['g2', 't1', 'b1', 'reply', 'y'],
      ['g1', 't1', 'b1', 'reply', 'y'],
      ['g2', 't2', 'b2', 'reply', 'x'],
      ['g1', 't2', 'b2', 'report', 'x'],
      ['g2', 't1', 'b1', 'report', 'y'],
      ['g1', 't1', 'b2', 'report', 'y'],
      ['g2', 't2', 'b1', 'report', 'x'],
      ['g1', 't2', 'b1', 'reply', 'y'],
      ['g2', 't1', 'b2', 'reply', 'x'],
    ]);
    // Same volume, but 12 actions piled onto ONE cell — disproportionate.
    const concentrated = table([
      ...Array.from({ length: 12 }, () => ['g1', 't1', 'b1', 'report', 'x']),
      ['g2', 't2', 'b2', 'reply', 'y'],
      ['g2', 't1', 'b2', 'reply', 'y'],
      ['g1', 't2', 'b2', 'reply', 'y'],
      ['g2', 't2', 'b1', 'reply', 'y'],
    ]);

    const organicResult = fiberTest(organic, 'target_concentration', SAMPLER);
    const concentratedResult = fiberTest(concentrated, 'target_concentration', SAMPLER);

    // The active-but-typical community sits in the bulk of its own fiber → high
    // p̂ → NOT flagged. Activity alone is never coordination.
    expect(organicResult.pHat).toBeGreaterThan(0.3);
    // The disproportionate concentration is extreme under the conditional → flagged.
    expect(concentratedResult.pHat).toBeLessThan(0.05);
    expect(concentratedResult.mfci).toBeGreaterThan(organicResult.mfci);
  });

  it("per-target attribution does not punish a coordinated burst's innocent neighbour", () => {
    // x is hit by a concentrated burst; y is ordinary background.
    const mixed = table([
      ...Array.from({ length: 14 }, () => ['g1', 't1', 'b1', 'report', 'x']),
      ['g2', 't2', 'b2', 'reply', 'y'],
      ['g2', 't1', 'b2', 'reply', 'y'],
      ['g1', 't2', 'b2', 'reply', 'y'],
      ['g2', 't2', 'b1', 'reply', 'y'],
    ]);
    const result = fiberTestMulti(mixed, 'target_concentration', ['x', 'y'], SAMPLER);
    const x = result.perTarget.find((t) => t.targetLabel === 'x');
    const y = result.perTarget.find((t) => t.targetLabel === 'y');
    expect(x).toBeDefined();
    expect(y).toBeDefined();
    // The attacked target is extreme relative to its OWN volume; the neighbour
    // is left near the null — it is not punished for sitting nearby.
    expect(x?.mfci).toBeGreaterThan(y?.mfci ?? Number.POSITIVE_INFINITY);
    expect(x?.pHat).toBeLessThan(0.1);
    expect(y?.pHat).toBeGreaterThan(0.4);
  });
});

// ---------------------------------------------------------------------------
// GWEI — "comparable experiences, not identical content" (SPEC §9.2)
//
// Two cohorts can see entirely different items yet have equivalent relational
// geometry; a structurally degraded cohort is caught and blocks a release.
// ---------------------------------------------------------------------------

describe('GWEI fulfils its purpose: experience parity without identical content (§9.2)', () => {
  it('two cohorts with DIFFERENT items but the same relational structure are ≈ equivalent', () => {
    const base = buildMetricMeasureSpace([
      itemFeat('a', [1, 0], 's1'),
      itemFeat('b', [0, 1], 's2'),
      itemFeat('c', [1, 1], 's3'),
      itemFeat('d', [-1, 0], 's4'),
    ]);
    // A cohort that saw entirely different stories/sources but whose pairwise
    // experience geometry is IDENTICAL (relabeled item ids only).
    const relabeled: MetricMeasureSpace = {
      itemIds: base.itemIds.map((id) => `other-${id}`),
      distances: base.distances,
      measure: base.measure,
    };
    const result = entropicGw(base, relabeled, {
      epsilon: 0.01,
      outerIterations: 30,
      sinkhornIterations: 400,
    });
    // Different content, same structure ⇒ a measure-preserving isometry ⇒ GW ≈ 0.
    expect(result.distance).toBeLessThan(0.05);
  });

  it('a structurally degraded cohort (collapsed diversity) is far, and the release gate blocks it', () => {
    const healthy = buildMetricMeasureSpace([
      itemFeat('a', [1, 0], 's1'),
      itemFeat('b', [0, 1], 's2'),
      itemFeat('c', [1, 1], 's3'),
      itemFeat('d', [-1, -1], 's4'),
    ]);
    // The protected cohort sees four near-identical items from one source — a
    // collapsed experience (no source/topic spread).
    const degraded = buildMetricMeasureSpace([
      itemFeat('p', [1, 0], 's1'),
      itemFeat('q', [1, 0], 's1'),
      itemFeat('r', [1, 0], 's1'),
      itemFeat('s', [1, 0], 's1'),
    ]);
    const gap = entropicGw(healthy, degraded, { epsilon: 0.02, outerIterations: 30 }).distance;
    expect(gap).toBeGreaterThan(0.1);

    // The release gate blocks a launch that degrades a PROTECTED cohort past
    // its threshold (the gap clearly exceeds a 0.05 parity bar).
    const decision = evaluateReleaseGate([
      { cohortKey: 'protected', distance: gap, threshold: 0.05, protectedCohort: true },
    ]);
    expect(decision.blocked).toBe(true);
    expect(decision.violations[0]?.cohortKey).toBe('protected');
  });
});

function itemFeat(id: string, semantic: number[], sourceKey: string): GweiItemFeatures {
  return { itemId: id, semantic, sourceKey, evidenceKeys: [], communityKeys: ['c'], weight: 1 };
}

// ---------------------------------------------------------------------------
// SCOI — "context collapse across communities" (SPEC §10.1)
//
// A post can mean one thing at home and something else when detached and shown
// elsewhere; SCOI rises exactly when a divergent community is introduced.
// ---------------------------------------------------------------------------

const I2: Matrix = [
  [1, 0],
  [0, 1],
];

describe('SCOI fulfils its purpose: detaching a post into a divergent community raises obstruction (§10.1)', () => {
  it('coherent at home (0); detaching into an opposed community makes it Needs-Context', () => {
    // Home community: two lenses that read the post the same way → glues, SCOI 0.
    const atHome: SheafStructure = {
      lenses: [
        { lensId: 'home1', interpretation: [1, 0] },
        { lensId: 'home2', interpretation: [1, 0] },
      ],
      overlaps: [{ lensA: 'home1', lensB: 'home2', rhoA: I2, rhoB: I2 }],
    };
    expect(scoiEnergy(atHome).scoi).toBe(0);
    // No safety signal — interpretation divergence is never "weaponized" alone.
    expect(contextStateForScore(scoiEnergy(atHome).scoi, false)).toBe('coherent');

    // Now the SAME post is shown to a third community that reads it oppositely.
    const crossCommunity: SheafStructure = {
      lenses: [
        { lensId: 'home1', interpretation: [1, 0] },
        { lensId: 'home2', interpretation: [1, 0] },
        { lensId: 'elsewhere', interpretation: [-1, 0] },
      ],
      overlaps: [
        { lensA: 'home1', lensB: 'home2', rhoA: I2, rhoB: I2 },
        { lensA: 'home2', lensB: 'elsewhere', rhoA: I2, rhoB: I2 },
      ],
    };
    const collapsed = scoiEnergy(crossCommunity);
    expect(collapsed.scoi).toBeGreaterThan(0);
    // The divergence is localised to the cross-community overlap, not the home one.
    expect(collapsed.perOverlap[0]?.energy).toBe(0);
    expect(collapsed.perOverlap[1]?.energy).toBeGreaterThan(0);
    // A divergent reading, but NOT weaponized (no safety signal present).
    const state = contextStateForScore(collapsed.scoi, false);
    expect(['ambiguous', 'split', 'obstructed']).toContain(state);
  });
});

// ---------------------------------------------------------------------------
// PHI — "path-dependent steering" (SPEC §11.4)
//
// Two users can arrive at the same topic; PHI distinguishes a benign route
// (no net rotation of latent preference) from a steered loop (it rotates).
// ---------------------------------------------------------------------------

function rotXY(t: number): Matrix {
  return [
    [Math.cos(t), -Math.sin(t), 0],
    [Math.sin(t), Math.cos(t), 0],
    [0, 0, 1],
  ];
}
function rotYZ(t: number): Matrix {
  return [
    [1, 0, 0],
    [0, Math.cos(t), -Math.sin(t)],
    [0, Math.sin(t), Math.cos(t)],
  ];
}

describe('PHI fulfils its purpose: it distinguishes benign arrival from steered loops (§11.4)', () => {
  it('a flat (commuting, self-cancelling) loop has PHI = 0; a non-commuting loop is positive', () => {
    // Benign: every leg rotates in the same plane and the angles cancel on
    // return — the latent preference frame comes back unchanged.
    const benign = holonomy([rotXY(0.4), rotXY(0.5), rotXY(-0.9)]);
    expect(phiScore(benign).phi).toBeCloseTo(0, 8);

    // Steered: the legs rotate in DIFFERENT planes, so the closed loop leaves a
    // residual rotation (a non-trivial commutator) — path-dependent steering.
    const steered = holonomy([rotXY(0.8), rotYZ(0.8), rotXY(-0.8), rotYZ(-0.8)]);
    expect(phiScore(steered).phi).toBeGreaterThan(0.05);
  });

  it('a diverse session is not a rabbit hole, but a re-entrant loop is', () => {
    const t = (cluster: string, atMs: number) => ({ topicClusterId: cluster, atMs });
    // Sports → cooking → medical: arrives at "nutrition" via a broad path.
    const broad = [
      t('sports', 0),
      t('cooking', 60_000),
      t('medical', 120_000),
      t('nutrition', 180_000),
    ];
    expect(detectNarrowLoop(broad, 200_000).detected).toBe(false);
    // Repeatedly re-entering the same cluster: the rabbit-hole signature.
    const loop = [
      t('nutrition', 0),
      t('panic', 30_000),
      t('nutrition', 60_000),
      t('cure', 90_000),
      t('nutrition', 120_000),
    ];
    const detection = detectNarrowLoop(loop, 200_000);
    expect(detection.detected).toBe(true);
    expect(detection.topicClusterId).toBe('nutrition');
  });
});

// ---------------------------------------------------------------------------
// CID — "transformations that should not change ranking, do not" (SPEC §12.5)
//
// The defect must be attribute-agnostic: a locale swap is caught exactly as a
// gender swap is (the supporting suite only exercised gender).
// ---------------------------------------------------------------------------

describe('CID fulfils its purpose for any protected attribute, not just one (§12.5)', () => {
  const localeSwap: AttributePermutation = {
    id: 'locale:swap',
    attribute: 'locale',
    mapping: { en: 'es', es: 'en' },
  };

  it('a locale-blind ranker has CID = 0; a locale-biased one is caught', () => {
    const group = generateGroup([localeSwap]);
    const fair = counterfactualInvarianceDefect(
      () => 0.6,
      { topic: 'news' },
      { locale: 'en' },
      group,
    );
    expect(fair.cid).toBe(0);

    const biased = counterfactualInvarianceDefect(
      (_context, user) => (user['locale'] === 'en' ? 1 : 0),
      { topic: 'news' },
      { locale: 'en' },
      group,
    );
    expect(biased.cid).toBeCloseTo(0.5, 12);
  });
});
