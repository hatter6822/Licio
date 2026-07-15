// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.1.1a-2 — the vocabulary drift gate: the code's cell vocabulary and
// crypto feature cells must EQUAL the canonical machine-readable enumeration
// in the ratified docs/policy/JURISDICTION_MATRIX.md (WS-A.2.1).  Divergence
// between the ratified policy artifact and the engine's closed vocabulary is
// a test failure, not a runtime surprise.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// Relative source import: `scripts/` is not a workspace package, so the
// workspace alias does not resolve here (the same posture as validate.ts's
// own relative doc reads).
import {
  ALL_DISABLED_CELLS,
  CRYPTO_FEATURE_CELLS,
  JURISDICTION_CELL_STATES,
  validatePolicy,
} from '../../../packages/shared/src/schemas/jurisdiction.js';

const MATRIX_PATH = resolve(import.meta.dirname, '../../../docs/policy/JURISDICTION_MATRIX.md');

function matrixEnumeration(): {
  cell_vocabulary: string[];
  crypto_feature_cells: string[];
} {
  const raw = readFileSync(MATRIX_PATH, 'utf-8');
  const fenced = raw.match(/```json\n([\s\S]*?)\n```/);
  if (fenced?.[1] === undefined) throw new Error('JURISDICTION_MATRIX.md JSON block missing');
  return JSON.parse(fenced[1]) as { cell_vocabulary: string[]; crypto_feature_cells: string[] };
}

describe('jurisdiction vocabulary — ratified-matrix drift gate (WS-N.1.1a-2)', () => {
  it('cell vocabulary equals the ratified closed vocabulary, in order', () => {
    expect([...JURISDICTION_CELL_STATES]).toEqual(matrixEnumeration().cell_vocabulary);
  });

  it('crypto feature cells equal the ratified crypto_feature_cells, in order', () => {
    expect([...CRYPTO_FEATURE_CELLS]).toEqual(matrixEnumeration().crypto_feature_cells);
  });

  it('the fail-closed default cell set covers exactly the ratified cells', () => {
    expect(Object.keys(ALL_DISABLED_CELLS).sort()).toEqual(
      [...matrixEnumeration().crypto_feature_cells].sort(),
    );
    for (const state of Object.values(ALL_DISABLED_CELLS)) expect(state).toBe('disabled');
  });

  it('validatePolicy enforces the ratified enable-requires-legal-approval invariant', () => {
    const base = {
      policy_id: '6f9619ff-8b86-4d01-b42d-00cf4fc964ff',
      country_or_region: 'EU',
      feature_flags: { ...ALL_DISABLED_CELLS, testnet_transactions: 'enabled' },
      asset_flags: {},
      age_gate_policy: {
        wallet_connection: { required_band: 'adult' },
        testnet_transactions: { required_band: 'adult' },
        production_payments: { required_band: 'adult' },
        treasury_operations: { required_band: 'adult' },
        governance: { required_band: 'adult' },
      },
      kyc_policy: {},
      disclosure_refs: [],
      legal_approval_ref: null,
      effective_at: '2026-07-01T00:00:00.000Z',
    };
    const rejected = validatePolicy(base);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.problems[0]?.path).toBe('feature_flags.testnet_transactions');
    }
    const approved = validatePolicy({ ...base, legal_approval_ref: 'LEGAL-2026-001' });
    expect(approved.ok).toBe(true);
  });
});
