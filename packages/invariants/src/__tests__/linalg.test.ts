// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  conjugateGradient,
  determinant,
  frobeniusNorm,
  gramSchmidt,
  identity,
  isOrthogonal,
  jacobiEigSym,
  matMul,
  matSub,
  matVec,
  operatorNorm,
  randomOrthogonal,
  spectralRadius,
  transpose,
} from '../math/linalg.js';
import { mulberry32, seedFromString } from '../math/rng.js';
import { float, forAll, int } from './prop.js';

describe('linalg: basic operations', () => {
  it('matMul matches a hand-computed product', () => {
    const a = [
      [1, 2],
      [3, 4],
    ];
    const b = [
      [5, 6],
      [7, 8],
    ];
    expect(matMul(a, b)).toEqual([
      [19, 22],
      [43, 50],
    ]);
  });

  it('matMul rejects mismatched shapes', () => {
    expect(() => matMul([[1, 2]], [[1, 2]])).toThrow(/shape mismatch/);
  });

  it('transpose round-trips', () => {
    const a = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    expect(transpose(transpose(a))).toEqual(a);
  });

  it('matVec applies rows', () => {
    expect(
      matVec(
        [
          [1, 0],
          [0, 2],
        ],
        [3, 4],
      ),
    ).toEqual([3, 8]);
  });
});

describe('linalg: determinant', () => {
  it('computes known determinants exactly', () => {
    expect(determinant([[5]])).toBe(5);
    expect(
      determinant([
        [1, 2],
        [3, 4],
      ]),
    ).toBeCloseTo(-2, 12);
    expect(
      determinant([
        [0, 1],
        [1, 0],
      ]),
    ).toBeCloseTo(-1, 12);
    expect(determinant(identity(4))).toBeCloseTo(1, 12);
  });

  it('is multiplicative on random matrices (property)', () => {
    forAll(
      11,
      50,
      (rng) => {
        const n = int(rng, 1, 4);
        const make = (): number[][] =>
          Array.from({ length: n }, () => Array.from({ length: n }, () => float(rng, -2, 2)));
        return { a: make(), b: make() };
      },
      ({ a, b }) => {
        const lhs = determinant(matMul(a, b));
        const rhs = determinant(a) * determinant(b);
        return (
          Math.abs(lhs - rhs) <= 1e-8 * Math.max(1, Math.abs(rhs)) ||
          `det mismatch ${lhs} vs ${rhs}`
        );
      },
    );
  });
});

describe('linalg: Gram-Schmidt and orthogonality', () => {
  it('produces orthonormal rows', () => {
    const q = gramSchmidt([
      [1, 1, 0],
      [1, 0, 1],
      [0, 1, 1],
    ]);
    expect(q).not.toBeNull();
    if (q) expect(isOrthogonal(q)).toBe(true);
  });

  it('returns null on rank deficiency', () => {
    expect(
      gramSchmidt([
        [1, 2],
        [2, 4],
      ]),
    ).toBeNull();
  });

  it('randomOrthogonal is orthogonal for several seeds', () => {
    for (const seed of [1, 2, 3]) {
      const q = randomOrthogonal(4, mulberry32(seed));
      expect(isOrthogonal(q, 1e-8)).toBe(true);
    }
  });
});

describe('linalg: Jacobi eigendecomposition', () => {
  it('diagonalizes a known symmetric matrix', () => {
    // Eigenvalues of [[2,1],[1,2]] are 3 and 1.
    const { values } = jacobiEigSym([
      [2, 1],
      [1, 2],
    ]);
    expect(values[0]).toBeCloseTo(3, 10);
    expect(values[1]).toBeCloseTo(1, 10);
  });

  it('satisfies S v = λ v for every returned pair (property)', () => {
    forAll(
      13,
      40,
      (rng) => {
        const n = int(rng, 2, 5);
        const raw = Array.from({ length: n }, () =>
          Array.from({ length: n }, () => float(rng, -3, 3)),
        );
        // Symmetrize.
        return raw.map((row, i) => row.map((v, j) => (v + (raw[j]?.[i] ?? 0)) / 2));
      },
      (s) => {
        const { values, vectors } = jacobiEigSym(s);
        for (let k = 0; k < values.length; k += 1) {
          const v = vectors[k] ?? [];
          const sv = matVec(s, v);
          for (let i = 0; i < v.length; i += 1) {
            const expected = (values[k] ?? 0) * (v[i] ?? 0);
            if (Math.abs((sv[i] ?? 0) - expected) > 1e-7) {
              return `eigenpair ${k} violated: ${sv[i]} vs ${expected}`;
            }
          }
        }
        // Eigenvalues descending.
        for (let k = 1; k < values.length; k += 1) {
          if ((values[k] ?? 0) > (values[k - 1] ?? 0) + 1e-12) return 'values not sorted';
        }
        return true;
      },
    );
  });

  it('rejects asymmetric input', () => {
    expect(() =>
      jacobiEigSym([
        [1, 2],
        [0, 1],
      ]),
    ).toThrow(/symmetric/);
  });

  it('operatorNorm matches the largest singular value', () => {
    // diag(3, 1) has operator norm 3 under any orthogonal conjugation.
    expect(
      operatorNorm([
        [3, 0],
        [0, 1],
      ]),
    ).toBeCloseTo(3, 10);
    expect(operatorNorm([[0, 0]])).toBe(0);
  });
});

describe('linalg: spectral radius (Gelfand)', () => {
  it('matches known spectral radii', () => {
    expect(spectralRadius([[2]])).toBeCloseTo(2, 6);
    expect(
      spectralRadius([
        [0, 1],
        [1, 0],
      ]),
    ).toBeCloseTo(1, 6);
    // [[2,1],[1,1]] has ρ = (3+√5)/2 (the golden-ratio square).
    expect(
      spectralRadius([
        [2, 1],
        [1, 1],
      ]),
    ).toBeCloseTo((3 + Math.sqrt(5)) / 2, 6);
  });

  it('returns 0 for nilpotent matrices', () => {
    expect(
      spectralRadius([
        [0, 1],
        [0, 0],
      ]),
    ).toBe(0);
  });
});

describe('linalg: conjugate gradient', () => {
  it('solves an SPD system to high accuracy', () => {
    const a = [
      [4, 1],
      [1, 3],
    ];
    const x = conjugateGradient((v) => matVec(a, v), [1, 2]);
    const residual = matSub([matVec(a, x)], [[1, 2]]);
    expect(frobeniusNorm(residual)).toBeLessThan(1e-9);
  });

  it('returns the zero vector for a zero right-hand side', () => {
    expect(conjugateGradient((v) => v.map((x) => 2 * x), [0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe('rng: seedFromString', () => {
  it('is deterministic and spreads distinct inputs', () => {
    expect(seedFromString('MFCI:a:b')).toBe(seedFromString('MFCI:a:b'));
    expect(seedFromString('MFCI:a:b')).not.toBe(seedFromString('MFCI:a:c'));
  });
});
