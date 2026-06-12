// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PHI v1 pair-specific transports (WS-H.6.2a/b): the flat-connection
// theorem made executable. The old per-topic-frame family A_xy = F_y F_xᵀ
// telescopes to the identity around EVERY closed loop (proven here), while
// the Kabsch cross-Gram estimator does not — identical structures and
// backtracking walks stay exactly trivial (the geometry demands it), and
// generic three-topic cycles pick up genuine curvature. Plus the SVD /
// Kabsch / projection / sign-fix kernels the estimator runs on.
import { describe, expect, it } from 'vitest';
import {
  determinant,
  frobeniusNorm,
  identity,
  isOrthogonal,
  kabschRotation,
  type Matrix,
  matMul,
  matSub,
  matVec,
  randomOrthogonal,
  randomProjectionMatrix,
  signFixRows,
  svdSmall,
  transpose,
} from '../math/linalg.js';
import { mulberry32 } from '../math/rng.js';
import {
  buildTopicStructure,
  holonomy,
  holonomyCycleFromWalk,
  loopHolonomy,
  PHI_PREFERENCE_DIM,
  PHI_SHARED_DIM,
  pairTransport,
  phiScore,
  reduceWalk,
  type TopicStructure,
  transportBetween,
} from '../phi/index.js';

const D = PHI_SHARED_DIM;

/** Deterministic full-rank sample cloud in R^D, shaped by a seed. */
function sampleCloud(seed: number, count = 24): number[][] {
  const rng = mulberry32(seed);
  // A seeded anisotropic stretch makes each topic's second moment distinct.
  const scales = Array.from({ length: D }, () => 0.25 + rng() * 2);
  return Array.from({ length: count }, () =>
    Array.from({ length: D }, (_, j) => (rng() * 2 - 1) * (scales[j] ?? 1)),
  );
}

function structureFor(seed: number, id: string): TopicStructure {
  const s = buildTopicStructure(id, sampleCloud(seed));
  if (!s) throw new Error(`fixture structure ${id} unexpectedly degenerate`);
  return s;
}

describe('svdSmall and kabschRotation kernels', () => {
  it('reconstructs a full-rank matrix as U Σ Vᵀ with orthonormal factors', () => {
    const rng = mulberry32(42);
    const m: Matrix = Array.from({ length: 4 }, () =>
      Array.from({ length: 4 }, () => rng() * 2 - 1),
    );
    const { u, sigma, v } = svdSmall(m);
    expect(sigma).toHaveLength(4);
    for (let k = 1; k < sigma.length; k += 1) {
      expect(sigma[k] ?? 0).toBeLessThanOrEqual((sigma[k - 1] ?? 0) + 1e-12);
    }
    // U, V have orthonormal columns (so Uᵀ U = I as row-major products).
    expect(isOrthogonal(transpose(u))).toBe(true);
    expect(isOrthogonal(transpose(v))).toBe(true);
    // M = U Σ Vᵀ.
    const sigmaMat = sigma.map((s, i) =>
      Array.from({ length: sigma.length }, (_, j) => (i === j ? s : 0)),
    );
    const rebuilt = matMul(matMul(u, sigmaMat), transpose(v));
    expect(frobeniusNorm(matSub(rebuilt, m))).toBeLessThan(1e-8);
  });

  it('a diagonal matrix yields its absolute entries as singular values', () => {
    const { sigma } = svdSmall([
      [3, 0],
      [0, -2],
    ]);
    expect(sigma[0]).toBeCloseTo(3, 10);
    expect(sigma[1]).toBeCloseTo(2, 10);
  });

  it('rank deficiency surfaces as a (near-)zero trailing singular value', () => {
    const { sigma } = svdSmall([
      [1, 2],
      [2, 4],
    ]);
    expect(sigma[1] ?? 1).toBeLessThan(1e-8);
  });

  it('kabsch recovers a rotation from rotation·PSD products exactly', () => {
    const rng = mulberry32(7);
    const r = randomOrthogonal(4, rng);
    const rot = determinant(r) > 0 ? r : r.map((row, i) => (i === 0 ? row.map((x) => -x) : row));
    // P symmetric positive definite: AᵀA + I.
    const a: Matrix = Array.from({ length: 4 }, () =>
      Array.from({ length: 4 }, () => rng() * 2 - 1),
    );
    const p = matMul(transpose(a), a).map((row, i) => row.map((x, j) => (i === j ? x + 1 : x)));
    const m = matMul(rot, p); // polar decomposition M = R·P
    const fit = kabschRotation(m);
    expect(fit.degenerate).toBe(false);
    expect(isOrthogonal(fit.rotation)).toBe(true);
    expect(determinant(fit.rotation)).toBeGreaterThan(0);
    expect(frobeniusNorm(matSub(fit.rotation, rot))).toBeLessThan(1e-6);
  });

  it('keeps det = +1 even when the cross matrix is orientation-reversing', () => {
    const reflection: Matrix = [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ];
    const fit = kabschRotation(reflection);
    expect(isOrthogonal(fit.rotation)).toBe(true);
    expect(determinant(fit.rotation)).toBeCloseTo(1, 8);
  });

  it('flags rank-deficient cross matrices as degenerate', () => {
    const fit = kabschRotation([
      [1, 0],
      [0, 0],
    ]);
    expect(fit.degenerate).toBe(true);
    expect(() => kabschRotation([[1, 0]])).toThrow(/square/);
  });
});

describe('randomProjectionMatrix and signFixRows', () => {
  it('is deterministic per seed with the documented variance scale', () => {
    const a = randomProjectionMatrix(99, 8, 16);
    const b = randomProjectionMatrix(99, 8, 16);
    const c = randomProjectionMatrix(100, 8, 16);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).toHaveLength(8);
    expect(a[0]).toHaveLength(16);
    const bound = Math.sqrt(3) / Math.sqrt(8);
    for (const row of a) for (const x of row) expect(Math.abs(x)).toBeLessThanOrEqual(bound);
    // E‖Rx‖² = ‖x‖²: empirical mean over the columns of R applied to e_j.
    let meanSq = 0;
    for (let j = 0; j < 16; j += 1) {
      const col = a.map((row) => row[j] ?? 0);
      meanSq += col.reduce((acc, x) => acc + x * x, 0) / 16;
    }
    expect(meanSq).toBeGreaterThan(0.5);
    expect(meanSq).toBeLessThan(1.5);
  });

  it('sign-fixes rows so the largest-magnitude entry is positive', () => {
    const fixed = signFixRows([
      [0.1, -0.9, 0.2],
      [0.5, 0.1, 0.0],
      [0, 0, 0],
    ]);
    expect(fixed[0]).toEqual([-0.1, 0.9, -0.2]);
    expect(fixed[1]).toEqual([0.5, 0.1, 0.0]);
    expect(fixed[2]).toEqual([0, 0, 0]);
    expect(signFixRows(fixed)).toEqual(fixed); // idempotent
  });
});

describe('buildTopicStructure (WS-H.6.2a)', () => {
  it('builds a d×n √λ-weighted structure from a full-rank cloud', () => {
    const s = structureFor(1, 'topic-a');
    expect(s.t).toHaveLength(D);
    expect(s.t[0]).toHaveLength(PHI_PREFERENCE_DIM);
    expect(s.sampleCount).toBe(24);
    expect(s.resolution).toBeGreaterThan(0);
    expect(s.resolution).toBeLessThanOrEqual(1);
    // Columns are orthogonal with norms² = the leading eigenvalues (so the
    // self cross-Gram TᵀT is diagonal — the identity-transport anchor).
    const gram = matMul(transpose(s.t), s.t);
    for (let i = 0; i < PHI_PREFERENCE_DIM; i += 1) {
      for (let j = 0; j < PHI_PREFERENCE_DIM; j += 1) {
        if (i !== j) expect(Math.abs(gram[i]?.[j] ?? 1)).toBeLessThan(1e-8);
      }
      expect(gram[i]?.[i] ?? 0).toBeGreaterThan(0);
    }
  });

  it('returns null on too few samples, low dimension, or unresolved spectrum', () => {
    expect(buildTopicStructure('few', sampleCloud(2).slice(0, 3))).toBeNull();
    const lowDim = Array.from({ length: 10 }, (_, i) => [i, 1, 0]);
    expect(buildTopicStructure('low-dim', lowDim)).toBeNull();
    // Rank-1 cloud: every point on one line — λ₂…λ₄ vanish.
    const rng = mulberry32(5);
    const direction = Array.from({ length: D }, () => rng() * 2 - 1);
    const rank1 = Array.from({ length: 20 }, () => {
      const scale = rng() * 2 - 1;
      return direction.map((x) => x * scale);
    });
    expect(buildTopicStructure('rank-1', rank1)).toBeNull();
    expect(buildTopicStructure('empty', [])).toBeNull();
  });
});

describe('pairTransport and the flat-connection theorem (WS-H.6.2b)', () => {
  const sa = structureFor(11, 'a');
  const sb = structureFor(22, 'b');
  const sc = structureFor(33, 'c');

  it('identical structures transport by the exact identity', () => {
    const t = pairTransport(sa, sa);
    expect(t).not.toBeNull();
    if (!t) return;
    expect(frobeniusNorm(matSub(t.rotation, identity(PHI_PREFERENCE_DIM)))).toBeLessThan(1e-8);
  });

  it('transports are special-orthogonal and symmetric: A_ba = A_abᵀ', () => {
    const ab = pairTransport(sa, sb);
    const ba = pairTransport(sb, sa);
    expect(ab).not.toBeNull();
    expect(ba).not.toBeNull();
    if (!ab || !ba) return;
    expect(isOrthogonal(ab.rotation)).toBe(true);
    expect(determinant(ab.rotation)).toBeCloseTo(1, 8);
    expect(frobeniusNorm(matSub(ba.rotation, transpose(ab.rotation)))).toBeLessThan(1e-8);
  });

  it('orthogonal structures (zero cross-Gram) are degenerate — no transport', () => {
    // Topic clouds in complementary coordinate subspaces of R^8.
    const rng = mulberry32(17);
    const low = Array.from({ length: 20 }, () =>
      Array.from({ length: D }, (_, j) => (j < 4 ? rng() * 2 - 1 : 0)),
    );
    const high = Array.from({ length: 20 }, () =>
      Array.from({ length: D }, (_, j) => (j >= 4 ? rng() * 2 - 1 : 0)),
    );
    const sLow = buildTopicStructure('low', low);
    const sHigh = buildTopicStructure('high', high);
    expect(sLow).not.toBeNull();
    expect(sHigh).not.toBeNull();
    if (!sLow || !sHigh) return;
    expect(pairTransport(sLow, sHigh)).toBeNull();
  });

  it('THE THEOREM: per-topic frames telescope to I around every loop; pair transports do not', () => {
    // Old family — any global frame assignment F. Around a → b → c → a the
    // product is F_a F_cᵀ · F_c F_bᵀ · F_b F_aᵀ = I identically.
    const rng = mulberry32(101);
    const frames = [randomOrthogonal(4, rng), randomOrthogonal(4, rng), randomOrthogonal(4, rng)];
    const fa = frames[0] as Matrix;
    const fb = frames[1] as Matrix;
    const fc = frames[2] as Matrix;
    const telescoped = holonomy([
      transportBetween(fa, fb),
      transportBetween(fb, fc),
      transportBetween(fc, fa),
    ]);
    expect(frobeniusNorm(matSub(telescoped, identity(4)))).toBeLessThan(1e-8);

    // New family — generic distinct structures pick up genuine curvature.
    const structures = new Map([
      ['a', sa],
      ['b', sb],
      ['c', sc],
    ]);
    const loop = loopHolonomy(structures, ['a', 'b', 'c', 'a']);
    expect(loop).not.toBeNull();
    if (!loop) return;
    expect(isOrthogonal(loop.h)).toBe(true);
    expect(determinant(loop.h)).toBeCloseTo(1, 8);
    expect(loop.transportsUsed).toBe(3);
    expect(frobeniusNorm(matSub(loop.h, identity(PHI_PREFERENCE_DIM)))).toBeGreaterThan(0.01);
    const score = phiScore(loop.h);
    expect(score.phi).toBeGreaterThan(0.01);
  });

  it('two-topic out-and-back loops are exactly trivial (symmetric connection)', () => {
    const structures = new Map([
      ['a', sa],
      ['b', sb],
      ['c', sc],
    ]);
    const backAndForth = loopHolonomy(structures, ['a', 'b', 'a']);
    expect(backAndForth).not.toBeNull();
    if (!backAndForth) return;
    expect(frobeniusNorm(matSub(backAndForth.h, identity(PHI_PREFERENCE_DIM)))).toBeLessThan(1e-8);
    // Star-shaped revisit walks (the v0 detector's loopPath shape) bound no
    // area: their holonomy is trivial by geometry.
    const star = loopHolonomy(structures, ['a', 'b', 'a', 'c', 'a']);
    expect(star).not.toBeNull();
    if (!star) return;
    expect(frobeniusNorm(matSub(star.h, identity(PHI_PREFERENCE_DIM)))).toBeLessThan(1e-8);
  });

  it('holonomy is base-point covariant: conjugate, with equal PHI score', () => {
    const structures = new Map([
      ['a', sa],
      ['b', sb],
      ['c', sc],
    ]);
    const fromA = loopHolonomy(structures, ['a', 'b', 'c', 'a']);
    const fromB = loopHolonomy(structures, ['b', 'c', 'a', 'b']);
    expect(fromA).not.toBeNull();
    expect(fromB).not.toBeNull();
    if (!fromA || !fromB) return;
    expect(phiScore(fromA.h).phi).toBeCloseTo(phiScore(fromB.h).phi, 8);
  });

  it('returns null on missing structures, degenerate legs, and trivial paths', () => {
    const structures = new Map([
      ['a', sa],
      ['b', sb],
    ]);
    expect(loopHolonomy(structures, ['a', 'missing', 'a'])).toBeNull();
    expect(loopHolonomy(structures, ['a'])).toBeNull();
    expect(loopHolonomy(new Map(), ['a', 'b', 'a'])).toBeNull();
  });
});

describe('walk reduction (holonomy cycle extraction)', () => {
  it('cancels immediate and nested backtracks', () => {
    expect(reduceWalk(['a', 'b', 'a', 'c', 'a'])).toEqual(['a']);
    expect(reduceWalk(['a', 'b', 'c', 'b', 'a'])).toEqual(['a']);
    expect(reduceWalk(['a', 'b', 'a', 'b', 'a'])).toEqual(['a']);
    expect(reduceWalk(['a', 'a', 'b', 'b'])).toEqual(['a', 'b']);
    expect(reduceWalk([])).toEqual([]);
  });

  it('preserves genuine cycles', () => {
    expect(reduceWalk(['a', 'b', 'c', 'a'])).toEqual(['a', 'b', 'c', 'a']);
    // An excursion b → c → b inside a real cycle cancels; the backbone stays.
    expect(reduceWalk(['a', 'b', 'c', 'b', 'd', 'a'])).toEqual(['a', 'b', 'd', 'a']);
  });

  it('reduction is holonomy-invariant: raw walk and backbone compose equally', () => {
    const structures = new Map([
      ['a', structureFor(11, 'a')],
      ['b', structureFor(22, 'b')],
      ['c', structureFor(33, 'c')],
      ['d', structureFor(44, 'd')],
    ]);
    const raw = ['a', 'b', 'c', 'b', 'd', 'a'];
    const backbone = reduceWalk(raw);
    const hRaw = loopHolonomy(structures, raw);
    const hBackbone = loopHolonomy(structures, backbone);
    expect(hRaw).not.toBeNull();
    expect(hBackbone).not.toBeNull();
    if (!hRaw || !hBackbone) return;
    expect(frobeniusNorm(matSub(hRaw.h, hBackbone.h))).toBeLessThan(1e-8);
  });

  it('holonomyCycleFromWalk demands a closed ≥3-distinct-topic cycle', () => {
    expect(holonomyCycleFromWalk(['a', 'b', 'a', 'c', 'a'])).toBeNull(); // star → point
    expect(holonomyCycleFromWalk(['a', 'b', 'c'])).toBeNull(); // open
    expect(holonomyCycleFromWalk(['a', 'b', 'c', 'a'])).toEqual(['a', 'b', 'c', 'a']);
    expect(holonomyCycleFromWalk(['a', 'b', 'c', 'b', 'd', 'a'])).toEqual(['a', 'b', 'd', 'a']);
    expect(holonomyCycleFromWalk(['a', 'b', 'c', 'a'], 4)).toBeNull(); // stricter floor
  });
});

describe('projection → structure pipeline (end to end)', () => {
  it('projected high-dimensional embeddings still produce working transports', () => {
    const projection = randomProjectionMatrix(123, D, 32);
    const project = (e: readonly number[]): number[] => matVec(projection, e);
    const rng = mulberry32(55);
    const cloudIn32 = (offset: number): number[][] =>
      Array.from({ length: 24 }, () =>
        Array.from({ length: 32 }, (_, j) => (rng() * 2 - 1) * (1 + ((j + offset) % 5))),
      );
    const sa = buildTopicStructure('a', cloudIn32(0).map(project));
    const sb = buildTopicStructure('b', cloudIn32(1).map(project));
    const sc = buildTopicStructure('c', cloudIn32(2).map(project));
    expect(sa).not.toBeNull();
    expect(sb).not.toBeNull();
    expect(sc).not.toBeNull();
    if (!sa || !sb || !sc) return;
    const loop = loopHolonomy(
      new Map([
        ['a', sa],
        ['b', sb],
        ['c', sc],
      ]),
      ['a', 'b', 'c', 'a'],
    );
    expect(loop).not.toBeNull();
    if (!loop) return;
    const score = phiScore(loop.h);
    expect(Number.isFinite(score.phi)).toBe(true);
  });
});
