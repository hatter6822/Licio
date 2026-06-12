// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H.1.2d-2 — version-controlled regression baselines.
//
// The seed-dependent baselines below were produced by running the reference
// implementations at REGRESSION_SEED and are EXACTLY reproducible (every
// stochastic procedure is seeded). Changing any value is a reviewed code
// change: the regression suite failing against these numbers is the drift
// signal, and an intentional algorithm change must update the baseline in
// the same PR with the rationale in review.

export const REGRESSION_SEED = 20260611;

export interface RegressionBaselines {
  /** MERI standard dataset: analytic 5/6. */
  meriStandard: number;
  /** MFCI conditional p̂ on the planted-concentration table at the seed. */
  mfciConcentratedPHat: number;
  /** MFCI conditional p̂ on the organic control table at the seed. */
  mfciOrganicPHat: number;
  /** Numerical-zero tolerance for entropic GW on identical spaces. */
  gweiIdenticalTolerance: number;
  /** Entropic-GW upper bound on the divergent pair at the seed. */
  gweiDivergent: number;
  /** Braid churn-entropy estimate (homological lower bound) at the seed. */
  braidChurnEntropy: number;
}

export const REGRESSION_BASELINES: RegressionBaselines = {
  meriStandard: 5 / 6,
  mfciConcentratedPHat: 0.0012484394506866417,
  mfciOrganicPHat: 1,
  gweiIdenticalTolerance: 0.05,
  gweiDivergent: 0.9179303869680481,
  // log(2 + √3) — the analytic entropy of the σ₁³σ₂² churn fixture.
  braidChurnEntropy: 1.316957897186987,
};
