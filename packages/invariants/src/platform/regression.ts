// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H.1.2d-2 — the regression harness and drift detection.
//
// The harness runs every invariant's reference computation over its
// deterministic synthetic datasets and compares the results to the
// version-controlled baselines in `baselines.ts`, with the per-invariant
// tolerances the build plan fixes (MERI 0.01, MFCI p̂ 0.05, GWEI within its
// reported stability interval, PHI 0.01, …). It runs in CI on every PR
// touching this package (it is part of the test suite) and the API
// scheduler re-runs it nightly against the production algorithm versions,
// emitting a drift report. Updating a baseline is a reviewed code change —
// never an automatic write.

import { REGRESSION_BASELINES, REGRESSION_SEED, type RegressionBaselines } from './baselines.js';
import {
  generateBraidDatasets,
  generateCidDatasets,
  generateGweiDataset,
  generateHodgeDatasets,
  generateMeriDataset,
  generateMfciDataset,
  generatePathsigDatasets,
  generatePhiDatasets,
  generateReebDatasets,
  generateScoiDatasets,
  generateTropicalDatasets,
  meriEdgeCases,
  referenceBraid,
  referenceCid,
  referenceGwei,
  referenceHodge,
  referenceMeri,
  referenceMfci,
  referencePathsig,
  referencePhi,
  referenceReeb,
  referenceScoi,
  referenceTropical,
} from './synthetic.js';

export interface RegressionCheck {
  invariant: string;
  dataset: string;
  metric: string;
  value: number;
  baseline: number;
  tolerance: number;
  deviation: number;
  pass: boolean;
}

export interface RegressionReport {
  checks: RegressionCheck[];
  pass: boolean;
  failures: RegressionCheck[];
}

function check(
  invariant: string,
  dataset: string,
  metric: string,
  value: number,
  baseline: number,
  tolerance: number,
): RegressionCheck {
  const deviation = Math.abs(value - baseline);
  return {
    invariant,
    dataset,
    metric,
    value,
    baseline,
    tolerance,
    deviation,
    pass: deviation <= tolerance,
  };
}

/** Run the full suite against a baseline set (defaults to the pinned one). */
export function runRegressionSuite(
  baselines: RegressionBaselines = REGRESSION_BASELINES,
): RegressionReport {
  const checks: RegressionCheck[] = [];

  // --- MERI (tolerance 0.01) ----------------------------------------------
  const meri = generateMeriDataset(REGRESSION_SEED);
  checks.push(check('MERI', meri.name, 'meri', referenceMeri(meri), baselines.meriStandard, 0.01));
  for (const edge of meriEdgeCases()) {
    checks.push(check('MERI', edge.name, 'meri', referenceMeri(edge), edge.expectedMeri, 1e-12));
  }

  // --- MFCI (p̂ tolerance 0.05; ordering is the analytic property) ---------
  const concentrated = referenceMfci(generateMfciDataset(REGRESSION_SEED, true));
  const organic = referenceMfci(generateMfciDataset(REGRESSION_SEED, false));
  checks.push(
    check(
      'MFCI',
      'mfci-concentrated',
      'p_hat',
      concentrated.pHat,
      baselines.mfciConcentratedPHat,
      0.05,
    ),
    check('MFCI', 'mfci-organic', 'p_hat', organic.pHat, baselines.mfciOrganicPHat, 0.05),
    check(
      'MFCI',
      'mfci-ordering',
      'concentrated_minus_organic_mfci',
      Math.sign(concentrated.mfci - organic.mfci),
      1,
      0,
    ),
  );

  // --- GWEI (identical ≈ 0; divergent within its stability interval) ------
  const identical = referenceGwei(generateGweiDataset(REGRESSION_SEED, true));
  const divergent = referenceGwei(generateGweiDataset(REGRESSION_SEED, false));
  checks.push(
    check('GWEI', 'gwei-identical', 'gw2', identical.gw2, 0, baselines.gweiIdenticalTolerance),
    check(
      'GWEI',
      'gwei-divergent',
      'gw2',
      divergent.gw2,
      baselines.gweiDivergent,
      // "within its reported CI": the stability spread bounds the drift.
      Math.max(0.05, divergent.ciHigh - divergent.ciLow),
    ),
  );

  // --- SCOI (tolerance 0.01; all analytic) ---------------------------------
  for (const dataset of generateScoiDatasets()) {
    checks.push(
      check('SCOI', dataset.name, 'scoi', referenceScoi(dataset), dataset.expectedScoi, 0.01),
    );
  }

  // --- PHI (tolerance 0.01; all analytic) ----------------------------------
  for (const dataset of generatePhiDatasets()) {
    const result = referencePhi(dataset);
    checks.push(check('PHI', dataset.name, 'phi', result.phi, dataset.expectedPhi, 0.01));
    checks.push(
      check(
        'PHI',
        dataset.name,
        'fallback',
        result.fallback ? 1 : 0,
        dataset.expectFallback ? 1 : 0,
        0,
      ),
    );
  }

  // --- Hodge (dominant component carries ≥ 99% of the energy) --------------
  for (const dataset of generateHodgeDatasets()) {
    const result = referenceHodge(dataset);
    const total =
      result.gradientMagnitude ** 2 + result.curlMagnitude ** 2 + result.harmonicMagnitude ** 2;
    const dominant =
      dataset.dominant === 'gradient'
        ? result.gradientMagnitude
        : dataset.dominant === 'curl'
          ? result.curlMagnitude
          : result.harmonicMagnitude;
    checks.push(
      check(
        'hodge_tension',
        dataset.name,
        'dominant_share',
        total > 0 ? dominant ** 2 / total : 0,
        1,
        0.01,
      ),
    );
  }

  // --- Tropical (detection booleans are exact) ------------------------------
  for (const dataset of generateTropicalDatasets(REGRESSION_SEED)) {
    checks.push(
      check(
        'tropical_cascade',
        dataset.name,
        'detected',
        referenceTropical(dataset).detected ? 1 : 0,
        dataset.expectedDetected ? 1 : 0,
        0,
      ),
    );
  }

  // --- Braid (crossings exact; churn entropy pinned within 0.01) -----------
  for (const dataset of generateBraidDatasets()) {
    const result = referenceBraid(dataset);
    checks.push(
      check(
        'braid_dynamics',
        dataset.name,
        'crossings',
        result.crossings,
        dataset.expectedCrossings,
        0,
      ),
    );
    if (dataset.name === 'braid-churn') {
      checks.push(
        check(
          'braid_dynamics',
          dataset.name,
          'entropy',
          result.entropy,
          baselines.braidChurnEntropy,
          0.01,
        ),
      );
    }
  }

  // --- Reeb (peak/merge counts exact) ---------------------------------------
  for (const dataset of generateReebDatasets()) {
    const result = referenceReeb(dataset);
    checks.push(
      check('reeb_landscape', dataset.name, 'peaks', result.peaks.length, dataset.expectedPeaks, 0),
      check(
        'reeb_landscape',
        dataset.name,
        'merges',
        result.merges.length,
        dataset.expectedMerges,
        0,
      ),
    );
  }

  // --- CID (analytic, exact) -------------------------------------------------
  for (const dataset of generateCidDatasets()) {
    checks.push(
      check(
        'counterfactual_defect',
        dataset.name,
        'cid',
        referenceCid(dataset).cid,
        dataset.expectedCid,
        1e-12,
      ),
    );
  }

  // --- Path signature (classification exact) --------------------------------
  for (const dataset of generatePathsigDatasets()) {
    checks.push(
      check(
        'path_signature_wellbeing',
        dataset.name,
        'classified_as_expected',
        referencePathsig(dataset).classification === dataset.expectedClass ? 1 : 0,
        1,
        0,
      ),
    );
  }

  const failures = checks.filter((c) => !c.pass);
  return { checks, pass: failures.length === 0, failures };
}
